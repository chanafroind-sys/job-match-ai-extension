"""Standalone web admin console (`GET /admin`) plus the stats/export/import
endpoints it calls. Kept in its own module, separate from recruiters.py's
existing (tested) admin import endpoint, to isolate the new admin-surface
risk from that working code path.

`GET /admin` itself is unauthenticated at the route level by design — it's a
static HTML/JS shell with no embedded data. The page does its own
license-key handshake client-side (stored only in sessionStorage) and every
subsequent fetch carries that key as `x-license-key`; all real authorization
happens server-side, per call, via require_admin.
"""

import csv
import io
from io import BytesIO

import openpyxl
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import require_admin
from app.core.html_pages import CARD_STYLE
from app.core.import_limits import MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS, import_row_cell
from app.core.models import (
    Employee,
    EmployeeSource,
    OptInStatus,
    PointsLedger,
    Recruiter,
    ReferralRequest,
    SendLog,
    SendStatus,
    User,
)
from app.routes.employees import upsert_employee

router = APIRouter()

EMPLOYEE_IMPORT_REQUIRED_COLUMNS = {"full_name", "email", "company"}


@router.get("/api/admin/stats")
async def admin_stats(user: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    recruiters_total = (await db.execute(select(func.count(Recruiter.id)))).scalar_one()
    recruiters_verified = (
        await db.execute(select(func.count(Recruiter.id)).where(Recruiter.is_verified.is_(True)))
    ).scalar_one()

    employees_by_opt_in = dict(
        (await db.execute(
            select(Employee.opt_in_status, func.count(Employee.id)).group_by(Employee.opt_in_status)
        )).all()
    )
    employees_by_source = dict(
        (await db.execute(
            select(Employee.source, func.count(Employee.id)).group_by(Employee.source)
        )).all()
    )

    users_total = (await db.execute(select(func.count(User.id)))).scalar_one()

    points_issued = (
        await db.execute(select(func.coalesce(func.sum(PointsLedger.delta), 0)).where(PointsLedger.delta > 0))
    ).scalar_one()
    points_spent = (
        await db.execute(select(func.coalesce(func.sum(PointsLedger.delta), 0)).where(PointsLedger.delta < 0))
    ).scalar_one()

    emails_opened = (
        await db.execute(select(func.count(SendLog.id)).where(SendLog.status == SendStatus.OPENED))
    ).scalar_one()

    referrals_by_status = dict(
        (await db.execute(
            select(ReferralRequest.status, func.count(ReferralRequest.id)).group_by(ReferralRequest.status)
        )).all()
    )

    return {
        "recruiters": {"total": recruiters_total, "verified": recruiters_verified},
        "employees": {
            "by_opt_in_status": {k.value: v for k, v in employees_by_opt_in.items()},
            "by_source": {k.value: v for k, v in employees_by_source.items()},
        },
        "users": {"total": users_total},
        "points": {"issued": int(points_issued), "spent": int(abs(points_spent))},
        "emails": {"opened": emails_opened},
        "referral_requests": {"by_status": {k.value: v for k, v in referrals_by_status.items()}},
    }


@router.get("/api/admin/recruiters/export")
async def export_recruiters(user: User = Depends(require_admin), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Recruiter).order_by(Recruiter.id))
    recruiters = result.scalars().all()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["full_name", "email", "phone", "company", "is_verified", "created_at"])
    for r in recruiters:
        writer.writerow([r.full_name, r.email, r.phone or "", r.company, r.is_verified, r.created_at])

    return Response(content=buf.getvalue(), media_type="text/csv", headers={
        "Content-Disposition": "attachment; filename=recruiters.csv",
    })


