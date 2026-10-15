"""Card processors behind one small interface.

Adding a processor means one class here and its name in _PROVIDERS; nothing
in the extension changes. The adapter turns the processor's webhook into
Events and the rest of billing never sees the processor's own field names.
"""
import base64
import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

import httpx
from fastapi import Request

from billing import config


@dataclass
class Event:
    # paid | renewed | failed | cancelled (access until period_end) | revoked (access ends now)
    kind: str
    provider_ref: str
    checkout_id: str = ""  # paid only: which "subscribe" click this payment answers
    email: str = ""
    period_end: datetime | None = None


class Provider(Protocol):
    name: str
    # Test payments: only admins may start a checkout, whatever the rollout mode says.
    test_only: bool
    # Whether /api/billing/webhook/<name> accepts calls for it.
    webhooks: bool

    def ready(self) -> bool:
        """Every credential this processor needs is set."""

    async def create_checkout(self, checkout_id: str, customer_ip: str | None) -> str:
        """The URL of the processor's hosted payment page for this checkout."""

    async def parse_webhook(self, request: Request) -> list[Event]:
        """Verify the request really came from the processor, then translate it.
        Raises ValueError for anything that doesn't verify."""

    async def cancel(self, provider_ref: str) -> None:
        """Stop future charges; access lasts until the paid period ends."""


class MockProvider:
    """Test payments on our own page (billing/router.py, /api/billing/mock/*):
    a full purchase, renewal or cancellation without a processor account."""

    name = "mock"
    test_only = True
    webhooks = False

    def ready(self) -> bool:
        return True

    async def create_checkout(self, checkout_id: str, customer_ip: str | None) -> str:
        return f"{config.public_base_url()}/api/billing/mock/pay/{checkout_id}"

    async def parse_webhook(self, request: Request) -> list[Event]:
        raise ValueError("the mock provider has no webhook; its page applies events directly")

    async def cancel(self, provider_ref: str) -> None:
        return None


# ── Polar (polar.sh, merchant of record) ──────────────────────────────────────

POLAR_API = {"sandbox": "https://sandbox-api.polar.sh", "production": "https://api.polar.sh"}
# Our checkout id rides on the Polar checkout's metadata, which Polar copies
# onto the subscription it creates.
POLAR_META_KEY = "jma_checkout"
WEBHOOK_TOLERANCE_SECONDS = 300


def _parse_time(value) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _webhook_keys(secret: str) -> list[bytes]:
    """Polar secrets made from 8 Sep 2026 are Standard Webhooks secrets (the
    key is the base64 after "whsec_"); older ones sign with the UTF-8 bytes
    of the whole string. Polar's SDK tries both, and so does this."""
    keys = []
    if secret.startswith("whsec_"):
        try:
            keys.append(base64.b64decode(secret[len("whsec_"):], validate=True))
        except ValueError:
            pass
    keys.append(secret.encode())
    return keys


def verify_standard_webhook(secret: str, headers, body: bytes, now: float | None = None) -> None:
    """Standard Webhooks (standardwebhooks.com), which Polar signs with:
    HMAC-SHA256 over "<id>.<timestamp>.<body>", base64, in webhook-signature
    as space-separated "v1,<sig>" entries."""
    msg_id = headers.get("webhook-id") or ""
    stamp = headers.get("webhook-timestamp") or ""
    sigs = headers.get("webhook-signature") or ""
    if not (msg_id and stamp and sigs):
        raise ValueError("missing webhook signature headers")
    try:
        sent_at = int(stamp)
    except ValueError:
        raise ValueError("bad webhook timestamp")
    if abs((now or time.time()) - sent_at) > WEBHOOK_TOLERANCE_SECONDS:
        raise ValueError("webhook timestamp outside tolerance")
    signed = f"{msg_id}.{stamp}.".encode() + body
    expected = [base64.b64encode(hmac.new(k, signed, hashlib.sha256).digest()).decode() for k in _webhook_keys(secret)]
    for entry in sigs.split():
        version, _, sig = entry.partition(",")
        if version == "v1" and any(hmac.compare_digest(sig, e) for e in expected):
            return
    raise ValueError("webhook signature mismatch")


