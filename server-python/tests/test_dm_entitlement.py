"""Daily Matches access: rollout modes, subscriber vs. trial, and the trial's
abuse limits."""
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import main as main_module
import daily_matches.models  # noqa: F401  (registers dm_* tables before conftest's create_all)
from daily_matches import config
from daily_matches.entitlement import (
    DmError,
    client_ip,
    release_trial,
    reserve_trial,
    resolve_access,
)
from daily_matches.models import DmRun, DmTrial

INSTALL_A = "a" * 32
INSTALL_B = "b" * 32


@pytest.fixture
def licenses(monkeypatch):
    async def verify(key):
        if key in ("GOOD-KEY", "ADMIN-KEY"):
            return {"isPremium": False}
        if key == "DOWN-KEY":
            raise HTTPException(status_code=503, detail="gumroad down")
        raise HTTPException(status_code=403, detail="Invalid or expired license key.")
    monkeypatch.setattr(main_module, "verify_gumroad_license", verify)
    monkeypatch.setattr(main_module, "STATIC_ADMIN_KEYS", {"ADMIN-KEY"})


@pytest.fixture
def mode_on(monkeypatch):
    monkeypatch.setenv("DAILY_MATCHES_ENABLED", "on")


async def _run_row(db, subject="inst:x") -> DmRun:
    run = DmRun(subject=subject, match_day=config.match_day(), entitlement="trial", status="running")
    db.add(run)
    await db.commit()
    return run


class TestModes:
    async def test_off_by_default(self, db, licenses, monkeypatch):
        monkeypatch.delenv("DAILY_MATCHES_ENABLED", raising=False)
        access = await resolve_access(db, "GOOD-KEY", INSTALL_A, "1.1.1.1")
        assert access.kind == "disabled" and access.reason == "off"

    async def test_admins_mode(self, db, licenses, monkeypatch):
        monkeypatch.setenv("DAILY_MATCHES_ENABLED", "admins")
        assert (await resolve_access(db, "ADMIN-KEY", None, "1.1.1.1")).kind == "subscription"
        assert (await resolve_access(db, "GOOD-KEY", None, "1.1.1.1")).reason == "admins_only"
        assert (await resolve_access(db, None, INSTALL_A, "1.1.1.1")).reason == "admins_only"


class TestSubscriber:
    async def test_license_is_subscription_with_shared_subject(self, db, licenses, mode_on):
        one = await resolve_access(db, "GOOD-KEY", INSTALL_A, "1.1.1.1")
        two = await resolve_access(db, "GOOD-KEY", INSTALL_B, "2.2.2.2")
        assert one.kind == "subscription" and one.subject == "lic:" + main_module._ws_user_id("GOOD-KEY")
        assert one.subject == two.subject  # one daily run per license, whatever the device

    async def test_rejected_license_falls_back_to_trial(self, db, licenses, mode_on):
        access = await resolve_access(db, "EXPIRED-KEY", INSTALL_A, "1.1.1.1")
        assert access.kind == "trial" and access.subject.startswith("inst:")

    async def test_gumroad_outage_does_not_downgrade_a_subscriber(self, db, licenses, mode_on):
        with pytest.raises(DmError) as info:
            await resolve_access(db, "DOWN-KEY", INSTALL_A, "1.1.1.1")
        assert info.value.code == "DM_LICENSE_UNAVAILABLE"

    async def test_personal_claude_key_does_not_unlock(self, db, licenses, mode_on):
        run = await _run_row(db)
        access = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        await reserve_trial(db, access, "fp-1", run.id)
        # resolve_access has no anthropic-key parameter at all: BYOK is not an entitlement.
        assert (await resolve_access(db, None, INSTALL_A, "1.1.1.1")).kind == "locked"


class TestTrial:
    async def test_install_id_required(self, db, licenses, mode_on):
        for bad in (None, "", "short", "has spaces in it at all!!"):
            access = await resolve_access(db, None, bad, "1.1.1.1")
            assert access.kind == "locked" and access.reason == "no_install"

    async def test_one_trial_per_install(self, db, licenses, mode_on):
        access = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        assert access.kind == "trial"
        await reserve_trial(db, access, "fp-1", (await _run_row(db)).id)
        again = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-2")
        assert again.kind == "locked" and again.reason == "trial_used"

    async def test_one_trial_per_cv_across_installs(self, db, licenses, mode_on):
        access = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        await reserve_trial(db, access, "fp-1", (await _run_row(db)).id)
        other = await resolve_access(db, None, INSTALL_B, "9.9.9.9", "fp-1")
        assert other.kind == "locked" and other.reason == "trial_used"

    async def test_parallel_claim_loses_at_the_database(self, db, licenses, mode_on):
        first = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        second = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        run = await _run_row(db)
        await reserve_trial(db, first, "fp-1", run.id)
        with pytest.raises(DmError) as info:
            await reserve_trial(db, second, "fp-1", run.id)
        assert info.value.code == "LICENSE_REQUIRED"

    async def test_ip_cap(self, db, licenses, mode_on, monkeypatch):
        monkeypatch.setattr(config, "TRIAL_IP_MAX", 2)
        run = await _run_row(db)
        for i in range(2):
            install = f"{i}" * 32
            access = await resolve_access(db, None, install, "5.5.5.5", f"fp-{i}")
            await reserve_trial(db, access, f"fp-{i}", run.id)
        blocked = await resolve_access(db, None, "c" * 32, "5.5.5.5", "fp-x")
        assert blocked.kind == "locked" and blocked.reason == "trial_limit"
        assert (await resolve_access(db, None, "c" * 32, "6.6.6.6", "fp-x")).kind == "trial"

    async def test_daily_budget(self, db, licenses, mode_on, monkeypatch):
        monkeypatch.setattr(config, "TRIAL_DAILY_BUDGET", 1)
        access = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        await reserve_trial(db, access, "fp-1", (await _run_row(db)).id)
        blocked = await resolve_access(db, None, INSTALL_B, "2.2.2.2", "fp-2")
        assert blocked.reason == "trial_limit"

    async def test_released_trial_is_available_again(self, db, licenses, mode_on):
        access = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        await reserve_trial(db, access, "fp-1", (await _run_row(db)).id)
        await release_trial(db, access.install_hash)
        await db.commit()
        assert (await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")).kind == "trial"

    async def test_abandoned_reservation_expires(self, db, licenses, mode_on):
        access = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        db.add(DmTrial(install_hash=access.install_hash, cv_fingerprint="fp-1", ip_hash=access.ip_hash,
                       status="reserved",
                       created_at=config.utcnow() - config.TRIAL_RESERVATION_TTL - timedelta(minutes=1)))
        await db.commit()
        assert (await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")).kind == "trial"

    async def test_consumed_trial_never_expires(self, db, licenses, mode_on):
        access = await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")
        db.add(DmTrial(install_hash=access.install_hash, cv_fingerprint="fp-1", ip_hash=access.ip_hash,
                       status="consumed", created_at=config.utcnow() - timedelta(days=400)))
        await db.commit()
        assert (await resolve_access(db, None, INSTALL_A, "1.1.1.1", "fp-1")).reason == "trial_used"


def test_client_ip_takes_the_proxy_appended_address():
    req = SimpleNamespace(headers={"x-forwarded-for": "6.6.6.6, 10.0.0.1, 203.0.113.9"},
                          client=SimpleNamespace(host="10.1.1.1"))
    assert client_ip(req) == "203.0.113.9"
    assert client_ip(SimpleNamespace(headers={}, client=SimpleNamespace(host="10.1.1.1"))) == "10.1.1.1"
