from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.core.models import ActionType, Employee, PointsLedger, ReferralRequest, ReferralStatus
from app.routes import referrals
from app.services import points_service, referral_service


@pytest.fixture
async def employee(db):
    e = Employee(
        full_name="Dana Cohen",
        company="Acme Corp",
        company_normalized="acme corp",
        email="dana@acme.com",
        domains=None,
        min_match_threshold=75,
        is_opted_in=True,
        source_row_id="dana@acme.com",
    )
    db.add(e)
    await db.commit()
    await db.refresh(e)
    return e


def _create_body(**overrides):
    defaults = dict(
        job_url_hash="job1",
        job_title="Backend Developer",
        company="Acme Corp",
        score=80,
        candidate_summary="5 years Python, FastAPI.",
    )
    defaults.update(overrides)
    return referrals.ReferralCreate(**defaults)


async def _create_referral(db, user, employee, **overrides):
    with patch("app.services.email_service.send_referral_notification", new=AsyncMock()):
        resp = await referrals.create_referral(_create_body(**overrides), user, db)
    return resp


async def test_create_referral_charges_points_and_creates_pending_row(db, user, employee):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()

    resp = await _create_referral(db, user, employee)

    assert resp["success"] is True
    assert resp["status"] == "pending"
    assert resp["balance"] == 5
    assert await points_service.get_balance(db, user.id) == 5

    result = await db.execute(select(ReferralRequest).where(ReferralRequest.user_id == user.id))
    referral = result.scalar_one()
    assert referral.status == ReferralStatus.PENDING
    assert referral.points_charged == 5
    assert referral.employee_id == employee.id
    assert referral.token


async def test_create_referral_insufficient_balance_returns_402(db, user, employee):
    user_id = user.id  # captured before the call — the route rolls back on 402,
    # which expires `user`'s attributes; re-touching user.id afterward would
    # need a fresh async load outside an await context.
    with pytest.raises(HTTPException) as exc_info:
        await _create_referral(db, user, employee)
    assert exc_info.value.status_code == 402

    assert await points_service.get_balance(db, user_id) == 0
    result = await db.execute(select(ReferralRequest))
    assert result.scalars().all() == []


async def test_create_referral_no_eligible_employee_returns_400(db, user, employee):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()

    with pytest.raises(HTTPException) as exc_info:
        await _create_referral(db, user, employee, company="Other Inc")
    assert exc_info.value.status_code == 400


async def test_create_referral_conflicts_with_active_request_returns_409(db, user, employee):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()

    await _create_referral(db, user, employee)

    with pytest.raises(HTTPException) as exc_info:
        await _create_referral(db, user, employee)
    assert exc_info.value.status_code == 409


async def test_decline_refunds_points_and_sets_status(db, user, employee):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()
    await _create_referral(db, user, employee)
    result = await db.execute(select(ReferralRequest).where(ReferralRequest.user_id == user.id))
    referral = result.scalar_one()

    resp = await referrals.decline_referral(referral.token, db)

    await db.refresh(referral)
    assert referral.status == ReferralStatus.DECLINED
    assert referral.resolved_at is not None
    assert await points_service.get_balance(db, user.id) == 10
    assert "הבקשה נדחתה" in resp.body.decode("utf-8")


async def test_accept_sets_status_and_sends_mutual_exposure(db, user, employee):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()
    await _create_referral(db, user, employee)
    result = await db.execute(select(ReferralRequest).where(ReferralRequest.user_id == user.id))
    referral = result.scalar_one()

    with patch("app.services.email_service.send_mutual_exposure_emails", new=AsyncMock()) as mock_send:
        resp = await referrals.accept_referral(referral.token, db)

    await db.refresh(referral)
    assert referral.status == ReferralStatus.ACCEPTED
    assert referral.resolved_at is not None
    mock_send.assert_called_once()
    assert "אושרה" in resp.body.decode("utf-8")


async def test_second_decline_on_same_token_does_not_double_refund(db, user, employee):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()
    await _create_referral(db, user, employee)
    result = await db.execute(select(ReferralRequest).where(ReferralRequest.user_id == user.id))
    referral = result.scalar_one()

    await referrals.decline_referral(referral.token, db)
    balance_after_first = await points_service.get_balance(db, user.id)

    resp = await referrals.decline_referral(referral.token, db)

    assert "כבר טופלה" in resp.body.decode("utf-8")
    assert await points_service.get_balance(db, user.id) == balance_after_first

    refunds = await db.execute(
        select(PointsLedger).where(
            PointsLedger.user_id == user.id, PointsLedger.action_type == ActionType.REFERRAL_REFUND,
        )
    )
    assert len(refunds.scalars().all()) == 1


async def test_accept_after_decline_returns_already_handled(db, user, employee):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()
    await _create_referral(db, user, employee)
    result = await db.execute(select(ReferralRequest).where(ReferralRequest.user_id == user.id))
    referral = result.scalar_one()

    await referrals.decline_referral(referral.token, db)
    resp = await referrals.accept_referral(referral.token, db)

    assert "כבר טופלה" in resp.body.decode("utf-8")
    await db.refresh(referral)
    assert referral.status == ReferralStatus.DECLINED


async def test_expire_stale_referral_refunds_once(db, user, employee):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()
    await _create_referral(db, user, employee)
    result = await db.execute(select(ReferralRequest).where(ReferralRequest.user_id == user.id))
    referral = result.scalar_one()

    referral.created_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=8)
    await db.commit()

    await referral_service.expire_stale_referrals(db)

    await db.refresh(referral)
    assert referral.status == ReferralStatus.EXPIRED
    assert referral.resolved_at is not None
    assert await points_service.get_balance(db, user.id) == 10

    # Running it again must not double-refund an already-resolved request.
    await referral_service.expire_stale_referrals(db)
    assert await points_service.get_balance(db, user.id) == 10
