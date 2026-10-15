"""Polar: webhook signatures, how its events map onto ours, and a purchase
through renewal, cancellation and revocation over HTTP (Polar's API faked)."""
import base64
import hashlib
import hmac
import json
import time

import pytest
from fastapi import HTTPException

import main as main_module
from billing import service
from billing.providers import PolarProvider, polar_events, verify_standard_webhook
from tests.test_billing import ADMIN, client  # noqa: F401  (the fixture)

SECRET = "polar_whs_test_secret"


def _signed(payload: dict, secret: str = SECRET, stamp: int | None = None, msg_id: str = "msg_1"):
    body = json.dumps(payload).encode()
    stamp = stamp or int(time.time())
    key = base64.b64decode(secret[6:]) if secret.startswith("whsec_") else secret.encode()
    sig = base64.b64encode(hmac.new(key, f"{msg_id}.{stamp}.".encode() + body, hashlib.sha256).digest()).decode()
    return body, {"webhook-id": msg_id, "webhook-timestamp": str(stamp), "webhook-signature": f"v1,{sig}",
                  "content-type": "application/json"}


def _sub(status="active", **extra):
    data = {"id": "sub_1", "status": status, "current_period_end": "2026-11-20T10:00:00Z",
            "cancel_at_period_end": False, "customer": {"email": "Noa@Example.com"}, "metadata": {}}
    data.update(extra)
    return data


class TestSignature:
    def test_valid_signature_passes(self):
        body, headers = _signed({"type": "x"})
        verify_standard_webhook(SECRET, headers, body)

    def test_whsec_secrets_are_base64(self):
        secret = "whsec_" + base64.b64encode(b"raw-key").decode()
        body, headers = _signed({"type": "x"}, secret=secret)
        verify_standard_webhook(secret, headers, body)

    def test_older_polar_secrets_sign_with_the_whole_string(self):
        secret = "whsec_" + base64.b64encode(b"raw-key").decode()
        body = b'{"type": "x"}'
        stamp = str(int(time.time()))
        sig = base64.b64encode(hmac.new(secret.encode(), f"m.{stamp}.".encode() + body, hashlib.sha256).digest()).decode()
        verify_standard_webhook(secret, {"webhook-id": "m", "webhook-timestamp": stamp,
                                         "webhook-signature": f"v1,{sig}"}, body)

    @pytest.mark.parametrize("tamper", ["body", "secret", "stale", "missing"])
    def test_anything_else_is_refused(self, tamper):
        body, headers = _signed({"type": "x"}, stamp=int(time.time()) - (600 if tamper == "stale" else 0))
        if tamper == "body":
            body = body.replace(b"x", b"y")
        if tamper == "missing":
            headers.pop("webhook-signature")
        with pytest.raises(ValueError):
            verify_standard_webhook("other" if tamper == "secret" else SECRET, headers, body)


class TestEvents:
    def test_first_activation_pays_the_checkout(self):
        evs = polar_events({"type": "subscription.active", "data": _sub(metadata={"jma_checkout": "c" * 32})})
        assert [e.kind for e in evs] == ["paid", "renewed"]
        assert evs[0].checkout_id == "c" * 32 and evs[0].email == "Noa@Example.com"
        assert evs[0].period_end.isoformat() == "2026-11-20T10:00:00+00:00"

    def test_lifecycle(self):
        def kinds(t, **kw):
            return [e.kind for e in polar_events({"type": t, "data": _sub(**kw)})]
        assert kinds("subscription.updated", cancel_at_period_end=True) == ["renewed", "cancelled"]
        assert kinds("subscription.updated", status="past_due") == ["failed"]
        assert kinds("subscription.revoked") == ["revoked"]
        assert kinds("subscription.updated", status="canceled") == ["revoked"]
        assert kinds("subscription.created", status="incomplete") == []
        assert polar_events({"type": "order.paid", "data": {"id": "ord_1"}}) == []


@pytest.fixture
async def polar(client, monkeypatch):  # noqa: F811
    monkeypatch.setenv("BILLING_PROVIDER", "polar")
    monkeypatch.setenv("POLAR_ACCESS_TOKEN", "polar_oat_test")
    monkeypatch.setenv("POLAR_WEBHOOK_SECRET", SECRET)
    monkeypatch.setenv("POLAR_PRODUCT_ID", "prod_1")
    monkeypatch.delenv("POLAR_SERVER", raising=False)
    calls = []

    async def fake_call(self, method, path, payload):
        calls.append((self.server, method, path, payload))
        return {"url": "https://sandbox.polar.sh/checkout/abc", "id": "co_1"} if path == "/v1/checkouts/" else {}
    monkeypatch.setattr(PolarProvider, "_call", fake_call)
    client.calls = calls
    return client


