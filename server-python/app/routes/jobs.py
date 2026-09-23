from datetime import datetime, timedelta, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from app.core.db import get_db

from app.models.job_pool import DailyJobPool
from app.services.job_aggregator import run_daily_aggregation
# יש לייבא את פונקציית ה-session מהתשתית הקיימת אצלך ב-server-python
# למשל: from app.database import get_db

router = APIRouter(prefix="/jobs", tags=["Jobs"])

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

@router.post("/trigger-daily-sync")
async def trigger_sync(background_tasks: BackgroundTasks, session: AsyncSession = Depends(get_db)):
    """
    טריגר שמריץ את משיכת המשרות ברקע (מתאים ל-Cron Job פעם ביום)
    """
    background_tasks.add_task(run_daily_aggregation, session)
    return {"status": "Job aggregation triggered in background"}

@router.get("/matched-pool", response_model=List[JobResponse])
async def get_matched_jobs(
    category: str,
    seniority: Optional[str] = None,
    session: AsyncSession = Depends(get_db)
):
    """
    שליפת משרות מהירות מתוך המאגר המקומי (מה-24 שעות האחרונות)
    מכאן התוסף יכול לקחת את ה-description ולשלוח ל-AI שלב 2 (התאמת קורות חיים)
    """
    yesterday = datetime.now(timezone.utc) - timedelta(hours=24)
    
    query = select(DailyJobPool).where(
        DailyJobPool.category == category,
        DailyJobPool.published_at >= yesterday
    )
    
    if seniority and seniority != "All":
        query = query.where(DailyJobPool.seniority.in_([seniority, "Unknown"]))
        
    query = query.order_by(DailyJobPool.published_at.desc()).limit(30)
    
    result = await session.execute(query)
    return result.scalars().all()