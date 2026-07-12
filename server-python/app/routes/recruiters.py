"""Community recruiter directory: add/enrich recruiters (with points rewards)
and search recruiters by company.

Anti-abuse rules live here rather than in points_service, since they are about
*whether this action is allowed at all* — not about ledger mechanics.
"""

import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import points_config
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.models import ActionType, PointsLedger, Recruiter, User
from app.services import points_service

router = APIRouter()

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Personal webmail domains are blocked — a "recruiter" contact must be reachable
# at a company address, or the directory fills up with unverifiable noise.
_BLOCKED_EMAIL_DOMAINS = {
    "gmail.com", "googlemail.com",
    "outlook.com", "hotmail.com", "hotmail.co.il", "live.com", "msn.com",
    "yahoo.com", "yahoo.co.il",
    "walla.co.il", "walla.com",
    "icloud.com", "me.com", "aol.com",
}


def _normalize_email(raw: str) -> str:
    return (raw or "").strip().lower()


def _normalize_company(raw: str) -> str:
    return " ".join((raw or "").strip().lower().split())


class RecruiterIn(BaseModel):
    full_name: str
    email: str
    company: str
    phone: str | None = None


def _serialize(r: Recruiter) -> dict:
    return {
        "id": r.id,
        "full_name": r.full_name,
        "email": r.email,
        "phone": r.phone,
        "company": r.company,
        "is_verified": r.is_verified,
    }


def _serialize_public(r: Recruiter) -> dict:
    """Search results never include the recruiter's email — it's only handed
    out by POST /api/emails/log-open, after a point has been charged."""
    return {
        "id": r.id,
        "full_name": r.full_name,
        "phone": r.phone,
        "company": r.company,
        "is_verified": r.is_verified,
    }


async def _daily_recruiter_credits_today(db: AsyncSession, user_id: int) -> int:
    # Naive UTC, matching how SQLite stores DateTime(timezone=True) values under
    # the server_default CURRENT_TIMESTAMP (no offset suffix).
    since = datetime.now(timezone.utc).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)
    result = await db.execute(
        select(func.count(PointsLedger.id)).where(
            PointsLedger.user_id == user_id,
            PointsLedger.action_type.in_([ActionType.RECRUITER_ADDED_NEW, ActionType.RECRUITER_ENRICHED]),
            PointsLedger.created_at >= since,
        )
    )
    return int(result.scalar_one())


async def _award_points(
    db: AsyncSession,
    user: User,
    recruiter: Recruiter,
    action_type: ActionType,
    amount: int,
    success_message: str,
    cap_message: str,
) -> tuple[int, str]:
    """Credits `amount` points for `action_type` on `recruiter`, unless the user
    already earned points for this exact recruiter+action (no double-dipping) or
    has hit today's recruiter-credit cap. Either way the recruiter record itself
    is still saved/updated by the caller — only the points are withheld."""
    ref_id = str(recruiter.id)

    dup = await db.execute(
        select(PointsLedger.id).where(
            PointsLedger.user_id == user.id,
            PointsLedger.ref_id == ref_id,
            PointsLedger.action_type == action_type,
        )
    )
    if dup.scalar_one_or_none() is not None:
        return 0, "כבר קיבלת נקודות על המגייס הזה."

    if await _daily_recruiter_credits_today(db, user.id) >= points_config.DAILY_RECRUITER_CAP:
        return 0, cap_message

    await points_service.credit(db, user.id, action_type, amount, ref_id=ref_id)
    return amount, success_message


@router.post("/api/recruiters")
async def add_recruiter(
    body: RecruiterIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    full_name = (body.full_name or "").strip()
    company = (body.company or "").strip()
    phone = (body.phone or "").strip() or None
    email = _normalize_email(body.email)

    if not full_name or not company:
        raise HTTPException(status_code=400, detail="נא למלא שם וחברה של המגייס.")
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="כתובת האימייל אינה תקינה.")
    domain = email.rsplit("@", 1)[-1]
    if domain in _BLOCKED_EMAIL_DOMAINS:
        raise HTTPException(
            status_code=400,
            detail="נדרש אימייל ארגוני של המגייס (לא כתובת פרטית כמו Gmail/Outlook).",
        )

    company_normalized = _normalize_company(company)

    result = await db.execute(select(Recruiter).where(Recruiter.email == email))
    existing = result.scalar_one_or_none()

    if existing is None:
        recruiter = Recruiter(
            full_name=full_name,
            email=email,
            phone=phone,
            company=company,
            company_normalized=company_normalized,
            added_by_user_id=user.id,
        )
        db.add(recruiter)
        try:
            await db.flush()
        except IntegrityError:
            # Lost a create race to a concurrent request for the same email.
            await db.rollback()
            result = await db.execute(select(Recruiter).where(Recruiter.email == email))
            existing = result.scalar_one_or_none()
            if existing is None:
                raise
        else:
            points_awarded, message = await _award_points(
                db, user, recruiter, ActionType.RECRUITER_ADDED_NEW, points_config.NEW_RECRUITER,
                f"נוסף למאגר! קיבלת {points_config.NEW_RECRUITER} נקודות.",
                "המגייס נוסף למאגר. הגעת למכסה היומית של נקודות — נסי שוב מחר.",
            )
            await db.commit()
            await db.refresh(recruiter)
            balance = await points_service.get_balance(db, user.id)
            return {
                "recruiter": _serialize(recruiter),
                "duplicate": False,
                "points_awarded": points_awarded,
                "balance": balance,
                "message": message,
            }

    # Existing recruiter: enrich missing fields, or plain duplicate.
    updated = False
    if not (existing.phone or "").strip() and phone:
        existing.phone = phone
        updated = True
    if not (existing.full_name or "").strip() and full_name:
        existing.full_name = full_name
        updated = True

    if not updated:
        balance = await points_service.get_balance(db, user.id)
        return {
            "recruiter": _serialize(existing),
            "duplicate": True,
            "points_awarded": 0,
            "balance": balance,
            "message": "המגייס כבר קיים במאגר.",
        }

    points_awarded, message = await _award_points(
        db, user, existing, ActionType.RECRUITER_ENRICHED, points_config.ENRICH_RECRUITER,
        f"עדכנת פרטי מגייס קיים! קיבלת {points_config.ENRICH_RECRUITER} נקודות.",
        "פרטי המגייס עודכנו. הגעת למכסה היומית של נקודות — נסי שוב מחר.",
    )
    await db.commit()
    await db.refresh(existing)
    balance = await points_service.get_balance(db, user.id)
    return {
        "recruiter": _serialize(existing),
        "duplicate": True,
        "points_awarded": points_awarded,
        "balance": balance,
        "message": message,
    }


@router.get("/api/recruiters/search")
async def search_recruiters(
    company: str = "",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    normalized = _normalize_company(company)
    if not normalized:
        return {"results": []}

    result = await db.execute(
        select(Recruiter)
        .where(
            or_(
                Recruiter.company_normalized == normalized,
                Recruiter.company_normalized.like(f"{normalized}%"),
            )
        )
        .order_by(Recruiter.company_normalized)
        .limit(10)
    )
    return {"results": [_serialize_public(r) for r in result.scalars().all()]}
