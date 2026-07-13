"""Community recruiter directory: add/enrich recruiters (with points rewards)
and search recruiters by company. Also the admin bulk-import endpoint, which
reuses the same validation/dedup logic without the points side effects.

Anti-abuse rules live here rather than in points_service, since they are about
*whether this action is allowed at all* — not about ledger mechanics.
"""

import re
from datetime import datetime, timezone
from io import BytesIO

import openpyxl
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import points_config
from app.core.db import get_db
from app.core.deps import get_current_user, require_admin
from app.core.models import ActionType, PointsLedger, Recruiter, User
from app.services import points_service

router = APIRouter()

MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024
MAX_IMPORT_ROWS = 2000
IMPORT_REQUIRED_COLUMNS = {"full_name", "email", "company"}

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


async def upsert_recruiter(
    db: AsyncSession,
    *,
    full_name: str,
    email: str,
    company: str,
    phone: str | None,
    added_by_user_id: int,
    is_verified: bool = False,
) -> tuple[Recruiter, bool, bool]:
    """Validates + normalizes a single recruiter's fields, then creates it or
    enriches the existing row for that email. Raises HTTPException(400) for
    invalid input — callers decide whether that aborts the whole request (the
    single-add endpoint) or is caught per-row (the bulk importer).

    Returns (recruiter, created, updated). `updated` reflects only name/phone
    enrichment, not the is_verified bump below — that only matters for the
    import's reporting, which considers "verify an already-complete row"
    a duplicate, not an enrichment.
    """
    full_name = (full_name or "").strip()
    company = (company or "").strip()
    phone = (phone or "").strip() or None
    email = _normalize_email(email)

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
            added_by_user_id=added_by_user_id,
            is_verified=is_verified,
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
            return recruiter, True, False

    # Existing recruiter: enrich missing fields, or plain duplicate.
    updated = False
    if not (existing.phone or "").strip() and phone:
        existing.phone = phone
        updated = True
    if not (existing.full_name or "").strip() and full_name:
        existing.full_name = full_name
        updated = True
    if is_verified and not existing.is_verified:
        existing.is_verified = True

    return existing, False, updated


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
    recruiter, created, updated = await upsert_recruiter(
        db,
        full_name=body.full_name,
        email=body.email,
        company=body.company,
        phone=body.phone,
        added_by_user_id=user.id,
    )

    if created:
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

    if not updated:
        balance = await points_service.get_balance(db, user.id)
        return {
            "recruiter": _serialize(recruiter),
            "duplicate": True,
            "points_awarded": 0,
            "balance": balance,
            "message": "המגייס כבר קיים במאגר.",
        }

    points_awarded, message = await _award_points(
        db, user, recruiter, ActionType.RECRUITER_ENRICHED, points_config.ENRICH_RECRUITER,
        f"עדכנת פרטי מגייס קיים! קיבלת {points_config.ENRICH_RECRUITER} נקודות.",
        "פרטי המגייס עודכנו. הגעת למכסה היומית של נקודות — נסי שוב מחר.",
    )
    await db.commit()
    await db.refresh(recruiter)
    balance = await points_service.get_balance(db, user.id)
    return {
        "recruiter": _serialize(recruiter),
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


def _import_row_cell(row: tuple, header_map: dict[str, int], key: str) -> str | None:
    idx = header_map.get(key)
    if idx is None or idx >= len(row):
        return None
    value = row[idx]
    return str(value).strip() if value is not None else None


@router.post("/api/admin/recruiters/import")
async def import_recruiters(
    file: UploadFile = File(...),
    user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    content = await file.read()
    if len(content) > MAX_IMPORT_FILE_BYTES:
        raise HTTPException(status_code=413, detail="הקובץ גדול מדי (מקסימום 2MB).")

    try:
        workbook = openpyxl.load_workbook(BytesIO(content), read_only=True, data_only=True)
        sheet = workbook.active
        rows = sheet.iter_rows(values_only=True)
        header = next(rows)
    except StopIteration:
        raise HTTPException(status_code=422, detail="הקובץ ריק.")
    except Exception:
        raise HTTPException(status_code=422, detail="לא ניתן לקרוא את הקובץ. יש להעלות קובץ Excel (.xlsx) תקין.")

    header_map = {
        str(name or "").strip().lower(): idx
        for idx, name in enumerate(header or [])
        if str(name or "").strip()
    }
    missing_columns = IMPORT_REQUIRED_COLUMNS - header_map.keys()
    if missing_columns:
        raise HTTPException(
            status_code=422,
            detail=f"עמודות חסרות בקובץ: {', '.join(sorted(missing_columns))}",
        )

    data_rows = [row for row in rows if row is not None and any(cell is not None for cell in row)]
    if len(data_rows) > MAX_IMPORT_ROWS:
        raise HTTPException(status_code=422, detail=f"יותר מדי שורות בקובץ (מקסימום {MAX_IMPORT_ROWS}).")

    report: dict = {"created": 0, "enriched": 0, "skipped_duplicates": 0, "errors": []}

    for row_num, row in enumerate(data_rows, start=2):  # row 1 is the header
        try:
            _, created, updated = await upsert_recruiter(
                db,
                full_name=_import_row_cell(row, header_map, "full_name") or "",
                email=_import_row_cell(row, header_map, "email") or "",
                company=_import_row_cell(row, header_map, "company") or "",
                phone=_import_row_cell(row, header_map, "phone"),
                added_by_user_id=user.id,
                is_verified=True,
            )
            await db.commit()
        except HTTPException as exc:
            # upsert_recruiter raises HTTPException only from up-front validation,
            # before touching the session, so there is nothing to roll back here.
            # (Calling db.rollback() would expire every loaded object — including
            # `user` — forcing a synchronous re-fetch on the next attribute access
            # and blowing up with MissingGreenlet outside of an awaited context.)
            report["errors"].append({"row": row_num, "reason": exc.detail})
            continue

        if created:
            report["created"] += 1
        elif updated:
            report["enriched"] += 1
        else:
            report["skipped_duplicates"] += 1

    return report
