import pytest

from app.core.models import Employee, OptInStatus, ReferralRequest, ReferralStatus
from app.routes import referrals


@pytest.fixture
async def employee(db):
    e = Employee(
        full_name="Dana Cohen",
        company="Acme Corp",
        company_normalized="acme corp",
        email="dana@acme.com",
        domains=None,
        min_match_threshold=75,
        opt_in_status=OptInStatus.ACCEPTED,
        source_row_id="dana@acme.com",
    )
    db.add(e)
    await db.commit()
    await db.refresh(e)
    return e


async def test_available_true_when_opted_in_and_score_meets_threshold(db, user, employee):
    resp = await referrals.check_referral(company="Acme Corp", score=80, job_url_hash="job1", user=user, db=db)
    assert resp == {"available": True, "cost": 5}


async def test_unavailable_when_not_opted_in(db, user, employee):
    employee.opt_in_status = OptInStatus.PENDING
    await db.commit()

    resp = await referrals.check_referral(company="Acme Corp", score=90, job_url_hash="job1", user=user, db=db)
    assert resp["available"] is False


async def test_unavailable_when_company_mismatch(db, user, employee):
    resp = await referrals.check_referral(company="Other Inc", score=90, job_url_hash="job1", user=user, db=db)
    assert resp["available"] is False


async def test_unavailable_when_score_below_global_minimum(db, user, employee):
    # Employee threshold is 75, but the platform-wide floor is also 75.
    resp = await referrals.check_referral(company="Acme Corp", score=70, job_url_hash="job1", user=user, db=db)
    assert resp["available"] is False


async def test_unavailable_when_score_below_personal_threshold(db, user, employee):
    employee.min_match_threshold = 85
    await db.commit()

    resp = await referrals.check_referral(company="Acme Corp", score=80, job_url_hash="job1", user=user, db=db)
    assert resp["available"] is False

    resp_high = await referrals.check_referral(company="Acme Corp", score=85, job_url_hash="job1", user=user, db=db)
    assert resp_high["available"] is True


async def test_unavailable_when_active_request_already_exists(db, user, employee):
    db.add(ReferralRequest(
        user_id=user.id,
        employee_id=employee.id,
        job_url_hash="job1",
        match_score=80,
        status=ReferralStatus.PENDING,
        points_charged=5,
        token="tok-existing",
    ))
    await db.commit()

    resp = await referrals.check_referral(company="Acme Corp", score=80, job_url_hash="job1", user=user, db=db)
    assert resp["available"] is False


async def test_check_response_never_leaks_employee_identity(db, user, employee):
    resp = await referrals.check_referral(company="Acme Corp", score=80, job_url_hash="job1", user=user, db=db)
    assert set(resp.keys()) == {"available", "cost"}
