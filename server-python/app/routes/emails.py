"""Recruiter outreach: draft a short cover email (haiku, cheap, no charge) and
log+bill the moment the user actually opens the pre-filled Gmail compose tab.

No OAuth, no Gmail API call, no automatic sending — see project README for why.
The recruiter's email address is only ever returned by log-open, after the
point charge succeeds, so a user can't harvest recruiter emails for free via
search.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import points_config
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.models import ActionType, Recruiter, SendLog, SendStatus, User
from app.services import points_service

router = APIRouter()

_MAX_LETTER_BODY_CHARS = 1500

RECRUITER_LETTER_PROMPT = """You are a job candidate writing a short, warm outreach email to a recruiter.

Write ONLY based on facts present in the candidate summary below — never invent skills, employers, titles or achievements that aren't there.

Requirements:
- First-person voice, addressed to the recruiter by name if given
- Maximum ~130 words in the body
- Mention the specific job title and why the candidate is a good fit, grounded only in the candidate summary
- Warm, confident, concise — not generic or formulaic
- Write the ENTIRE email (subject and body) in {language}
- The subject line MUST include the job title
- Do NOT include placeholders like [Your Name] — sign off naturally using the name found in the candidate summary if present, otherwise omit a signature name
- Do NOT include a "Dear recruiter" line if recruiterName is empty — instead open naturally

Return ONLY valid JSON — no markdown, no extra text:
{{"subject": "<subject line>", "body": "<email body, plain text, no markdown>"}}

=== RECRUITER NAME ===
{recruiter_name}

=== JOB TITLE ===
{job_title}

=== COMPANY ===
{company}

=== CANDIDATE SUMMARY ===
{cv_summary}

=== JOB POSTING (excerpt) ===
{job_text}"""


class RecruiterLetterRequest(BaseModel):
    jobTitle: str = ""
    company: str = ""
    jobText: str = ""
    recruiterName: str = ""
    cvSummary: str = ""


@router.post("/api/recruiter-letter")
async def draft_recruiter_letter(
    body: RecruiterLetterRequest,
    user: User = Depends(get_current_user),
):
    from main import call_claude, parse_json_response

    job_text = (body.jobText or "")[:2000]
    he_chars = sum(1 for c in job_text[:300] if "א" <= c <= "ת")
    language = "Hebrew" if he_chars > 15 else "English"

    prompt = RECRUITER_LETTER_PROMPT.format(
        language=language,
        recruiter_name=body.recruiterName.strip() or "(unknown)",
        job_title=body.jobTitle.strip() or "(unknown)",
        company=body.company.strip() or "(unknown)",
        cv_summary=(body.cvSummary or "").strip() or "(no summary provided)",
        job_text=job_text,
    )

    raw = await call_claude(prompt, max_tokens=700, model="claude-haiku-4-5-20251001")
    try:
        parsed = parse_json_response(raw)
    except Exception:
        raise HTTPException(status_code=422, detail="לא הצלחנו לנסח מכתב. נסי שוב.")

    subject = str(parsed.get("subject", "")).strip()
    text = str(parsed.get("body", "")).strip()[:_MAX_LETTER_BODY_CHARS]
    if not subject or not text:
        raise HTTPException(status_code=422, detail="לא הצלחנו לנסח מכתב. נסי שוב.")

    return {"subject": subject, "body": text}


class LogOpenRequest(BaseModel):
    recruiter_id: int
    job_url_hash: str
    job_title: str = ""
    company: str = ""


@router.post("/api/emails/log-open")
async def log_email_open(
    body: LogOpenRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Recruiter).where(Recruiter.id == body.recruiter_id))
    recruiter = result.scalar_one_or_none()
    if recruiter is None:
        raise HTTPException(status_code=404, detail="המגייס/ת לא נמצא/ה במאגר.")

    dup = await db.execute(
        select(SendLog.id).where(
            SendLog.user_id == user.id,
            SendLog.recruiter_id == body.recruiter_id,
            SendLog.job_url_hash == body.job_url_hash,
        )
    )
    if dup.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="כבר הכנת מייל למגייס הזה על המשרה הזו.")

    try:
        await points_service.charge(
            db, user.id, ActionType.EMAIL_SENT,
            abs(points_config.EMAIL_SEND),
            ref_id=f"{body.recruiter_id}:{body.job_url_hash}",
        )
    except HTTPException as e:
        if e.status_code == 402:
            raise HTTPException(
                status_code=402,
                detail="אין לך מספיק נקודות להכנת מייל למגייס. עברי למסך המגייסים כדי לצבור עוד נקודות.",
            )
        raise

    db.add(SendLog(
        user_id=user.id,
        recruiter_id=body.recruiter_id,
        job_url_hash=body.job_url_hash,
        job_title=(body.job_title or "")[:255] or None,
        company=(body.company or "")[:255] or None,
        status=SendStatus.OPENED,
    ))
    try:
        await db.commit()
    except IntegrityError:
        # Lost a race to a concurrent request for the same user+recruiter+job —
        # the point we just charged must be refunded, since only one send_log
        # row (and one charge) is allowed to win.
        await db.rollback()
        await points_service.refund(db, ref_id=f"{body.recruiter_id}:{body.job_url_hash}")
        await db.commit()
        raise HTTPException(status_code=409, detail="כבר הכנת מייל למגייס הזה על המשרה הזו.")

    balance = await points_service.get_balance(db, user.id)
    return {"email": recruiter.email, "balance": balance}
