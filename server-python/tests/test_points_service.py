import asyncio

import pytest
from fastapi import HTTPException

from app.core.models import ActionType
from app.services import points_service


async def test_balance_starts_at_zero(db, user):
    assert await points_service.get_balance(db, user.id) == 0


async def test_credit_increases_balance(db, user):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await db.commit()
    assert await points_service.get_balance(db, user.id) == 10


async def test_charge_decreases_balance(db, user):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await points_service.charge(db, user.id, ActionType.EMAIL_SENT, 1)
    await db.commit()
    assert await points_service.get_balance(db, user.id) == 9


async def test_charge_insufficient_balance_raises_402_and_does_not_charge(db, user):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 3)
    await db.commit()

    with pytest.raises(HTTPException) as exc_info:
        await points_service.charge(db, user.id, ActionType.REFERRAL_REQUESTED, 5)
    assert exc_info.value.status_code == 402

    await db.commit()
    assert await points_service.get_balance(db, user.id) == 3


async def test_refund_reverses_charge(db, user):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 10)
    await points_service.charge(db, user.id, ActionType.REFERRAL_REQUESTED, 5, ref_id="req-1")
    await db.commit()
    assert await points_service.get_balance(db, user.id) == 5

    await points_service.refund(db, "req-1")
    await db.commit()
    assert await points_service.get_balance(db, user.id) == 10


async def test_refund_unknown_ref_id_raises(db, user):
    with pytest.raises(ValueError):
        await points_service.refund(db, "no-such-ref")


async def test_concurrent_charges_never_drop_balance_below_zero(db, user):
    await points_service.credit(db, user.id, ActionType.RECRUITER_ADDED_NEW, 5)
    await db.commit()

    async def try_charge():
        try:
            await points_service.charge(db, user.id, ActionType.REFERRAL_REQUESTED, 5)
            return True
        except HTTPException:
            return False

    results = await asyncio.gather(try_charge(), try_charge())
    await db.commit()

    assert sorted(results) == [False, True]
    assert await points_service.get_balance(db, user.id) == 0
