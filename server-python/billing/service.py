"""Subscription lifecycle: checkout → payment → key, renewals, cancellation,
and checking a key on every request (verify_key, called from
main.verify_gumroad_license)."""
import asyncio
import hashlib
import logging
import secrets
import time
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from billing import config, providers
from billing.models import BillingCheckout, BillingKey, BillingSubscription, utcnow
from billing.providers import Event

logger = logging.getLogger(__name__)

# Same wording as an unknown Gumroad key, so the extension handles both alike.
INVALID_KEY = "Invalid or expired license key."
_KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O, 1/I

_verify_cache: dict[str, tuple[float, dict | None]] = {}
# Emails sent after a payment run in the background: a processor waits only
# seconds for the webhook's answer, and SMTP can take longer.
_background: set = set()


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes even for timezone=True columns."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def key_hash(key: str) -> str:
    return hashlib.sha256(key.strip().upper().encode()).hexdigest()


def is_own_key(key: str | None) -> bool:
    return bool(key) and key.strip().upper().startswith(config.KEY_PREFIX)


def new_key() -> str:
    chars = "".join(secrets.choice(_KEY_ALPHABET) for _ in range(16))
    return config.KEY_PREFIX + "-".join(chars[i:i + 4] for i in range(0, 16, 4))


def entitled(sub: BillingSubscription, now: datetime | None = None) -> bool:
    now = now or utcnow()
    end = _aware(sub.current_period_end)
    if sub.status == "cancelled":
        return now < end
    return now < end + config.RENEWAL_GRACE


def forget_cached(key: str | None = None) -> None:
    if key is None:
        _verify_cache.clear()
    else:
        _verify_cache.pop(key_hash(key), None)


# ── checking a key ────────────────────────────────────────────────────────────

async def _subscription_for_key(db: AsyncSession, key: str) -> BillingSubscription | None:
    row = await db.execute(select(BillingSubscription).join(
        BillingKey, BillingKey.subscription_id == BillingSubscription.id).where(
        BillingKey.key_hash == key_hash(key)))
    return row.scalar_one_or_none()


async def verify_key(key: str) -> dict | None:
    """None for a key that isn't ours (the caller tries its other checks).
    Raises 403 for our key when it's unknown or the subscription ran out.
    Returns the same shape verify_gumroad_license does."""
    if not is_own_key(key):
        return None
    h = key_hash(key)
    hit = _verify_cache.get(h)
    if hit and time.monotonic() - hit[0] < config.VERIFY_CACHE_SECONDS:
        info = hit[1]
    else:
        from app.core.db import async_session_factory
        async with async_session_factory() as db:
            sub = await _subscription_for_key(db, key)
            info = None
            if sub is not None and entitled(sub):
                info = {"email": sub.email, "uses": 1, "tier": "premium", "isPremium": True,
                        "subscriptionActive": sub.status != "cancelled"}
        _verify_cache[h] = (time.monotonic(), info)
        if info is not None:
            from app.core import monitoring
            monitoring.record_license(key, info["tier"], info["subscriptionActive"])
    if info is None:
        raise HTTPException(status_code=403, detail=INVALID_KEY)
    return info


# ── checkout ──────────────────────────────────────────────────────────────────

async def create_checkout(db: AsyncSession, provider: providers.Provider,
                          customer_ip: str | None = None) -> tuple[str, str]:
    checkout_id = secrets.token_hex(16)
    db.add(BillingCheckout(id=checkout_id, provider=provider.name, status="pending"))
    await db.commit()
    url = await provider.create_checkout(checkout_id, customer_ip)
    return checkout_id, url


async def claim(db: AsyncSession, checkout_id: str) -> dict:
    """What the extension polls after opening the payment page. The key is
    handed over once; after that the checkout only reports "claimed"."""
    co = await db.get(BillingCheckout, checkout_id)
    if co is None or utcnow() - _aware(co.created_at) > config.CHECKOUT_TTL and co.status == "pending":
        return {"status": "expired"}
    if co.status == "paid" and co.pending_key:
        key = co.pending_key
        co.pending_key = None
        co.status = "claimed"
        await db.commit()
        return {"status": "paid", "license_key": key}
    return {"status": co.status}


# ── events from the processor ─────────────────────────────────────────────────

async def _issue_key(db: AsyncSession, sub: BillingSubscription) -> str:
    key = new_key()
    db.add(BillingKey(key_hash=key_hash(key), subscription_id=sub.id))
    return key


