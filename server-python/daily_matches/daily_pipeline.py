"""The daily pipeline: collect today's jobs into daily_job_pool, then embed
them for Daily Matches. Runs once per Israel day, at 06:00 Israel time.

Render schedules crons in UTC only, while Israel moves between UTC+3 (summer)
and UTC+2 (winter). So the cron fires at both 03:00 and 04:00 UTC, and this
module decides:
  - before 06:00 Israel time it does nothing (the winter 03:00 UTC firing);
  - the sync runs once per Israel day: a firing that finds today's sync
    already done skips it (the summer 04:00 UTC firing);
  - embedding is incremental, so a repeat run sends nothing to Voyage.
Every run ends by reading back what it wrote, and by checking that the web
service serves the same jobs. The cron and the web service each have their
own DATABASE_URL, and when they pointed at different databases the sync
"worked" every day while production stayed empty. That now fails the run.
"""
import logging
from datetime import datetime, timedelta

import httpx
from sqlalchemy import func, select, text

from app.models.job_pool import DailyJobPool
from app.services.job_aggregator import run_daily_aggregation
from daily_matches import config, store
from daily_matches.pool_embedding import embed_pool, purge_retention

logger = logging.getLogger(__name__)

RUN_HOUR_IL = 6
PUBLIC_API_URL = "https://job-match-ai-extension.onrender.com"


class PipelineError(RuntimeError):
    """The run did not leave production with a fresh, embedded pool."""


async def _require_schema(session) -> None:
    for table in ("daily_job_pool", "dm_job_embeddings"):
        try:
            await session.execute(text(f"SELECT 1 FROM {table} LIMIT 1"))
        except Exception as exc:  # noqa: BLE001
            await session.rollback()
            raise PipelineError(
                f"table {table} is missing in this database. DATABASE_URL is probably not the "
                f"production database (or its migrations never ran): {type(exc).__name__}") from exc


async def active_count(session, now: datetime, category: str | None = None) -> int:
    query = select(func.count()).select_from(DailyJobPool).where(
        DailyJobPool.scraped_at >= now - config.ACTIVE_WINDOW)
    if category:
        query = query.where(DailyJobPool.category == category)
    return int((await session.execute(query)).scalar() or 0)


async def run_pipeline(session, *, now: datetime | None = None, force: bool = False) -> dict:
    now = now or config.utcnow()
    local = config.to_israel(now)
    report: dict = {"israel_time": local.strftime("%Y-%m-%d %H:%M")}
    if not force and local.hour < RUN_HOUR_IL:
        report["skipped"] = f"before {RUN_HOUR_IL:02d}:00 Israel time"
        return report

    await _require_schema(session)

    todays_run_from = config.il_day_start_utc(now) + timedelta(hours=RUN_HOUR_IL)
    last_sync = config.as_utc((await session.execute(select(func.max(DailyJobPool.scraped_at)))).scalar())
    # Collecting takes about a minute of network calls; don't hold a connection
    # through it (Neon closes idle ones).
    await session.commit()
    if force or last_sync is None or last_sync < todays_run_from:
        sync = await run_daily_aggregation(session)
        report["sync"] = {k: sync.get(k) for k in ("fetched", "upserted", "purged_stale", "duration_sec", "errors")}
        if not sync.get("fetched"):
            raise PipelineError("the sync fetched 0 jobs from every source")
    else:
        report["sync"] = {"skipped": f"already ran today at {config.to_israel(last_sync):%H:%M} Israel time"}

    report["embed"] = await embed_pool(session, now=now)
    report["purged"] = await purge_retention(session)

    pool = await store.pool_counts(session, now - config.ACTIVE_WINDOW)
    report["pool"] = pool
    if pool["active"] == 0:
        raise PipelineError("no active jobs in daily_job_pool after the sync")
    if pool["embedded"] < pool["active"]:
        raise PipelineError(f"{pool['active'] - pool['embedded']} active jobs still have no vector")
    return report


async def verify_web_reads_same_db(expected_backend: int, base_url: str = PUBLIC_API_URL,
                                   transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """Ask the live web service how many active Backend jobs it sees. Zero there
    while this run just wrote some means the two services use different
    databases. A network problem only warns: it says nothing about the data."""
    try:
        async with httpx.AsyncClient(transport=transport, timeout=120) as client:
            resp = await client.get(f"{base_url}/jobs/matched-pool", params={"category": "Backend", "limit": 200})
            resp.raise_for_status()
            web = len(resp.json())
    except Exception as exc:  # noqa: BLE001
        logger.warning("[pipeline] could not reach the web service to cross-check: %s", exc)
        return {"checked": False, "reason": f"{type(exc).__name__}: {exc}"[:200]}
    if expected_backend > 0 and web == 0:
        raise PipelineError(
            f"this run wrote {expected_backend} active Backend jobs, but the web service at {base_url} sees none. "
            "The cron's DATABASE_URL points at a different database than the web service's.")
    return {"checked": True, "web_backend_jobs": web, "this_run_backend_jobs": expected_backend}
