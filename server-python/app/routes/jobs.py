import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.core.db import get_db, async_session_factory

from app.models.job_pool import DailyJobPool
from app.services.job_aggregator import CATEGORIES, normalize_category, run_daily_aggregation

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/jobs", tags=["Jobs"])

# A job counts as still open if any sync saw it within this window. ATS boards
# list a position for weeks, so filtering on published_at >= now-24h (the old
# behavior) hid nearly every live job. 48h tolerates one missed daily cron.
ACTIVE_WINDOW = timedelta(hours=48)

_sync_lock = asyncio.Lock()
_last_sync_report: dict = {}


class JobResponse(BaseModel):
    id: str
    title: str
    company: str
    category: str
    seniority: str
    url: str
    description: Optional[str]
    published_at: datetime

    class Config:
        from_attributes = True


async def _run_sync_in_own_session():
    # The request-scoped session from get_db is closed by the time a
    # background task runs — open a dedicated one.
    if _sync_lock.locked():
        logger.warning("[JobPool] sync already running — skipping duplicate trigger")
        return
    async with _sync_lock:
        try:
            async with async_session_factory() as session:
                report = await run_daily_aggregation(session)
            _last_sync_report.clear()
            _last_sync_report.update(report, finished_at=datetime.now(timezone.utc).isoformat())
        except Exception:
            logger.exception("[JobPool] daily sync failed")


@router.post("/trigger-daily-sync")
async def trigger_sync(background_tasks: BackgroundTasks):
    """
    טריגר שמריץ את משיכת המשרות ברקע (מתאים ל-Cron Job פעם ביום)
    """
    if _sync_lock.locked():
        return {"status": "Job aggregation already running"}
    background_tasks.add_task(_run_sync_in_own_session)
    return {"status": "Job aggregation triggered in background"}


@router.get("/sync-status")
async def sync_status():
    """Report from the last completed sync (per-source counts and errors)."""
    return {"running": _sync_lock.locked(), "last_report": _last_sync_report or None}


@router.get("/matched-pool", response_model=List[JobResponse])
async def get_matched_jobs(
    category: str,
    seniority: Optional[str] = None,
    limit: int = Query(30, ge=1, le=200),
    session: AsyncSession = Depends(get_db)
):
    """
    שליפת משרות פתוחות מתוך המאגר המקומי (שנראו בסנכרון ב-48 השעות האחרונות)
    מכאן התוסף יכול לקחת את ה-description ולשלוח ל-AI שלב 2 (התאמת קורות חיים)
    """
    canonical = normalize_category(category)
    if canonical is None:
        raise HTTPException(status_code=400, detail=f"Unknown category '{category}'. Valid: {CATEGORIES}")

    active_since = datetime.now(timezone.utc) - ACTIVE_WINDOW

    query = select(DailyJobPool).where(
        DailyJobPool.category == canonical,
        DailyJobPool.scraped_at >= active_since
    )

    if seniority and seniority != "All":
        query = query.where(DailyJobPool.seniority.in_([seniority.strip().title(), "Unknown"]))

    query = query.order_by(DailyJobPool.published_at.desc()).limit(limit)

    result = await session.execute(query)
    return result.scalars().all()
