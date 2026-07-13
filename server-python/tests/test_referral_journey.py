"""End-to-end new-user journey: add a recruiter, prepare+send an email to
them, request an employee referral, have the employee decline it. Exercises
three route modules against the shared points ledger.
"""

from unittest.mock import AsyncMock, patch

from sqlalchemy import select

from app.core.models import Employee, OptInStatus, Recruiter, ReferralRequest, SendLog, SendStatus
from app.routes import emails, recruiters, referrals
from app.services import points_service


async def test_full_referral_journey_ends_at_nine_points(db, user):
    # 1) Add a new recruiter — +10 points.
    add_resp = await recruiters.add_recruiter(
        recruiters.RecruiterIn(full_name="דנה כהן", email="dana@acme.com", company="Acme Corp", phone=None),
        user, db,
    )
    assert add_resp["points_awarded"] == 10
    assert await points_service.get_balance(db, user.id) == 10

    recruiter_result = await db.execute(select(Recruiter).where(Recruiter.email == "dana@acme.com"))
    recruiter = recruiter_result.scalar_one()

    # 2) Prepare + "send" (log-open) an email to that recruiter — -1 point.
    open_resp = await emails.log_email_open(
        emails.LogOpenRequest(recruiter_id=recruiter.id, job_url_hash="job1", job_title="Backend Dev", company="Acme Corp"),
        user, db,
    )
    assert open_resp["balance"] == 9
    assert await points_service.get_balance(db, user.id) == 9

    log_result = await db.execute(select(SendLog).where(SendLog.user_id == user.id))
    send_log = log_result.scalar_one()
    assert send_log.status == SendStatus.OPENED

    # An opted-in employee at the same company, eligible at this score.
    employee = Employee(
        full_name="Yossi Levi",
        company="Acme Corp",
        company_normalized="acme corp",
        email="yossi@acme.com",
        min_match_threshold=75,
        opt_in_status=OptInStatus.ACCEPTED,
        source_row_id="yossi@acme.com",
    )
    db.add(employee)
    await db.commit()
    await db.refresh(employee)

    # 3) Submit a referral request — -5 points.
    with patch("app.services.email_service.send_referral_notification", new=AsyncMock()):
        create_resp = await referrals.create_referral(
            referrals.ReferralCreate(
                job_url_hash="job1", job_title="Backend Dev", company="Acme Corp",
                score=80, candidate_summary="5 years Python.",
            ),
            user, db,
        )
    assert create_resp["balance"] == 4
    assert await points_service.get_balance(db, user.id) == 4

    referral_result = await db.execute(select(ReferralRequest).where(ReferralRequest.user_id == user.id))
    referral = referral_result.scalar_one()
    assert referral.status.value == "pending"

    # 4) The employee declines — full 5-point refund.
    await referrals.decline_referral(referral.token, db)
    await db.refresh(referral)
    assert referral.status.value == "declined"

    final_balance = await points_service.get_balance(db, user.id)
    assert final_balance == 9
