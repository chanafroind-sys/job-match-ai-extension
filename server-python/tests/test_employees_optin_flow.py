from unittest.mock import AsyncMock, patch

from sqlalchemy import select

from app.core.models import PointsLedger
from app.routes import employees


async def _add_employee(user, db, **overrides):
    body = employees.EmployeeIn(
        full_name="יוסי לוי", company="Acme Corp", email="yossi@acme.com",
        domains="", min_match_threshold=75,
    )
    for k, v in overrides.items():
        setattr(body, k, v)
    with patch("app.services.email_service.send_employee_optin_invitation", new=AsyncMock()) as mock_send:
        resp = await employees.add_employee(body, user, db)
    return resp, mock_send


async def test_accept_flips_status_and_second_visit_shows_already_handled(db, user):
    resp, _ = await _add_employee(user, db)
    result = await db.execute(select(employees.Employee).where(employees.Employee.id == resp["employee"]["id"]))
    employee = result.scalar_one()
    token = employee.opt_in_token
    assert token

    page1 = await employees.accept_optin(token, db)
    assert "תודה" in page1.body.decode("utf-8")

    await db.refresh(employee)
    assert employee.opt_in_status == employees.OptInStatus.ACCEPTED

    page2 = await employees.accept_optin(token, db)
    assert "כבר טופלה" in page2.body.decode("utf-8")


async def test_decline_flips_status_with_no_refund_ledger_entry(db, user):
    resp, _ = await _add_employee(user, db)
    result = await db.execute(select(employees.Employee).where(employees.Employee.id == resp["employee"]["id"]))
    employee = result.scalar_one()
    token = employee.opt_in_token

    await employees.decline_optin(token, db)
    await db.refresh(employee)
    assert employee.opt_in_status == employees.OptInStatus.DECLINED

    ledger = await db.execute(select(PointsLedger).where(PointsLedger.ref_id == str(employee.id)))
    entries = ledger.scalars().all()
    assert all(e.action_type != employees.ActionType.REFERRAL_REFUND for e in entries)


async def test_unknown_token_shows_generic_invalid_message(db):
    page = await employees.accept_optin("does-not-exist", db)
    assert "לא נמצא" in page.body.decode("utf-8")


async def test_invite_email_sent_on_create_not_on_reenrich(db, user):
    resp1, mock_send1 = await _add_employee(user, db, domains="")
    assert mock_send1.await_count == 1

    resp2, mock_send2 = await _add_employee(user, db, domains="python")
    assert mock_send2.await_count == 0


async def test_readd_after_decline_never_reinvites(db, user):
    resp1, mock_send1 = await _add_employee(user, db)
    assert mock_send1.await_count == 1

    result = await db.execute(select(employees.Employee).where(employees.Employee.id == resp1["employee"]["id"]))
    employee = result.scalar_one()
    await employees.decline_optin(employee.opt_in_token, db)

    resp2, mock_send2 = await _add_employee(user, db, domains="python,backend")
    assert mock_send2.await_count == 0
    await db.refresh(employee)
    assert employee.opt_in_status == employees.OptInStatus.DECLINED
