import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.core.models import Employee, EmployeeSource, OptInStatus
from app.routes import employees


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    def __init__(self, host="1.2.3.4"):
        self.client = _FakeClient(host)


def _body(**overrides):
    defaults = dict(
        full_name="דנה כהן",
        company="Acme Corp",
        email="dana@acme.com",
        domains="",
        min_match_threshold=75,
        consent=True,
        website="",
    )
    defaults.update(overrides)
    return employees.EmployeeRegisterIn(**defaults)


async def test_new_registration_is_immediately_accepted(db):
    resp = await employees.register_employee(_body(), _FakeRequest("10.0.0.1"), db)
    assert resp["success"] is True

    result = await db.execute(select(Employee).where(Employee.email == "dana@acme.com"))
    employee = result.scalar_one()
    assert employee.source == EmployeeSource.SELF
    assert employee.opt_in_status == OptInStatus.ACCEPTED


async def test_dedup_by_email_updates_existing_row(db):
    await employees.register_employee(_body(), _FakeRequest("10.0.0.2"), db)
    await employees.register_employee(_body(full_name="Dana Cohen 2"), _FakeRequest("10.0.0.2"), db)

    result = await db.execute(select(Employee).where(Employee.email == "dana@acme.com"))
    rows = result.scalars().all()
    assert len(rows) == 1


async def test_honeypot_filled_rejects_silently(db):
    resp = await employees.register_employee(
        _body(website="http://spam.example"), _FakeRequest("10.0.0.3"), db,
    )
    assert resp["success"] is True

    result = await db.execute(select(Employee).where(Employee.email == "dana@acme.com"))
    assert result.scalar_one_or_none() is None


async def test_consent_required(db):
    with pytest.raises(HTTPException) as exc_info:
        await employees.register_employee(_body(consent=False), _FakeRequest("10.0.0.4"), db)
    assert exc_info.value.status_code == 400


async def test_rate_limit_enforced(db, monkeypatch):
    monkeypatch.setattr(employees, "RATE_LIMIT_MAX", 2)

    ip = "10.0.0.5"
    await employees.register_employee(_body(email="a@acme.com"), _FakeRequest(ip), db)
    await employees.register_employee(_body(email="b@acme.com"), _FakeRequest(ip), db)

    with pytest.raises(HTTPException) as exc_info:
        await employees.register_employee(_body(email="c@acme.com"), _FakeRequest(ip), db)
    assert exc_info.value.status_code == 429
