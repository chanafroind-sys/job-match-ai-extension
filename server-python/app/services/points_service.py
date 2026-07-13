"""Community points ledger. Balance is never stored — it is always
SUM(points_ledger.delta) for a user_id, computed on read.

Every function takes the caller's AsyncSession instead of opening its own, so a
charge/credit can be composed into the same transaction as the business action
it accompanies (e.g. "create recruiter" + "credit points" commit together or not
at all). Callers are responsible for commit(); these functions only flush().
"""

import asyncio
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import points_config
from app.core.models import ActionType, PointsLedger, User

# The "directory" is the recruiters + employees community database — a single
# daily cap (points_config.DAILY_RECRUITER_CAP) applies across adding/enriching
# either kind of record, so both recruiters.py and employees.py share this cap
# check rather than each keeping (and risking drifting) their own count.
_DIRECTORY_ACTION_TYPES = (
    ActionType.RECRUITER_ADDED_NEW,
    ActionType.RECRUITER_ENRICHED,
    ActionType.EMPLOYEE_ADDED_NEW,
    ActionType.EMPLOYEE_ENRICHED,
)

# Per-user, per-process locks. SQLAlchemy silently drops SELECT ... FOR UPDATE on
# the sqlite dialect (no such feature exists in SQLite), so on SQLite the
# with_for_update() call below buys nothing — this lock is what actually keeps
# the "read balance, then insert ledger row" sequence atomic for concurrent
# charges to the same user within a single process (which is what both the test
# suite and the single-instance Render deployment are). The with_for_update()
# row lock is still real on Postgres and additionally covers multi-process
# concurrency there.
_user_locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)


async def get_balance(db: AsyncSession, user_id: int) -> int:
    result = await db.execute(
        select(func.coalesce(func.sum(PointsLedger.delta), 0)).where(PointsLedger.user_id == user_id)
    )
    return int(result.scalar_one())


async def credit(
    db: AsyncSession,
    user_id: int,
    action_type: ActionType,
    amount: int,
    ref_id: Optional[str] = None,
) -> PointsLedger:
    if amount <= 0:
        raise ValueError("credit amount must be positive")
    entry = PointsLedger(user_id=user_id, action_type=action_type, delta=amount, ref_id=ref_id)
    db.add(entry)
    await db.flush()
    return entry


async def charge(
    db: AsyncSession,
    user_id: int,
    action_type: ActionType,
    cost: int,
    ref_id: Optional[str] = None,
) -> PointsLedger:
    if cost <= 0:
        raise ValueError("charge cost must be positive")

    async with _user_locks[user_id]:
        await db.execute(select(User.id).where(User.id == user_id).with_for_update())

        balance = await get_balance(db, user_id)
        if balance < cost:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient points balance: have {balance}, need {cost}.",
            )

        entry = PointsLedger(user_id=user_id, action_type=action_type, delta=-cost, ref_id=ref_id)
        db.add(entry)
        await db.flush()
        return entry


async def daily_directory_credits_today(db: AsyncSession, user_id: int) -> int:
    """Counts today's recruiter+employee add/enrich ledger rows for a user,
    against points_config.DAILY_RECRUITER_CAP."""
    # Naive UTC, matching how SQLite stores DateTime(timezone=True) values
    # under the server_default CURRENT_TIMESTAMP (no offset suffix).
    since = datetime.now(timezone.utc).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)
    result = await db.execute(
        select(func.count(PointsLedger.id)).where(
            PointsLedger.user_id == user_id,
            PointsLedger.action_type.in_(_DIRECTORY_ACTION_TYPES),
            PointsLedger.created_at >= since,
        )
    )
    return int(result.scalar_one())


async def award_directory_points(
    db: AsyncSession,
    user: User,
    ref_id: str,
    action_type: ActionType,
    amount: int,
    success_message: str,
    cap_message: str,
) -> tuple[int, str]:
    """Credits `amount` points for `action_type` on `ref_id` (a recruiter or
    employee id), unless the user already earned points for this exact
    record+action (no double-dipping) or has hit today's shared directory
    cap. Either way the caller's record is still saved — only the points are
    withheld."""
    dup = await db.execute(
        select(PointsLedger.id).where(
            PointsLedger.user_id == user.id,
            PointsLedger.ref_id == ref_id,
            PointsLedger.action_type == action_type,
        )
    )
    if dup.scalar_one_or_none() is not None:
        return 0, "כבר קיבלת נקודות על הרשומה הזו."

    if await daily_directory_credits_today(db, user.id) >= points_config.DAILY_RECRUITER_CAP:
        return 0, cap_message

    await credit(db, user.id, action_type, amount, ref_id=ref_id)
    return amount, success_message


async def refund(db: AsyncSession, ref_id: str) -> PointsLedger:
    """Reverses the most recent charge recorded against ref_id with a
    referral_refund credit of the same magnitude."""
    result = await db.execute(
        select(PointsLedger)
        .where(PointsLedger.ref_id == ref_id, PointsLedger.delta < 0)
        .order_by(PointsLedger.created_at.desc())
    )
    original = result.scalars().first()
    if original is None:
        raise ValueError(f"no charge found for ref_id={ref_id!r}")

    entry = PointsLedger(
        user_id=original.user_id,
        action_type=ActionType.REFERRAL_REFUND,
        delta=-original.delta,
        ref_id=ref_id,
    )
    db.add(entry)
    await db.flush()
    return entry
