import io

import pytest
import pytest_asyncio
from fastapi import HTTPException, UploadFile
from openpyxl import Workbook
from sqlalchemy import select

import main
from app.core import deps
from app.core.models import PointsLedger, Recruiter, User
from app.routes import points, recruiters

ADMIN_LICENSE_KEY = "test-admin-license-key"


@pytest.fixture(autouse=True)
def _admin_keys(monkeypatch):
    # Mirrors STATIC_PREMIUM_KEYS being populated from an env var — here we set
    # the parsed set directly so tests don't depend on process-start env vars.
    monkeypatch.setattr(main, "STATIC_ADMIN_KEYS", {ADMIN_LICENSE_KEY})


@pytest_asyncio.fixture
async def admin_user(db):
    u = User(license_key_hash=main._ws_user_id(ADMIN_LICENSE_KEY))
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def _xlsx_bytes(rows, headers=("full_name", "email", "phone", "company")):
    wb = Workbook()
    ws = wb.active
    ws.append(list(headers))
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _upload(content: bytes, filename: str = "import.xlsx") -> UploadFile:
    return UploadFile(filename=filename, file=io.BytesIO(content))


# ── require_admin / isAdmin ────────────────────────────────────────────────

async def test_require_admin_rejects_non_admin_key(user):
    with pytest.raises(HTTPException) as exc_info:
        await deps.require_admin(user=user)
    assert exc_info.value.status_code == 403


async def test_require_admin_allows_admin_key(admin_user):
    result = await deps.require_admin(user=admin_user)
    assert result is admin_user


async def test_balance_reports_is_admin_true_for_admin(db, admin_user):
    resp = await points.get_points_balance(admin_user, db)
    assert resp["isAdmin"] is True


async def test_balance_reports_is_admin_false_for_regular_user(db, user):
    resp = await points.get_points_balance(user, db)
    assert resp["isAdmin"] is False


# ── import endpoint ─────────────────────────────────────────────────────────

async def test_import_creates_recruiters(db, admin_user):
    content = _xlsx_bytes([
        ["Dana Cohen", "dana@acme.com", "050-1111111", "Acme Corp"],
        ["Yossi Levi", "yossi@acme.com", None, "Acme Corp"],
    ])

    report = await recruiters.import_recruiters(_upload(content), admin_user, db)

    assert report == {"created": 2, "enriched": 0, "skipped_duplicates": 0, "errors": []}

    result = await db.execute(select(PointsLedger))
    assert result.scalars().all() == []


async def test_import_marks_rows_verified_and_added_by_admin(db, admin_user):
    content = _xlsx_bytes([["Dana Cohen", "dana@acme.com", None, "Acme Corp"]])

    await recruiters.import_recruiters(_upload(content), admin_user, db)

    result = await db.execute(select(Recruiter).where(Recruiter.email == "dana@acme.com"))
    recruiter = result.scalar_one()
    assert recruiter.is_verified is True
    assert recruiter.added_by_user_id == admin_user.id


async def test_import_skips_duplicate_against_existing_db_row(db, admin_user, user):
    await recruiters.add_recruiter(
        recruiters.RecruiterIn(full_name="Dana Cohen", email="dana@acme.com", company="Acme Corp", phone="050-1111111"),
        user, db,
    )

    content = _xlsx_bytes([["Dana Cohen", "dana@acme.com", "050-1111111", "Acme Corp"]])
    report = await recruiters.import_recruiters(_upload(content), admin_user, db)

    assert report["created"] == 0
    assert report["skipped_duplicates"] == 1
    assert report["enriched"] == 0


async def test_import_dedupes_within_file(db, admin_user):
    content = _xlsx_bytes([
        ["Dana Cohen", "dana@acme.com", "050-1111111", "Acme Corp"],
        ["Dana Cohen Again", "dana@acme.com", "050-1111111", "Acme Corp"],
    ])

    report = await recruiters.import_recruiters(_upload(content), admin_user, db)

    assert report["created"] == 1
    assert report["skipped_duplicates"] == 1

    result = await db.execute(select(Recruiter).where(Recruiter.email == "dana@acme.com"))
    assert len(result.scalars().all()) == 1


async def test_import_invalid_email_row_recorded_as_error_without_aborting_batch(db, admin_user):
    content = _xlsx_bytes([
        ["Dana Cohen", "not-an-email", None, "Acme Corp"],
        ["Yossi Levi", "yossi@acme.com", None, "Acme Corp"],
    ])

    report = await recruiters.import_recruiters(_upload(content), admin_user, db)

    assert report["created"] == 1
    assert len(report["errors"]) == 1
    assert report["errors"][0]["row"] == 2


async def test_import_blocked_domain_recorded_as_error(db, admin_user):
    content = _xlsx_bytes([
        ["Dana Cohen", "dana@gmail.com", None, "Acme Corp"],
        ["Yossi Levi", "yossi@acme.com", None, "Acme Corp"],
    ])

    report = await recruiters.import_recruiters(_upload(content), admin_user, db)

    assert report["created"] == 1
    assert len(report["errors"]) == 1
    assert report["errors"][0]["row"] == 2


async def test_import_oversized_file_rejected(db, admin_user):
    big_content = b"x" * (recruiters.MAX_IMPORT_FILE_BYTES + 1)

    with pytest.raises(HTTPException) as exc_info:
        await recruiters.import_recruiters(_upload(big_content), admin_user, db)
    assert exc_info.value.status_code == 413


async def test_import_missing_required_column_rejected(db, admin_user):
    content = _xlsx_bytes(
        [["Dana Cohen", "dana@acme.com", "Acme Corp"]],
        headers=("full_name", "email", "phone"),  # no "company"
    )

    with pytest.raises(HTTPException) as exc_info:
        await recruiters.import_recruiters(_upload(content), admin_user, db)
    assert exc_info.value.status_code == 422


async def test_import_too_many_rows_rejected(db, admin_user):
    rows = [[f"Person {i}", f"person{i}@acme.com", None, "Acme Corp"] for i in range(recruiters.MAX_IMPORT_ROWS + 1)]
    content = _xlsx_bytes(rows)

    with pytest.raises(HTTPException) as exc_info:
        await recruiters.import_recruiters(_upload(content), admin_user, db)
    assert exc_info.value.status_code == 422


async def test_import_requires_admin(db, user):
    with pytest.raises(HTTPException) as exc_info:
        await deps.require_admin(user=user)
    assert exc_info.value.status_code == 403