async def _hook(client, event_type, sub):
    body, headers = _signed({"type": event_type, "data": sub})
    return await client.post("/api/billing/webhook/polar", content=body, headers=headers)


class TestFlow:
    async def test_sandbox_is_admins_only_and_production_follows_the_switch(self, polar, monkeypatch):
        monkeypatch.setenv("DAILY_MATCHES_ENABLED", "on")
        assert (await polar.get("/api/billing/config")).json() == {"enabled": False}
        assert (await polar.get("/api/billing/config", headers=ADMIN)).json()["enabled"] is True
        monkeypatch.setenv("POLAR_SERVER", "production")
        assert (await polar.get("/api/billing/config")).json() == {"enabled": True, "price_label": "$5.90", "test": False}

    async def test_not_ready_without_every_credential(self, polar, monkeypatch):
        monkeypatch.setenv("POLAR_PRODUCT_ID", "")
        assert (await polar.get("/api/billing/config", headers=ADMIN)).json() == {"enabled": False}

    async def test_purchase_renewal_cancel_and_revoke(self, polar):
        co = (await polar.post("/api/billing/checkout", headers={**ADMIN, "X-Forwarded-For": "84.94.1.2"})).json()
        assert co["url"] == "https://sandbox.polar.sh/checkout/abc"
        server, method, path, payload = polar.calls[0]
        assert (server, method, path) == ("sandbox", "POST", "/v1/checkouts/")
        assert payload["products"] == ["prod_1"] and payload["metadata"] == {"jma_checkout": co["checkout_id"]}
        assert payload["customer_ip_address"] == "84.94.1.2" and payload["success_url"].endswith("/api/billing/return")

        # Polar reports the new subscription; the extension collects the key.
        meta = {"jma_checkout": co["checkout_id"]}
        assert (await _hook(polar, "subscription.created", _sub(status="incomplete", metadata=meta))).status_code == 200
        assert (await polar.get(f"/api/billing/checkout/{co['checkout_id']}")).json() == {"status": "pending"}
        await _hook(polar, "subscription.active", _sub(metadata=meta))
        await _hook(polar, "subscription.active", _sub(metadata=meta))  # Polar retries; nothing doubles
        key = (await polar.get(f"/api/billing/checkout/{co['checkout_id']}")).json()["license_key"]
        assert polar.sent == [("noa@example.com", key, True)]
        hdr = {"X-License-Key": key}
        assert (await polar.get("/api/billing/subscription", headers=hdr)).json()["current_period_end"].startswith("2026-11-20")

        # A renewal moves the period end.
        await _hook(polar, "subscription.updated", _sub(current_period_end="2026-12-20T10:00:00Z"))
        assert (await polar.get("/api/billing/subscription", headers=hdr)).json()["current_period_end"].startswith("2026-12-20")

        # Cancelling from the extension asks Polar to stop at the period end.
        assert (await polar.post("/api/billing/cancel", headers=hdr)).json()["status"] == "cancelled"
        assert polar.calls[-1][1:] == ("PATCH", "/v1/subscriptions/sub_1", {"cancel_at_period_end": True})
        assert await main_module.verify_gumroad_license(key)  # the paid period is still running

        # Revoked (refund, chargeback, the period ran out): access ends now.
        await _hook(polar, "subscription.revoked", _sub(status="canceled"))
        service.forget_cached()
        with pytest.raises(HTTPException):
            await main_module.verify_gumroad_license(key)

    async def test_unsigned_or_forged_webhooks_are_refused(self, polar):
        body, headers = _signed({"type": "subscription.active", "data": _sub()}, secret="someone-else")
        assert (await polar.post("/api/billing/webhook/polar", content=body, headers=headers)).status_code == 400
        assert (await polar.post("/api/billing/webhook/polar", json={"type": "x"})).status_code == 400

    async def test_a_processor_failure_is_a_clean_error(self, polar, monkeypatch):
        async def down(self, method, path, payload):
            raise RuntimeError("Polar POST /v1/checkouts/ → 500")
        monkeypatch.setattr(PolarProvider, "_call", down)
        resp = await polar.post("/api/billing/checkout", headers=ADMIN)
        assert resp.status_code == 502 and "דף התשלום" in resp.json()["detail"]
