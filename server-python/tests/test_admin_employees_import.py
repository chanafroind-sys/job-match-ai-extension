from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import select

import main
from app.core.models import Employee, EmployeeSource, OptInStatus, User
from app.routes import admin
from tests.test_admin_recruiters_import import ADMIN_LICENSE_KEY, _upload, _xlsx_bytes

EMPLOYEE_HEADERS = ("full_name", "email", "company", "domains", "min_match_threshold")


@pytest.fixture(autouse=True)
def _admin_keys(monkeypatch):
    monkeypatch.setattr(main, "STATIC_ADMIN_KEYS", {ADMIN_LICENSE_KEY})


@pytest.fixture
async def admin_user(db):
    u = User(license_key_hash=main._ws_user_id(ADMIN_LICENSE_KEY))
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_import_consented_marks_rows_accepted(db, admin_user):
    content = _xlsx_bytes(
        [["Dana Cohen", "dana@acme.com", "Acme Corp", "backend", 80]], headers=EMPLOYEE_HEADERS,
    )
    with patch("app.services.email_service.send_employee_optin_invitation", new=AsyncMock()) as mock_send:
        report = await admin.import_employees(_upload(content), True, admin_user, db)
    assert report == {"created": 1, "enriched": 0, "skipped_duplicates": 0, "errors": []}
    assert mock_send.await_count == 0

    result = await db.execute(select(Employee).where(Employee.email == "dana@acme.com"))
    employee = result.scalar_one()
    assert employee.opt_in_status == OptInStatus.ACCEPTED
    assert employee.source == EmployeeSource.IMPORT
    assert employee.added_by_user_id == admin_user.id


async def test_import_non_consented_marks_rows_pending_and_sends_no_email(db, admin_user):
    content = _xlsx_bytes(
        [["Dana Cohen", "dana@acme.com", "Acme Corp", "", 75]], headers=EMPLOYEE_HEADERS,
    )
    with patch("app.services.email_service.send_employee_optin_invitation", new=AsyncMock()) as mock_send:
        report = await admin.import_employees(_upload(content), False, admin_user, db)
    assert report["created"] == 1
    assert mock_send.await_count == 0

    result = await db.execute(select(Employee).where(Employee.email == "dana@acme.com"))
    employee = result.scalar_one()
    assert employee.opt_in_status == OptInStatus.PENDING


async def test_import_upserts_on_overlapping_reupload(db, admin_user):
    content1 = _xlsx_bytes([["Dana Cohen", "dana@acme.com", "Acme Corp", "", 75]], headers=EMPLOYEE_HEADERS)
    await admin.import_employees(_upload(content1), True, admin_user, db)

    content2 = _xlsx_bytes([["Dana Cohen", "dana@acme.com", "Acme Corp", "backend,python", 75]], headers=EMPLOYEE_HEADERS)
    report = await admin.import_employees(_upload(content2), True, admin_user, db)
    assert report["created"] == 0
    assert report["enriched"] == 1

    result = await db.execute(select(Employee).where(Employee.email == "dana@acme.com"))
    assert len(result.scalars().all()) == 1


async def test_import_oversized_file_rejected(db, admin_user):
    big_content = b"x" * (admin.MAX_IMPORT_FILE_BYTES + 1)
    with pytest.raises(HTTPException) as exc_info:
        await admin.import_employees(_upload(big_content), True, admin_user, db)
    assert exc_info.value.status_code == 413


async def test_import_too_many_rows_rejected(db, admin_user):
    rows = [[f"Person {i}", f"person{i}@acme.com", "Acme Corp", "", 75] for i in range(admin.MAX_IMPORT_ROWS + 1)]
    content = _xlsx_bytes(rows, headers=EMPLOYEE_HEADERS)
    with pytest.raises(HTTPException) as exc_info:
        await admin.import_employees(_upload(content), True, admin_user, db)
    assert exc_info.value.status_code == 422


async def test_import_requires_admin(db, user):
    with pytest.raises(HTTPException) as exc_info:
        await admin.require_admin(user=user)
    assert exc_info.value.status_code == 403