@router.post("/api/admin/employees/import")
async def import_employees(
    file: UploadFile = File(...),
    consented: bool = Form(...),
    user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Same limits/parsing/per-row-error-report/upsert semantics as
    recruiters.import_recruiters. `consented` is an explicit admin-set flag
    ("these contacts registered/consented") — it controls the resulting
    opt_in_status, but this path never sends an invitation email regardless
    of its value: consented=True rows are immediately referral-eligible,
    consented=False rows stay dormant (pending) until someone else re-adds
    them through the community flow, which does email.
    """
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
    missing_columns = EMPLOYEE_IMPORT_REQUIRED_COLUMNS - header_map.keys()
    if missing_columns:
        raise HTTPException(
            status_code=422,
            detail=f"עמודות חסרות בקובץ: {', '.join(sorted(missing_columns))}",
        )

    data_rows = [row for row in rows if row is not None and any(cell is not None for cell in row)]
    if len(data_rows) > MAX_IMPORT_ROWS:
        raise HTTPException(status_code=422, detail=f"יותר מדי שורות בקובץ (מקסימום {MAX_IMPORT_ROWS}).")

    opt_in_status = OptInStatus.ACCEPTED if consented else OptInStatus.PENDING
    report: dict = {"created": 0, "enriched": 0, "skipped_duplicates": 0, "errors": []}

    for row_num, row in enumerate(data_rows, start=2):  # row 1 is the header
        try:
            raw_threshold = import_row_cell(row, header_map, "min_match_threshold")
            try:
                threshold = int(float(raw_threshold)) if raw_threshold else 75
            except ValueError:
                threshold = 75

            employee, created, updated = await upsert_employee(
                db,
                full_name=import_row_cell(row, header_map, "full_name") or "",
                company=import_row_cell(row, header_map, "company") or "",
                email=import_row_cell(row, header_map, "email") or "",
                domains=import_row_cell(row, header_map, "domains") or "",
                min_match_threshold=threshold,
                added_by_user_id=user.id,
                source=EmployeeSource.IMPORT,
            )
            if created:
                employee.opt_in_status = opt_in_status
            await db.commit()
        except HTTPException as exc:
            report["errors"].append({"row": row_num, "reason": exc.detail})
            continue

        if created:
            report["created"] += 1
        elif updated:
            report["enriched"] += 1
        else:
            report["skipped_duplicates"] += 1

    return report


_ADMIN_PAGE_HTML = f"""<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<title>מסוף ניהול — Job Match AI</title>
<style>
{CARD_STYLE}
body {{ align-items: flex-start; padding: 24px; box-sizing: border-box; }}
.card {{ max-width: 720px; width: 100%; margin: 0 auto; text-align: right; }}
h1 {{ text-align: center; }}
input[type=password] {{
  width: 100%; box-sizing: border-box; padding: 10px 12px; margin: 6px 0 14px;
  border: 1px solid #ddd; border-radius: 8px; font-size: 14px; direction: ltr;
}}
button {{ padding: 10px 16px; border: none; border-radius: 8px; background: #2563EB;
  color: #fff; font-size: 14px; cursor: pointer; }}
button.secondary {{ background: #6b7280; }}
button:disabled {{ opacity: .6; cursor: default; }}
.hidden {{ display: none; }}
table {{ width: 100%; border-collapse: collapse; margin: 10px 0 20px; font-size: 13px; }}
th, td {{ text-align: right; padding: 6px 8px; border-bottom: 1px solid #eee; }}
.drop-zone {{ border: 2px dashed #ccc; border-radius: 10px; padding: 24px; text-align: center;
  color: #666; margin: 10px 0; }}
.drop-zone.drag {{ border-color: #2563EB; color: #2563EB; }}
select {{ padding: 8px; border-radius: 8px; border: 1px solid #ddd; margin-inline-end: 8px; }}
.row {{ display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 8px 0; }}
#report {{ font-size: 12px; white-space: pre-wrap; background: #f7f7f8; padding: 10px; border-radius: 8px; }}
</style>
</head>
<body>
<div class="card">
<h1>🔧 מסוף ניהול</h1>

<div id="loginSection">
  <label>מפתח רישיון של מנהל/ת</label>
  <input type="password" id="adminKeyInput" autocomplete="off">
  <button id="btnLogin">כניסה</button>
  <div id="loginMsg" style="margin-top:10px;color:#b91c1c"></div>
</div>

<div id="dashboardSection" class="hidden">
  <div class="row" style="justify-content:space-between">
    <strong>סטטיסטיקות</strong>
    <button class="secondary" id="btnLogout">התנתקות</button>
  </div>
  <table id="statsTable"></table>

  <strong>ייבוא מקובץ Excel</strong>
  <div class="row">
    <select id="entityType">
      <option value="recruiters">מגייסים</option>
      <option value="employees">עובדים (חבר מביא חבר)</option>
    </select>
    <label id="consentLabel" class="hidden">
      <input type="checkbox" id="consentToggle"> אנשי הקשר האלה נרשמו/הסכימו (אחרת יסומנו כ"ממתין")
    </label>
  </div>
  <div class="drop-zone" id="dropZone">גררו קובץ .xlsx לכאן, או <label style="color:#2563EB;cursor:pointer">בחרו קובץ<input type="file" id="fileInput" accept=".xlsx" class="hidden"></label></div>
  <div id="report"></div>

  <div class="row" style="margin-top:16px">
    <strong>ייצוא</strong>
    <button id="btnExport">📤 ייצוא מגייסים ל-CSV</button>
  </div>
</div>

</div>
<script>
function getKey() {{ return sessionStorage.getItem('jma_admin_key') || ''; }}
function setKey(k) {{ sessionStorage.setItem('jma_admin_key', k); }}
function clearKey() {{ sessionStorage.removeItem('jma_admin_key'); }}

async function apiFetch(path, opts) {{
  opts = opts || {{}};
  opts.headers = Object.assign({{}}, opts.headers, {{ 'x-license-key': getKey() }});
  return fetch(path, opts);
}}

function renderStats(stats) {{
  const rows = [];
  rows.push(['מגייסים (סה"כ / מאומתים)', `${{stats.recruiters.total}} / ${{stats.recruiters.verified}}`]);
  rows.push(['עובדים לפי מצב אישור', JSON.stringify(stats.employees.by_opt_in_status)]);
  rows.push(['עובדים לפי מקור', JSON.stringify(stats.employees.by_source)]);
  rows.push(['משתמשים', stats.users.total]);
  rows.push(['נקודות (הונפקו / נוצלו)', `${{stats.points.issued}} / ${{stats.points.spent}}`]);
  rows.push(['מיילים שנפתחו', stats.emails.opened]);
  rows.push(['בקשות הפניה לפי סטטוס', JSON.stringify(stats.referral_requests.by_status)]);
  document.getElementById('statsTable').innerHTML =
    rows.map(r => `<tr><td>${{r[0]}}</td><td>${{r[1]}}</td></tr>`).join('');
}}

async function loadStats() {{
  const resp = await apiFetch('/api/admin/stats');
  if (!resp.ok) return false;
  renderStats(await resp.json());
  return true;
}}

document.getElementById('btnLogin').addEventListener('click', async () => {{
  const key = document.getElementById('adminKeyInput').value.trim();
  const msg = document.getElementById('loginMsg');
  msg.textContent = '';
  if (!key) return;
  setKey(key);
  const ok = await loadStats();
  if (!ok) {{
    clearKey();
    msg.textContent = 'מפתח לא תקין או שאין הרשאות ניהול.';
    return;
  }}
  document.getElementById('loginSection').classList.add('hidden');
  document.getElementById('dashboardSection').classList.remove('hidden');
}});

document.getElementById('btnLogout').addEventListener('click', () => {{
  clearKey();
  document.getElementById('dashboardSection').classList.add('hidden');
  document.getElementById('loginSection').classList.remove('hidden');
  document.getElementById('adminKeyInput').value = '';
}});

document.getElementById('entityType').addEventListener('change', (e) => {{
  document.getElementById('consentLabel').classList.toggle('hidden', e.target.value !== 'employees');
}});

async function importFile(file) {{
  const entityType = document.getElementById('entityType').value;
  const reportEl = document.getElementById('report');
  reportEl.textContent = 'מייבא...';

  const formData = new FormData();
  formData.append('file', file, file.name);
  let url = '/api/admin/recruiters/import';
  if (entityType === 'employees') {{
    url = '/api/admin/employees/import';
    formData.append('consented', document.getElementById('consentToggle').checked ? 'true' : 'false');
  }}

  try {{
    const resp = await apiFetch(url, {{ method: 'POST', body: formData }});
    const data = await resp.json();
    if (!resp.ok) {{
      reportEl.textContent = 'שגיאה: ' + (data.detail || resp.status);
      return;
    }}
    const errors = (data.errors || []).map(e => `שורה ${{e.row}} — ${{e.reason}}`).join('\\n');
    reportEl.textContent = `נוצרו ${{data.created ?? 0}}, הועשרו ${{data.enriched ?? 0}}, דולגו ${{data.skipped_duplicates ?? 0}} כפולים` +
      (errors ? `\\n\\nשגיאות:\\n${{errors}}` : '');
  }} catch (err) {{
    reportEl.textContent = 'משהו השתבש. נסו שוב.';
  }}
}}

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
fileInput.addEventListener('change', () => {{ if (fileInput.files[0]) importFile(fileInput.files[0]); }});
dropZone.addEventListener('dragover', (e) => {{ e.preventDefault(); dropZone.classList.add('drag'); }});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', (e) => {{
  e.preventDefault();
  dropZone.classList.remove('drag');
  const file = e.dataTransfer.files[0];
  if (file) importFile(file);
}});

document.getElementById('btnExport').addEventListener('click', async () => {{
  const resp = await apiFetch('/api/admin/recruiters/export');
  if (!resp.ok) return;
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'recruiters.csv';
  a.click();
}});

// Resume an already-verified session without re-prompting.
(async () => {{
  if (getKey() && await loadStats()) {{
    document.getElementById('loginSection').classList.add('hidden');
    document.getElementById('dashboardSection').classList.remove('hidden');
  }}
}})();
</script>
</body>
</html>"""


@router.get("/admin")
async def admin_console():
    return HTMLResponse(content=_ADMIN_PAGE_HTML)
