"""Employee-referral eligibility and lifecycle mechanics — no HTTP concerns
here, that's app/routes/referrals.py.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Employee, OptInStatus, ReferralRequest, ReferralStatus
from app.services import points_service

MIN_SCORE = 75
EXPIRY = timedelta(days=7)

_ACTIVE_STATUSES = (ReferralStatus.PENDING, ReferralStatus.ACCEPTED)


async def find_eligible_employee(db: AsyncSession, company_normalized: str, score: int) -> Optional[Employee]:
    """Existence lookup only — callers must never leak the returned row's
    fields back to the client from the /check endpoint (only from the
    authenticated, already-billed accept/decline mutual-exposure step)."""
    if not company_normalized or score < MIN_SCORE:
        return None
    result = await db.execute(
        select(Employee)
        .where(
            Employee.company_normalized == company_normalized,
            Employee.opt_in_status == OptInStatus.ACCEPTED,
            Employee.min_match_threshold <= score,
        )
        .order_by(Employee.id)
    )
    return result.scalars().first()


async def has_active_request(db: AsyncSession, user_id: int, job_url_hash: str) -> bool:
    result = await db.execute(
        select(ReferralRequest.id).where(
            ReferralRequest.user_id == user_id,
            ReferralRequest.job_url_hash == job_url_hash,
            ReferralRequest.status.in_(_ACTIVE_STATUSES),
        )
    )
    return result.scalar_one_or_none() is not None


async def expire_stale_referrals(db: AsyncSession) -> None:
    """Lazy expiry, matching the sync design: run on every access to a
    referral endpoint instead of a scheduled job. Refunds points for each
    expired request and commits."""
    # Naive UTC for the WHERE comparison — matches how SQLite stores
    # DateTime(timezone=True) values under server_default CURRENT_TIMESTAMP
    # (see the identical pattern in app/routes/recruiters.py).
    cutoff = (datetime.now(timezone.utc) - EXPIRY).replace(tzinfo=None)
    result = await db.execute(
        select(ReferralRequest).where(
            ReferralRequest.status == ReferralStatus.PENDING,
            ReferralRequest.created_at < cutoff,
        )
    )
    stale = result.scalars().all()
    if not stale:
        return

    now = datetime.now(timezone.utc)
    for referral in stale:
        referral.status = ReferralStatus.EXPIRED
        referral.resolved_at = now
        await points_service.refund(db, ref_id=str(referral.id))
    await db.commit()
