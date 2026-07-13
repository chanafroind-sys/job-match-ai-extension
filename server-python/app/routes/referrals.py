"""Employee referrals ("חבר-מביא-חבר"): eligibility check, request creation,
and the public accept/decline landing pages the employee reaches from their
notification email.

Privacy rule: GET /api/referrals/check must never return anything that
identifies the employee — only a boolean + the point cost. Employee details
are only ever used server-side (to send the notification email) or exposed to
the candidate after the employee has explicitly accepted (mutual exposure).
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import points_config
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.html_pages import render_landing_page
from app.core.models import ActionType, Employee, ReferralRequest, ReferralStatus, User
from app.services import email_service, points_service, referral_service, sync_service

router = APIRouter()

REFERRAL_COST = abs(points_config.REFERRAL_REQUEST)


def _normalize_company(raw: str) -> str:
    return " ".join((raw or "").strip().lower().split())


def _backend_url() -> str:
    # Deferred import — same reason as app/core/deps.py: main.py imports this
    # router at module load time, so a top-level "from main import BACKEND_URL"
    # would be circular.
    from main import BACKEND_URL

    return BACKEND_URL


@router.get("/api/referrals/check")
async def check_referral(
    company: str = "",
    score: int = 0,
    job_url_hash: str = "",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await sync_service.maybe_sync(db)
    await referral_service.expire_stale_referrals(db)

    company_normalized = _normalize_company(company)
    employee = await referral_service.find_eligible_employee(db, company_normalized, score)
    blocked = (
        await referral_service.has_active_request(db, user.id, job_url_hash)
        if job_url_hash else False
    )

    return {"available": employee is not None and not blocked, "cost": REFERRAL_COST}


class ReferralCreate(BaseModel):
    job_url_hash: str
    job_title: str = ""
    company: str = ""
    score: int = 0
    candidate_summary: str = ""


@router.post("/api/referrals")
async def create_referral(
    body: ReferralCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await referral_service.expire_stale_referrals(db)

    if not body.job_url_hash:
        raise HTTPException(status_code=400, detail="חסר מזהה משרה.")

    company_normalized = _normalize_company(body.company)
    employee = await referral_service.find_eligible_employee(db, company_normalized, body.score)
    if employee is None:
        raise HTTPException(status_code=400, detail="לא נמצא/ה עובד/ת זמין/ה להפניה בחברה זו.")

    if await referral_service.has_active_request(db, user.id, body.job_url_hash):
        raise HTTPException(status_code=409, detail="כבר קיימת בקשת הפניה פעילה למשרה הזו.")

    referral = ReferralRequest(
        user_id=user.id,
        employee_id=employee.id,
        job_url_hash=body.job_url_hash,
        job_title=(body.job_title or "")[:255] or None,
        company=(body.company or "")[:255] or None,
        match_score=body.score,
        status=ReferralStatus.PENDING,
        points_charged=REFERRAL_COST,
    )
    db.add(referral)
    await db.flush()

    try:
        await points_service.charge(
            db, user.id, ActionType.REFERRAL_REQUESTED, REFERRAL_COST, ref_id=str(referral.id),
        )
    except HTTPException as e:
        await db.rollback()
        if e.status_code == 402:
            raise HTTPException(status_code=402, detail="אין לך מספיק נקודות לבקשת הפניה.")
        raise

    await db.commit()
    await db.refresh(referral)

    base = _backend_url()
    try:
        await email_service.send_referral_notification(
            employee_email=employee.email,
            employee_name=employee.full_name,
            job_title=referral.job_title or "",
            company=referral.company or "",
            match_score=referral.match_score,
            candidate_summary=body.candidate_summary,
            accept_url=f"{base}/referral/{referral.token}/accept",
            decline_url=f"{base}/referral/{referral.token}/decline",
        )
    except Exception as e:
        # Best-effort: no retry queue exists in this codebase. The request
        # still exists and will auto-expire (with refund) after 7 days if the
        # employee never sees it.
        print(f"[referrals] notify failed for referral {referral.id}: {e}")

    balance = await points_service.get_balance(db, user.id)
    return {"success": True, "referral_id": referral.id, "status": referral.status.value, "balance": balance}


async def _load_referral(db: AsyncSession, token: str) -> ReferralRequest | None:
    result = await db.execute(select(ReferralRequest).where(ReferralRequest.token == token))
    return result.scalar_one_or_none()


@router.get("/referral/{token}/accept", response_class=HTMLResponse)
async def accept_referral(token: str, db: AsyncSession = Depends(get_db)):
    await referral_service.expire_stale_referrals(db)
    referral = await _load_referral(db, token)
    if referral is None:
        return render_landing_page("קישור לא תקין", "לא נמצאה בקשת הפניה מתאימה.")
    if referral.status != ReferralStatus.PENDING:
        return render_landing_page("הבקשה כבר טופלה", "הבקשה כבר טופלה")

    referral.status = ReferralStatus.ACCEPTED
    referral.resolved_at = datetime.now(timezone.utc)
    await db.commit()

    employee = await db.get(Employee, referral.employee_id)
    candidate = await db.get(User, referral.user_id)
    try:
        await email_service.send_mutual_exposure_emails(
            employee_email=employee.email if employee else "",
            employee_name=employee.full_name if employee else "",
            candidate_email=candidate.email if candidate else "",
            candidate_name="",
            job_title=referral.job_title or "",
            company=referral.company or "",
        )
    except Exception as e:
        print(f"[referrals] mutual exposure email failed for referral {referral.id}: {e}")

    return render_landing_page("הבקשה אושרה!", "פרטי הקשר נשלחו לשני הצדדים במייל. תודה שעזרת!")


@router.get("/referral/{token}/decline", response_class=HTMLResponse)
async def decline_referral(token: str, db: AsyncSession = Depends(get_db)):
    await referral_service.expire_stale_referrals(db)
    referral = await _load_referral(db, token)
    if referral is None:
        return render_landing_page("קישור לא תקין", "לא נמצאה בקשת הפניה מתאימה.")
    if referral.status != ReferralStatus.PENDING:
        return render_landing_page("הבקשה כבר טופלה", "הבקשה כבר טופלה")

    referral.status = ReferralStatus.DECLINED
    referral.resolved_at = datetime.now(timezone.utc)
    await points_service.refund(db, ref_id=str(referral.id))
    await db.commit()

    return render_landing_page("הבקשה נדחתה", "תודה על התגובה. הנקודות הוחזרו למועמד/ת.")