class PolarProvider:
    """Env: POLAR_ACCESS_TOKEN (organization access token), POLAR_WEBHOOK_SECRET,
    POLAR_PRODUCT_ID (the monthly subscription product), POLAR_SERVER
    ('sandbox' by default — test cards only, admins only — or 'production')."""

    name = "polar"
    webhooks = True

    def __init__(self) -> None:
        self.token = (os.getenv("POLAR_ACCESS_TOKEN", "") or "").strip()
        self.secret = (os.getenv("POLAR_WEBHOOK_SECRET", "") or "").strip()
        self.product_id = (os.getenv("POLAR_PRODUCT_ID", "") or "").strip()
        server = (os.getenv("POLAR_SERVER", "") or "sandbox").strip().lower()
        self.server = server if server in POLAR_API else "sandbox"
        self.test_only = self.server == "sandbox"

    def ready(self) -> bool:
        return bool(self.token and self.secret and self.product_id)

    async def _call(self, method: str, path: str, payload: dict) -> dict:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.request(method, POLAR_API[self.server] + path, json=payload,
                                        headers={"Authorization": f"Bearer {self.token}"})
        if resp.status_code >= 400:
            raise RuntimeError(f"Polar {method} {path} → {resp.status_code}: {resp.text[:300]}")
        return resp.json() if resp.content else {}

    async def create_checkout(self, checkout_id: str, customer_ip: str | None) -> str:
        payload = {
            "products": [self.product_id],
            "metadata": {POLAR_META_KEY: checkout_id},
            "success_url": f"{config.public_base_url()}/api/billing/return",
        }
        # Polar picks the currency from this IP; without it, it would see our server's.
        if customer_ip:
            payload["customer_ip_address"] = customer_ip
        data = await self._call("POST", "/v1/checkouts/", payload)
        return data["url"]

    async def cancel(self, provider_ref: str) -> None:
        await self._call("PATCH", f"/v1/subscriptions/{provider_ref}", {"cancel_at_period_end": True})

    async def parse_webhook(self, request: Request) -> list[Event]:
        body = await request.body()
        verify_standard_webhook(self.secret, request.headers, body)
        try:
            event = json.loads(body)
        except ValueError:
            raise ValueError("webhook body is not JSON")
        return polar_events(event)


def polar_events(event: dict) -> list[Event]:
    """Polar's subscription.* events carry everything needed: status, the
    period end, cancel_at_period_end, the customer, and our metadata. order.*
    events repeat the same facts and are ignored."""
    kind = event.get("type") or ""
    sub = event.get("data") or {}
    if not kind.startswith("subscription.") or not sub.get("id"):
        return []
    ref = str(sub["id"])
    status = sub.get("status") or ""
    period_end = _parse_time(sub.get("current_period_end"))
    email = ((sub.get("customer") or {}).get("email") or "")
    checkout_id = str((sub.get("metadata") or {}).get(POLAR_META_KEY) or "")

    if kind == "subscription.revoked" or status in ("canceled", "unpaid", "incomplete_expired"):
        return [Event(kind="revoked", provider_ref=ref)]
    if status == "past_due":
        return [Event(kind="failed", provider_ref=ref)]
    if status not in ("active", "trialing"):
        return []  # incomplete: no payment yet
    events = []
    if checkout_id:
        # Ignored once the checkout is no longer pending, so repeats are harmless.
        events.append(Event(kind="paid", provider_ref=ref, checkout_id=checkout_id, email=email,
                            period_end=period_end))
    events.append(Event(kind="renewed", provider_ref=ref, period_end=period_end))
    if sub.get("cancel_at_period_end"):
        events.append(Event(kind="cancelled", provider_ref=ref))
    return events


_PROVIDERS: dict[str, type] = {"mock": MockProvider, "polar": PolarProvider}


def current() -> Provider | None:
    """The configured processor, or None when billing is off or it isn't ready."""
    cls = _PROVIDERS.get(config.provider_name())
    if cls is None:
        return None
    provider = cls()
    return provider if provider.ready() else None


def by_name(name: str) -> Provider | None:
    cls = _PROVIDERS.get(name)
    return cls() if cls else None
