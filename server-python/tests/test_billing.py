"""Billing over HTTP, end to end on the mock processor: who sees "subscribe",
payment → key, the key unlocking everything a license unlocks, renewals,
failures, cancellation, and "send my key again"."""
from datetime import timedelta

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.core.db as core_db
import billing.models  # noqa: F401  (registers billing_* tables before conftest's create_all)
import main as main_module
from app.core import monitoring
from app.core.db import get_db
from billing import config, providers, service
from billing.models import BillingCheckout, BillingKey, BillingSubscription, utcnow
from billing.providers import Event
from billing.router import router

ADMIN = {"X-License-Key": "ADMIN-KEY"}


@pytest.fixture
async def client(engine, monkeypatch):
    monkeypatch.setenv("BILLING_PROVIDER", "mock")
    monkeypatch.setenv("BILLING_PRICE", "5.9")
    monkeypatch.setenv("BILLING_CURRENCY", "USD")
    monkeypatch.setenv("DAILY_MATCHES_ENABLED", "admins")
    monkeypatch.setattr(main_module, "STATIC_ADMIN_KEYS", {"ADMIN-KEY"})
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(core_db, "async_session_factory", factory)
    service.forget_cached()
    # A verified key is counted in the admin panel by a background write; it would outlive this test's loop.
    monkeypatch.setattr(monitoring, "record_license", lambda *a, **k: None)
    sent = []

    async def fake_email(email, key, *, first):
        sent.append((email, key, first))
    monkeypatch.setattr(service, "_email_key", fake_email)

    app = FastAPI()
    app.include_router(router)

    async def _db():
        async with factory() as session:
            yield session
    app.dependency_overrides[get_db] = _db
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        c.sent = sent
        c.factory = factory
        yield c


async def _buy(client, email="dana@example.com") -> tuple[str, str]:
    co = (await client.post("/api/billing/checkout", headers=ADMIN)).json()
    assert co["url"].endswith("/api/billing/mock/pay/" + co["checkout_id"])
    assert (await client.get(f"/api/billing/checkout/{co['checkout_id']}")).json() == {"status": "pending"}
    assert (await client.post(f"/api/billing/mock/pay/{co['checkout_id']}", json={"email": email})).status_code == 200
    return co["checkout_id"], (await client.get(f"/api/billing/checkout/{co['checkout_id']}")).json()["license_key"]


class TestVisibility:
    async def test_off_without_a_provider_or_a_price(self, client, monkeypatch):
        monkeypatch.setenv("BILLING_PROVIDER", "")
        assert (await client.get("/api/billing/config", headers=ADMIN)).json() == {"enabled": False}
        monkeypatch.setenv("BILLING_PROVIDER", "mock")
        monkeypatch.setenv("BILLING_PRICE", "0")
        assert (await client.get("/api/billing/config", headers=ADMIN)).json() == {"enabled": False}

    async def test_unknown_provider_is_off(self, client, monkeypatch):
        monkeypatch.setenv("BILLING_PROVIDER", "grow")  # no adapter yet
        assert providers.current() is None
        assert (await client.get("/api/billing/config", headers=ADMIN)).json() == {"enabled": False}

    async def test_mock_is_admins_only_even_when_the_feature_is_on(self, client, monkeypatch):
        monkeypatch.setenv("DAILY_MATCHES_ENABLED", "on")
        assert (await client.get("/api/billing/config")).json() == {"enabled": False}
        assert (await client.post("/api/billing/checkout")).status_code == 403
        assert (await client.get("/api/billing/config", headers=ADMIN)).json() == {
            "enabled": True, "price_label": "$5.90", "test": True}

    async def test_a_real_provider_follows_the_rollout_switch(self, client, monkeypatch):
        monkeypatch.setattr(providers.MockProvider, "test_only", False)
        for mode, admin_sees, everyone_sees in (("off", False, False), ("admins", True, False), ("on", True, True)):
            monkeypatch.setenv("DAILY_MATCHES_ENABLED", mode)
            assert (await client.get("/api/billing/config", headers=ADMIN)).json()["enabled"] is admin_sees
            assert (await client.get("/api/billing/config")).json()["enabled"] is everyone_sees


class TestPurchase:
    async def test_payment_issues_a_key_once(self, client):
        checkout_id, key = await _buy(client)
        assert key.startswith("JMA-") and len(key) == len("JMA-XXXX-XXXX-XXXX-XXXX")
        assert (await client.get(f"/api/billing/checkout/{checkout_id}")).json() == {"status": "claimed"}
        assert client.sent == [("dana@example.com", key, True)]
        async with client.factory() as db:
            co = await db.get(BillingCheckout, checkout_id)
            assert co.pending_key is None
            keys = (await db.execute(select(BillingKey))).scalars().all()
            assert [k.key_hash for k in keys] == [service.key_hash(key)]  # never the plaintext

    async def test_a_repeated_payment_event_changes_nothing(self, client):
        checkout_id, _ = await _buy(client)
        await client.post(f"/api/billing/mock/pay/{checkout_id}", json={"email": "x@y.z"})
        async with client.factory() as db:
            assert len((await db.execute(select(BillingSubscription))).scalars().all()) == 1

    async def test_the_key_passes_the_license_check(self, client):
        _, key = await _buy(client)
        info = await main_module.verify_gumroad_license(key)
        assert info["subscriptionActive"] and info["email"] == "dana@example.com"
        with pytest.raises(HTTPException) as exc:
            await main_module.verify_gumroad_license("JMA-NOPE-NOPE-NOPE-NOPE")
        assert exc.value.status_code == 403

    async def test_unknown_or_malformed_checkouts(self, client):
        assert (await client.get("/api/billing/checkout/" + "0" * 32)).json() == {"status": "expired"}
        assert (await client.get("/api/billing/checkout/not-hex")).status_code == 422


