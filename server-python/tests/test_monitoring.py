"""The admin's system-status panel: what's recorded, and what it reports."""
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.models.monitoring  # noqa: F401  (registers the tables before conftest's create_all)
import daily_matches.models  # noqa: F401
import main
from app.core import monitoring
from app.models.monitoring import AiUsageDaily, AppError, LicenseActivity
from daily_matches.models import DmPipelineDay, DmRun

NOW = datetime(2026, 10, 15, 9, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _monitor_db(engine, monkeypatch):
    monkeypatch.setattr(monitoring, "_session_factory", async_sessionmaker(engine, expire_on_commit=False))
    monkeypatch.setattr(main, "STATIC_ADMIN_KEYS", {"admin-key"})


def _app():
    app = FastAPI()

    @app.get("/ok")
    async def ok():
        return {"ok": True}

    @app.get("/ai/{job_id}")
    async def ai_down(job_id: int):
        raise HTTPException(status_code=503, detail="תקלה זמנית בשירות ה-AI [jma:AI_DOWN]")

    @app.get("/boom")
    async def boom():
        raise RuntimeError("database went away")
    return monitoring.MonitorMiddleware(app)


async def test_server_failures_are_recorded_and_nothing_else(db):
    transport = httpx.ASGITransport(app=_app(), raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        assert (await client.get("/ok")).status_code == 200
        assert (await client.get("/ai/123")).status_code == 503
        assert (await client.get("/boom")).status_code == 500
    await monitoring.flush()
    rows = (await db.execute(select(AppError).order_by(AppError.id))).scalars().all()
    assert [(r.kind, r.status) for r in rows] == [("server_error", 503), ("exception", 500)]
    assert rows[0].route == "GET /ai/{job_id}" and "AI_DOWN" in rows[0].detail  # the route, never the id
    assert rows[1].detail.startswith("RuntimeError: database went away")


async def test_a_slow_answer_is_recorded(db, monkeypatch):
    monkeypatch.setattr(monitoring, "SLOW_SECONDS", -1)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app()), base_url="http://t") as client:
        await client.get("/ok")
    await monitoring.flush()
    assert [(r.kind, r.route) for r in (await db.execute(select(AppError))).scalars()] == [("slow", "GET /ok")]


async def test_a_license_is_counted_once_by_fingerprint_and_admins_are_not(db):
    monitoring.record_license("CUSTOMER-KEY-1", "standard")
    monitoring.record_license("CUSTOMER-KEY-1", "premium")  # upgraded
    monitoring.record_license("admin-key", "premium")
    await monitoring.flush()
    rows = (await db.execute(select(LicenseActivity))).scalars().all()
    assert len(rows) == 1 and rows[0].tier == "premium"
    assert "CUSTOMER-KEY-1" not in rows[0].key_hash  # a fingerprint, never the key


async def test_usage_is_summed_per_day_and_model_and_a_users_own_key_is_not_counted(db, monkeypatch):
    usage = SimpleNamespace(input_tokens=1000, output_tokens=200, cache_read_input_tokens=5000,
                            cache_creation_input_tokens=0)
    monkeypatch.setattr(main, "using_own_key", lambda: False)
    main._track(main.MODEL_SMART, usage)
    main._track(main.MODEL_SMART, usage)
    monkeypatch.setattr(main, "using_own_key", lambda: True)
    main._track(main.MODEL_SMART, usage)  # the user pays for that one
    await monitoring.flush()
    row = (await db.execute(select(AiUsageDaily))).scalar_one()
    assert row.model == main.MODEL_SMART and row.calls == 2 and row.input_tokens == 2000 and row.cache_read_tokens == 10000


async def test_the_status_report(db):
    old = NOW - timedelta(days=50)
    db.add_all([
        LicenseActivity(key_hash="a", tier="standard", active=True, first_seen=NOW - timedelta(days=3), last_seen=NOW),
        LicenseActivity(key_hash="b", tier="premium", active=True, first_seen=old, last_seen=NOW - timedelta(days=10)),
        LicenseActivity(key_hash="c", tier="premium", active=False, first_seen=old, last_seen=NOW - timedelta(days=2)),
        LicenseActivity(key_hash="d", tier="standard", active=True, first_seen=old, last_seen=old),  # lapsed
        AiUsageDaily(day=date(2026, 10, 14), model="claude-sonnet-5-5", calls=10, input_tokens=1_000_000,
                     output_tokens=100_000, cache_read_tokens=0, cache_write_tokens=0),
        DmRun(subject="s1", match_day=date(2026, 10, 14), entitlement="subscription", status="failed",
              error="לא נמצאו קורות חיים [jma:DM_NO_CV]", started_at=NOW - timedelta(days=1)),
        DmPipelineDay(day=date(2026, 10, 15), finished_at=NOW, summary={
            "new_total": 53, "linkedin": {"jobs": 140, "blocked": None, "credit": {"left_usd": 4.68}}}),
        AppError(at=NOW - timedelta(hours=2), kind="server_error", route="POST /api/generate-cv", status=503,
                 detail="[jma:AI_DOWN]"),
        AppError(at=NOW - timedelta(hours=1), kind="server_error", route="POST /api/generate-cv", status=503,
                 detail="[jma:AI_DOWN]"),
        AppError(at=NOW - timedelta(days=90), kind="slow", route="GET /old", status=200, detail=""),  # purged
    ])
    await db.commit()
    h = await monitoring.build_health(db, now=NOW)
    s = h["subscribers"]
    assert s["paying_total"] == 2 and s["paying_by_plan"] == {"standard": 1, "premium": 1}
    assert s["cancelling"] == 1 and s["new_this_month"] == 1 and s["active_last_7_days"] == 2
    assert h["ai_cost"]["features_usd"] == {"claude-sonnet-5-5": 3.0} and h["ai_cost"]["per_paying_user_usd"] == 1.5
    assert h["daily_matches"]["failures_by_reason"] == {"DM_NO_CV": 1}
    assert h["collection"]["ran_today"] and h["collection"]["last_days"][0]["apify_credit_left_usd"] == 4.68
    assert h["server_errors"]["total_last_7_days"] == 2 and h["server_errors"]["groups"][0]["count"] == 2
    assert (await db.execute(select(AppError).where(AppError.route == "GET /old"))).first() is None
    text = h["report_text"]
    assert "Paying: 2" in text and "2x server_error 503 POST /api/generate-cv" in text and "DM_NO_CV" in text


async def test_only_an_admin_sees_it(db, user):
    from app.core.deps import require_admin
    with pytest.raises(HTTPException) as exc:
        await require_admin(user=user)
    assert exc.value.status_code == 403
