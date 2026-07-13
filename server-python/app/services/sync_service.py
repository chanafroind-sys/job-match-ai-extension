"""Lazy sync of the employees Google Sheet (published as CSV) into the
`employees` table.

Render's free tier has no cron jobs, so instead of a scheduled task this runs
opportunistically: GET /api/referrals/check calls maybe_sync() on every
request, and it's a no-op unless more than an hour has passed since the last
successful pull. A fetch/parse/upsert failure is logged and simply retried on
the next call — last_synced_at is only advanced on success.
"""

import csv
import io
import os
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.models import Employee, EmployeeSource, OptInStatus, SyncMeta

SYNC_KEY = "employees_sheet"
SYNC_INTERVAL = timedelta(hours=1)

EMPLOYEES_SHEET_CSV_URL = os.getenv("EMPLOYEES_SHEET_CSV_URL", "")


def _normalize_company(raw: str) -> str:
    return " ".join((raw or "").strip().lower().split())


def _normalize_email(raw: str) -> str:
    return (raw or "").strip().lower()


def _get_field(row: dict, *names: str) -> str:
    """Google Forms column headers are the literal question text — look them
    up case/whitespace-insensitively so a small wording tweak in the form
    doesn't silently break the sync."""
    lookup = {" ".join(k.strip().lower().split()): v for k, v in row.items() if k}
    for name in names:
        key = " ".join(name.strip().lower().split())
        if key in lookup:
            return (lookup[key] or "").strip()
    return ""


def _parse_threshold(raw: str) -> int:
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        return 75
    return value if value > 0 else 75


def _parse_domains(raw: str) -> list[str] | None:
    if not raw:
        return None
    parts = [p.strip() for p in raw.replace(";", ",").split(",")]
    return [p for p in parts if p] or None


def _parse_opt_in(raw: str) -> bool:
    # A Google Forms single-checkbox question exports the checked option's
    # label text, or an empty string when unchecked.
    return bool((raw or "").strip())


async def _get_or_create_meta(db: AsyncSession) -> SyncMeta:
    result = await db.execute(select(SyncMeta).where(SyncMeta.key == SYNC_KEY))
    meta = result.scalar_one_or_none()
    if meta is None:
        meta = SyncMeta(key=SYNC_KEY, last_synced_at=None)
        db.add(meta)
        await db.flush()
    return meta


async def maybe_sync(db: AsyncSession) -> None:
    """No-op unless EMPLOYEES_SHEET_CSV_URL is configured and the last sync is
    stale. Commits its own transaction, independent of whatever the caller is
    doing — a sync failure must never break the eligibility check that
    triggered it."""
    if not EMPLOYEES_SHEET_CSV_URL:
        return

    meta = await _get_or_create_meta(db)
    now = datetime.now(timezone.utc)
    last = meta.last_synced_at
    if last is not None:
        last_aware = last if last.tzinfo else last.replace(tzinfo=timezone.utc)
        if now - last_aware < SYNC_INTERVAL:
            return

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(EMPLOYEES_SHEET_CSV_URL)
            resp.raise_for_status()
            rows = list(csv.DictReader(io.StringIO(resp.text)))
    except Exception as e:
        print(f"[sync_service] employees sheet fetch failed: {e}")
        return

    try:
        await _upsert_rows(db, rows)
        meta.last_synced_at = now
        await db.commit()
    except Exception as e:
        print(f"[sync_service] employees sheet upsert failed: {e}")
        await db.rollback()


async def _upsert_rows(db: AsyncSession, rows: list[dict]) -> None:
    for row in rows:
        email = _normalize_email(_get_field(row, "Email", "Email Address"))
        if not email:
            continue
        source_row_id = email  # natural key — a resubmission updates the same employee

        full_name = _get_field(row, "Name", "Full Name")
        company = _get_field(row, "Company")
        company_normalized = _normalize_company(company)
        domains = _parse_domains(_get_field(row, "Fields of Expertise", "Field of Expertise"))
        min_match_threshold = _parse_threshold(
            _get_field(row, "Minimum Score Threshold", "Minimum Match Threshold")
        )
        is_opted_in = _parse_opt_in(_get_field(row, "Opt-in Checkbox", "Opt-in", "Opt In"))

        opt_in_status = OptInStatus.ACCEPTED if is_opted_in else OptInStatus.PENDING

        result = await db.execute(select(Employee).where(Employee.source_row_id == source_row_id))
        employee = result.scalar_one_or_none()
        if employee is None:
            db.add(Employee(
                full_name=full_name,
                company=company,
                company_normalized=company_normalized,
                email=email,
                domains=domains,
                min_match_threshold=min_match_threshold,
                source=EmployeeSource.SHEET,
                opt_in_status=opt_in_status,
                source_row_id=source_row_id,
            ))
        else:
            employee.full_name = full_name or employee.full_name
            employee.company = company or employee.company
            employee.company_normalized = company_normalized or employee.company_normalized
            employee.domains = domains
            employee.min_match_threshold = min_match_threshold
            employee.opt_in_status = opt_in_status
    await db.flush()
