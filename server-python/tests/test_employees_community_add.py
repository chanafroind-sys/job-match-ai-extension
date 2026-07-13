from sqlalchemy import select

from app.core import points_config
from app.core.models import Employee, EmployeeSource, OptInStatus
from app.routes import employees, recruiters


def _body(**overrides):
    defaults = dict(
        full_name="יוסי לוי",
        company="Acme Corp",
        email="yossi@acme.com",
        domains="",
        min_match_threshold=75,
    )
    defaults.update(overrides)
    return employees.EmployeeIn(**defaults)


async def test_new_employee_awards_ten_points(db, user):
    resp = await employees.add_employee(_body(), user, db)
    assert resp["duplicate"] is False
    assert resp["points_awarded"] == points_config.NEW_EMPLOYEE == 10

    result = await db.execute(select(Employee).where(Employee.email == "yossi@acme.com"))
    employee = result.scalar_one()
    assert employee.source == EmployeeSource.COMMUNITY
    assert employee.opt_in_status == OptInStatus.PENDING


async def test_enrich_existing_employee_awards_two_points(db, user):
    await employees.add_employee(_body(domains=""), user, db)
    resp = await employees.add_employee(_body(domains="python,backend"), user, db)
    assert resp["duplicate"] is True
    assert resp["points_awarded"] == points_config.ENRICH_EMPLOYEE == 2


async def test_duplicate_with_no_new_info_awards_zero(db, user):
    await employees.add_employee(_body(), user, db)
    resp = await employees.add_employee(_body(), user, db)
    assert resp["duplicate"] is True
    assert resp["points_awarded"] == 0


async def test_readd_of_declined_employee_does_not_flip_status(db, user):
    declined = Employee(
        full_name="Dana Cohen",
        company="Acme Corp",
        company_normalized="acme corp",
        email="dana@acme.com",
        domains=None,
        min_match_threshold=75,
        source=EmployeeSource.COMMUNITY,
        opt_in_status=OptInStatus.DECLINED,
        added_by_user_id=user.id,
    )
    db.add(declined)
    await db.commit()
    await db.refresh(declined)

    await employees.add_employee(
        _body(full_name="Dana Cohen", email="dana@acme.com", domains="python"), user, db,
    )

    await db.refresh(declined)
    assert declined.opt_in_status == OptInStatus.DECLINED


async def test_shared_daily_cap_across_recruiters_and_employees(db, user):
    for i in range(points_config.DAILY_RECRUITER_CAP):
        await recruiters.add_recruiter(
            recruiters.RecruiterIn(full_name=f"R{i}", email=f"r{i}@acme.com", company="Acme Corp"),
            user, db,
        )

    resp = await employees.add_employee(_body(email="capped@acme.com"), user, db)
    assert resp["points_awarded"] == 0
    assert "מכסה" in resp["message"]


async def test_mixed_recruiter_and_employee_adds_share_the_cap(db, user):
    total_awarded = 0
    for i in range(3):
        r = await recruiters.add_recruiter(
            recruiters.RecruiterIn(full_name=f"R{i}", email=f"r{i}@acme.com", company="Acme Corp"),
            user, db,
        )
        total_awarded += 1 if r["points_awarded"] else 0

    awarded_flags = []
    for i in range(3):
        resp = await employees.add_employee(_body(email=f"e{i}@acme.com"), user, db)
        awarded_flags.append(resp["points_awarded"] > 0)

    total_awarded += sum(1 for f in awarded_flags if f)
    assert total_awarded == points_config.DAILY_RECRUITER_CAP