class TestLifecycle:
    async def test_renewal_failure_and_cancellation(self, client):
        checkout_id, key = await _buy(client)
        ref = "mock-" + checkout_id
        hdr = {"X-License-Key": key}

        await client.post("/api/billing/mock/event", headers=ADMIN, json={"kind": "failed", "provider_ref": ref})
        assert (await client.get("/api/billing/subscription", headers=hdr)).json()["status"] == "past_due"

        await client.post("/api/billing/mock/event", headers=ADMIN, json={"kind": "renewed", "provider_ref": ref})
        sub = (await client.get("/api/billing/subscription", headers=hdr)).json()
        assert sub["status"] == "active" and sub["email"] == "da•••@example.com"

        assert (await client.post("/api/billing/cancel", headers=hdr)).json()["status"] == "cancelled"
        # Cancelled keeps access until the paid period ends.
        assert (await main_module.verify_gumroad_license(key))["subscriptionActive"] is False

    async def test_mock_events_are_admins_only(self, client):
        checkout_id, key = await _buy(client)
        resp = await client.post("/api/billing/mock/event", headers={"X-License-Key": key},
                                 json={"kind": "cancelled", "provider_ref": "mock-" + checkout_id})
        assert resp.status_code == 403

    async def test_access_ends_with_the_period(self, client):
        checkout_id, key = await _buy(client)
        async with client.factory() as db:
            sub = (await db.execute(select(BillingSubscription))).scalar_one()
            sub.status = "cancelled"
            sub.current_period_end = utcnow() - timedelta(minutes=1)
            await db.commit()
        service.forget_cached()
        with pytest.raises(HTTPException):
            await main_module.verify_gumroad_license(key)
        assert (await client.get("/api/billing/subscription", headers={"X-License-Key": key})).json()["status"] == "expired"

    async def test_a_late_renewal_is_within_grace(self, client):
        _, key = await _buy(client)
        async with client.factory() as db:
            sub = (await db.execute(select(BillingSubscription))).scalar_one()
            sub.current_period_end = utcnow() - timedelta(days=1)
            await db.commit()
        service.forget_cached()
        assert await main_module.verify_gumroad_license(key)


class TestResend:
    async def test_new_key_to_the_purchase_address_only(self, client):
        _, first = await _buy(client)
        assert (await client.post("/api/billing/resend-key", json={"email": "someone@else.com"})).json() == {"ok": True}
        assert len(client.sent) == 1
        await client.post("/api/billing/resend-key", json={"email": " Dana@Example.com "})
        email, second, is_first = client.sent[-1]
        assert email == "dana@example.com" and second != first and not is_first
        assert await main_module.verify_gumroad_license(second)
        assert await main_module.verify_gumroad_license(first)  # the other install keeps working

    async def test_cooldown_and_key_cap(self, client, monkeypatch):
        _, first = await _buy(client)
        await client.post("/api/billing/resend-key", json={"email": "dana@example.com"})
        await client.post("/api/billing/resend-key", json={"email": "dana@example.com"})
        assert len(client.sent) == 2  # the second resend fell in the cooldown
        monkeypatch.setattr(config, "RESEND_COOLDOWN", timedelta(0))
        for _ in range(3):
            await client.post("/api/billing/resend-key", json={"email": "dana@example.com"})
        async with client.factory() as db:
            assert len((await db.execute(select(BillingKey))).scalars().all()) == config.MAX_KEYS_PER_SUBSCRIPTION
        service.forget_cached()
        with pytest.raises(HTTPException):  # the oldest key made room for the newest
            await main_module.verify_gumroad_license(first)


async def test_mock_pages_404_without_the_mock_provider(client, monkeypatch):
    monkeypatch.setenv("BILLING_PROVIDER", "")
    assert (await client.get("/api/billing/mock/pay/" + "a" * 32)).status_code == 404


async def test_webhook_refuses_the_mock_and_unknown_providers(client):
    assert (await client.post("/api/billing/webhook/mock")).status_code == 404
    assert (await client.post("/api/billing/webhook/nope")).status_code == 404


async def test_payment_for_an_unknown_checkout_is_ignored(client):
    async with client.factory() as db:
        await service.apply_event(db, "mock", Event(kind="paid", provider_ref="x", checkout_id="f" * 32))
        assert (await db.execute(select(BillingSubscription))).scalars().all() == []


class TestWhatTheSubscriptionCovers:
    """Daily Matches and the features without AI; the other AI features run
    on the subscriber's own Claude key, never the server's."""

    async def test_ai_without_an_own_key_asks_for_one(self, client):
        _, key = await _buy(client)
        with pytest.raises(HTTPException) as exc:
            await main_module.require_auth(key, None)
        assert exc.value.status_code == 401 and "[jma:AI_NO_KEY]" in exc.value.detail
        assert main_module._request_client.get() is None

    async def test_community_routes_know_the_subscriber_without_a_claude_key(self, client):
        _, key = await _buy(client)
        assert await main_module.require_auth(key, None, ai=False) == key

    async def test_with_an_own_key_ai_runs_on_it_and_the_subscriber_stays_the_identity(self, client):
        _, key = await _buy(client)
        token = main_module._request_client.set(None)
        try:
            assert await main_module.require_auth(key, "sk-ant-test-0000") == key
            assert main_module.using_own_key()
        finally:
            main_module._request_client.reset(token)

    async def test_admin_keys_still_run_on_the_server(self, client, monkeypatch):
        monkeypatch.setattr(main_module, "STATIC_PREMIUM_KEYS", {"ADMIN-KEY"})
        assert await main_module.require_auth("ADMIN-KEY", None) == "ADMIN-KEY"
        assert not main_module.using_own_key()
