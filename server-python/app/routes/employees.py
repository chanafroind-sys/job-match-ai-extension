"""Employee directory entry points: public self-registration, community add,
and the opt-in consent flow.

Unlike recruiters.upsert_recruiter, upsert_employee never touches
opt_in_status on the existing-row branch — self-registration, community-add,
and admin-import each have different rules for what a re-add should do to a
row's consent state, so that decision is made by each caller instead.
"""

import re

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import points_config
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.html_pages import CARD_STYLE
from app.core.models import ActionType, Employee, EmployeeSource, OptInStatus, User
from app.core.rate_limit import check_and_record
from app.services import points_service
from app.services.sync_service import _parse_domains

router = APIRouter()

RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW_SECONDS = 3600

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalize_email(raw: str) -> str:
    return (raw or "").strip().lower()


def _normalize_company(raw: str) -> str:
    return " ".join((raw or "").strip().lower().split())


async def upsert_employee(
    db: AsyncSession,
    *,
    full_name: str,
    company: str,
    email: str,
    domains: str,
    min_match_threshold: int,
    added_by_user_id: int | None,
    source: EmployeeSource,
) -> tuple[Employee, bool, bool]:
    """Validates + normalizes a single employee's fields, then creates it or
    enriches the existing row for that email. Raises HTTPException(400) for
    invalid input. Returns (employee, created, updated) — `updated` reflects
    only field enrichment, never opt_in_status (callers own that decision).
    """
    full_name = (full_name or "").strip()
    company = (company or "").strip()
    email = _normalize_email(email)
    parsed_domains = _parse_domains(domains)
    threshold = min_match_threshold if min_match_threshold and min_match_threshold > 0 else 75

    if not full_name or not company:
        raise HTTPException(status_code=400, detail="נא למלא שם וחברה של העובד/ת.")
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="כתובת האימייל אינה תקינה.")

    company_normalized = _normalize_company(company)

    result = await db.execute(select(Employee).where(Employee.email == email))
    existing = result.scalar_one_or_none()

    if existing is None:
        employee = Employee(
            full_name=full_name,
            company=company,
            company_normalized=company_normalized,
            email=email,
            domains=parsed_domains,
            min_match_threshold=threshold,
            added_by_user_id=added_by_user_id,
            source=source,
        )
        db.add(employee)
        try:
            await db.flush()
        except IntegrityError:
            # Lost a create race to a concurrent request for the same email.
            await db.rollback()
            result = await db.execute(select(Employee).where(Employee.email == email))
            existing = result.scalar_one_or_none()
            if existing is None:
                raise
        else:
            return employee, True, False

    # Existing employee: enrich missing fields, or plain duplicate.
    updated = False
    if not (existing.full_name or "").strip() and full_name:
        existing.full_name = full_name
        updated = True
    if not existing.domains and parsed_domains:
        existing.domains = parsed_domains
        updated = True

    return existing, False, updated


class EmployeeIn(BaseModel):
    full_name: str
    company: str
    email: str
    domains: str = ""
    min_match_threshold: int = 75


def _serialize_employee(e: Employee) -> dict:
    return {
        "id": e.id,
        "full_name": e.full_name,
        "company": e.company,
        "email": e.email,
        "opt_in_status": e.opt_in_status.value,
    }


