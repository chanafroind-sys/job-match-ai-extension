import pytest
import pytest_asyncio
from fastapi import HTTPException

import main
from app.core.deps import require_admin
from app.core.models import Employee, EmployeeSource, OptInStatus, Recruiter, User
from app.routes import admin, recruiters

ADMIN_LICENSE_KEY = "test-admin-console-key"


@pytest.fixture(autouse=True)
def _admin_keys(monkeypatch):
    monkeypatch.setattr(main, "STATIC_ADMIN_KEYS", {ADMIN_LICENSE_KEY})


@pytest_asyncio.fixture
async def admin_user(db):
    u = User(license_key_hash=main._ws_user_id(ADMIN_LICENSE_KEY))
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


async def test_admin_page_serves_200_with_no_data_leakage(db, admin_user):
    db.add(Recruiter(
        full_name="Secret Recruiter", email="secret-recruiter@acme.com", company="Acme Corp",
        company_normalized="acme corp", added_by_user_id=admin_user.id,
    ))
    await db.commit()

    page = await admin.admin_console()
    body = page.body.decode("utf-8")
    assert page.status_code == 200
    assert "secret-recruiter@acme.com" not in body
    assert "Secret Recruiter" not in body


async def test_admin_stats_requires_admin(db, user):
    with pytest.raises(HTTPException) as exc_info:
        await require_admin(user=user)
    assert exc_info.value.status_code == 403


async def test_admin_stats_correct_counts(db, admin_user, user):
    await recruiters.add_recruiter(
        recruiters.RecruiterIn(full_name="Dana", email="dana@acme.com", company="Acme Corp"), user, db,
    )
    db.add(Employee(
        full_name="Yossi", company="Acme Corp", company_normalized="acme corp", email="yossi@acme.com",
        source=EmployeeSource.COMMUNITY, opt_in_status=OptInStatus.PENDING,
    ))
    await db.commit()

    stats = await admin.admin_stats(admin_user, db)
    assert stats["recruiters"]["total"] == 1
    assert stats["employees"]["by_opt_in_status"].get("pending") == 1
    assert stats["employees"]["by_source"].get("community") == 1
    assert stats["users"]["total"] >= 2
    assert stats["points"]["issued"] >= 10


async def test_admin_export_requires_admin(db, user):
    with pytest.raises(HTTPException) as exc_info:
        await require_admin(user=user)
    assert exc_info.value.status_code == 403


async def test_admin_export_returns_correct_csv_rows(db, admin_user, user):
    await recruiters.add_recruiter(
        recruiters.RecruiterIn(full_name="Dana Cohen", email="dana@acme.com", company="Acme Corp"), user, db,
    )

    resp = await admin.export_recruiters(admin_user, db)
    body = resp.body.decode("utf-8")
    assert "full_name,email,phone,company,is_verified,created_at" in body
    assert "Dana Cohen,dana@acme.com" in body