async def apply_event(db: AsyncSession, provider_name: str, ev: Event) -> None:
    """Idempotent: processors retry webhooks, and a repeat changes nothing."""
    now = utcnow()
    period_end = _aware(ev.period_end) or now + config.DEFAULT_PERIOD
    if ev.kind == "paid":
        co = await db.get(BillingCheckout, ev.checkout_id) if ev.checkout_id else None
        if co is None:
            logger.warning("billing: payment for unknown checkout %r", ev.checkout_id)
            return
        if co.status != "pending":
            return
        sub = BillingSubscription(provider=provider_name, provider_ref=ev.provider_ref,
                                  email=(ev.email or "").strip().lower()[:254], status="active",
                                  current_period_end=period_end)
        db.add(sub)
        await db.flush()
        key = await _issue_key(db, sub)
        co.status, co.subscription_id, co.pending_key = "paid", sub.id, key
        await db.commit()
        task = asyncio.create_task(_email_key(sub.email, key, first=True))
        _background.add(task)
        task.add_done_callback(_background.discard)
        return

    row = await db.execute(select(BillingSubscription).where(
        BillingSubscription.provider == provider_name, BillingSubscription.provider_ref == ev.provider_ref))
    sub = row.scalar_one_or_none()
    if sub is None:
        logger.warning("billing: %s for unknown subscription %r", ev.kind, ev.provider_ref)
        return
    if ev.kind == "renewed":
        sub.status = "active"
        sub.current_period_end = max(period_end, _aware(sub.current_period_end))
    elif ev.kind == "failed":
        if sub.status == "active":
            sub.status = "past_due"
    elif ev.kind == "cancelled":
        sub.status = "cancelled"
    elif ev.kind == "revoked":
        sub.status = "cancelled"
        sub.current_period_end = min(now, _aware(sub.current_period_end))
    await db.commit()
    forget_cached()


# ── the subscriber's own actions ──────────────────────────────────────────────

async def describe(db: AsyncSession, key: str) -> dict | None:
    sub = await _subscription_for_key(db, key)
    if sub is None:
        return None
    return {"status": sub.status if entitled(sub) else "expired",
            "current_period_end": _aware(sub.current_period_end).isoformat(),
            "email": mask_email(sub.email)}


async def cancel(db: AsyncSession, key: str) -> dict | None:
    sub = await _subscription_for_key(db, key)
    if sub is None:
        return None
    if sub.status != "cancelled":
        provider = providers.by_name(sub.provider)
        if provider is not None:
            await provider.cancel(sub.provider_ref)
        sub.status = "cancelled"
        await db.commit()
        forget_cached()
    return await describe(db, key)


async def resend_key(db: AsyncSession, email: str) -> None:
    """A new key for this install, sent to the address the subscription was
    bought with, so only its inbox gets it. Says nothing about whether the
    address has a subscription."""
    email = (email or "").strip().lower()
    if "@" not in email:
        return
    rows = await db.execute(select(BillingSubscription).where(BillingSubscription.email == email)
                            .order_by(BillingSubscription.current_period_end.desc()))
    sub = next((s for s in rows.scalars() if entitled(s)), None)
    if sub is None:
        return
    now = utcnow()
    if sub.last_resend_at and now - _aware(sub.last_resend_at) < config.RESEND_COOLDOWN:
        return
    count = await db.scalar(select(func.count()).select_from(BillingKey)
                            .where(BillingKey.subscription_id == sub.id))
    if count >= config.MAX_KEYS_PER_SUBSCRIPTION:
        oldest = await db.execute(select(BillingKey).where(BillingKey.subscription_id == sub.id)
                                  .order_by(BillingKey.created_at).limit(1))
        await db.delete(oldest.scalar_one())
    key = await _issue_key(db, sub)
    sub.last_resend_at = now
    await db.commit()
    await _email_key(email, key, first=False)


def mask_email(email: str) -> str:
    name, _, domain = (email or "").partition("@")
    if not domain:
        return ""
    return (name[:2] + "•••@" + domain) if len(name) > 2 else ("•••@" + domain)


async def _email_key(email: str, key: str, *, first: bool) -> None:
    if not email:
        return
    from app.services import email_service
    subject = "מפתח המנוי שלך ל-Job Match AI" if first else "מפתח מנוי חדש ל-Job Match AI"
    body = (("תודה שנרשמת! " if first else "") +
            f"מפתח המנוי שלך:\n\n{key}\n\n"
            "התוסף מפעיל אותו לבד אחרי התשלום. אם תתקיני את התוסף במחשב אחר, "
            "אפשר להדביק את המפתח בהגדרות ⚙️ תחת \"מפתח מנוי\".")
    try:
        await email_service._send(email, subject, body)
    except Exception as exc:  # noqa: BLE001  best-effort, like every email here
        logger.warning("billing: key email not sent: %s", exc)