@router.post("/api/employees")
async def add_employee(
    body: EmployeeIn,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    employee, created, updated = await upsert_employee(
        db,
        full_name=body.full_name,
        company=body.company,
        email=body.email,
        domains=body.domains,
        min_match_threshold=body.min_match_threshold,
        added_by_user_id=user.id,
        source=EmployeeSource.COMMUNITY,
    )

    if created:
        employee.opt_in_status = OptInStatus.PENDING
        points_awarded, message = await points_service.award_directory_points(
            db, user, str(employee.id), ActionType.EMPLOYEE_ADDED_NEW, points_config.NEW_EMPLOYEE,
            f"נוסף/ה למאגר! קיבלת {points_config.NEW_EMPLOYEE} נקודות.",
            "העובד/ת נוסף/ה למאגר. הגעת למכסה היומית של נקודות — נסי שוב מחר.",
        )
        await db.commit()
        await db.refresh(employee)
        balance = await points_service.get_balance(db, user.id)
        return {
            "employee": _serialize_employee(employee),
            "duplicate": False,
            "points_awarded": points_awarded,
            "balance": balance,
            "message": message,
        }

    if not updated:
        balance = await points_service.get_balance(db, user.id)
        return {
            "employee": _serialize_employee(employee),
            "duplicate": True,
            "points_awarded": 0,
            "balance": balance,
            "message": "העובד/ת כבר קיימ/ת במאגר.",
        }

    # A re-add of an employee who already declined must not re-trigger
    # anything opt-in related (upsert_employee never touches opt_in_status),
    # but field enrichment — and its points — still applies normally.
    points_awarded, message = await points_service.award_directory_points(
        db, user, str(employee.id), ActionType.EMPLOYEE_ENRICHED, points_config.ENRICH_EMPLOYEE,
        f"עדכנת פרטי עובד/ת קיימ/ת! קיבלת {points_config.ENRICH_EMPLOYEE} נקודות.",
        "פרטי העובד/ת עודכנו. הגעת למכסה היומית של נקודות — נסי שוב מחר.",
    )
    await db.commit()
    await db.refresh(employee)
    balance = await points_service.get_balance(db, user.id)
    return {
        "employee": _serialize_employee(employee),
        "duplicate": True,
        "points_awarded": points_awarded,
        "balance": balance,
        "message": message,
    }


class EmployeeRegisterIn(BaseModel):
    full_name: str
    company: str
    email: str
    domains: str = ""
    min_match_threshold: int = 75
    consent: bool = False
    website: str = ""  # honeypot — real users never see or fill this field


@router.post("/api/public/employees/register")
async def register_employee(
    body: EmployeeRegisterIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    if (body.website or "").strip():
        # Honeypot tripped — pretend success so scripted submitters can't
        # tell the difference from a real registration.
        return {"success": True}

    client_ip = request.client.host if request.client else "unknown"
    if not check_and_record("register_employee", client_ip, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SECONDS):
        raise HTTPException(status_code=429, detail="יותר מדי בקשות. נסה/י שוב בעוד שעה.")

    if not body.consent:
        raise HTTPException(status_code=400, detail="יש לאשר את תנאי ההצטרפות כדי להירשם.")

    employee, created, updated = await upsert_employee(
        db,
        full_name=body.full_name,
        company=body.company,
        email=body.email,
        domains=body.domains,
        min_match_threshold=body.min_match_threshold,
        added_by_user_id=None,
        source=EmployeeSource.SELF,
    )
    # Self-registration is inherent consent, regardless of prior state.
    employee.opt_in_status = OptInStatus.ACCEPTED
    await db.commit()

    return {"success": True, "message": "נרשמת בהצלחה למאגר חבר-מביא-חבר!"}


_JOIN_FORM_HTML = f"""<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<title>הצטרפות למאגר חבר-מביא-חבר — Job Match AI</title>
<style>
{CARD_STYLE}
.card {{ max-width: 480px; text-align: right; width: 90%; }}
h1 {{ text-align: center; }}
input[type=text], input[type=email], input[type=number] {{
  width: 100%; box-sizing: border-box; padding: 10px 12px; margin: 6px 0 14px;
  border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit;
}}
label {{ font-size: 13px; color: #333; }}
.consent-row {{ display: flex; align-items: flex-start; gap: 8px; margin: 12px 0; }}
.consent-row input {{ margin-top: 3px; }}
button {{ width: 100%; padding: 12px; border: none; border-radius: 8px; background: #2563EB;
  color: #fff; font-size: 15px; cursor: pointer; }}
button:disabled {{ opacity: .6; cursor: default; }}
#msg {{ margin-top: 14px; text-align: center; font-size: 14px; }}
.website-field {{ position: absolute; left: -9999px; top: -9999px; }}
</style>
</head>
<body>
<div class="card">
<h1>הצטרפות למאגר חבר-מביא-חבר</h1>
<p>עובד/ת בחברה? הצטרפ/י כדי לעזור למועמדים דרך Job Match AI למצוא איש קשר בחברה שלך.</p>
<form id="joinForm">
  <label>שם מלא</label>
  <input type="text" id="full_name" required>
  <label>שם החברה</label>
  <input type="text" id="company" required>
  <label>אימייל ארגוני</label>
  <input type="email" id="email" required style="direction:ltr;text-align:left">
  <label>תחומי עניין/מומחיות (אופציונלי, מופרד בפסיקים)</label>
  <input type="text" id="domains">
  <label>סף התאמה מינימלי להפניה (%)</label>
  <input type="number" id="min_match_threshold" value="75" min="1" max="100">
  <div class="consent-row">
    <input type="checkbox" id="consent" required>
    <label for="consent">אני מסכימ/ה להיכלל במאגר ולקבל בקשות הפניה למועמדים מתאימים דרך Job Match AI.</label>
  </div>
  <div class="website-field">
    <label>Website</label>
    <input type="text" id="website" name="website" tabindex="-1" autocomplete="off">
  </div>
  <button type="submit" id="submitBtn">הצטרפ/י</button>
</form>
<div id="msg"></div>
</div>
<script>
document.getElementById('joinForm').addEventListener('submit', async (e) => {{
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  msg.textContent = '';
  try {{
    const resp = await fetch('/api/public/employees/register', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{
        full_name: document.getElementById('full_name').value,
        company: document.getElementById('company').value,
        email: document.getElementById('email').value,
        domains: document.getElementById('domains').value,
        min_match_threshold: parseInt(document.getElementById('min_match_threshold').value, 10) || 75,
        consent: document.getElementById('consent').checked,
        website: document.getElementById('website').value,
      }}),
    }});
    const data = await resp.json();
    if (!resp.ok) {{
      msg.style.color = '#b91c1c';
      msg.textContent = data.detail || 'משהו השתבש. נסה/י שוב.';
    }} else {{
      msg.style.color = '#15803d';
      msg.textContent = data.message || 'נרשמת בהצלחה!';
      document.getElementById('joinForm').reset();
    }}
  }} catch (err) {{
    msg.style.color = '#b91c1c';
    msg.textContent = 'משהו השתבש. נסה/י שוב.';
  }}
  btn.disabled = false;
}});
</script>
</body>
</html>"""


@router.get("/join-referrers")
async def join_referrers_page():
    return HTMLResponse(content=_JOIN_FORM_HTML)
