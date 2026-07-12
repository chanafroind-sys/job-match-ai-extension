import pytest
import pytest_asyncio
from fastapi import HTTPException

from app.core.models import User
from app.core import points_config
from app.routes import recruiters
from app.services import points_service


@pytest_asyncio.fixture
async def user2(db):
    u = User(license_key_hash="testhash5678")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


def _body(**overrides):
    defaults = dict(
        full_name="דנה כהן",
        email="dana@acme.com",
        company="Acme Corp",
        phone=None,
    )
    defaults.update(overrides)
    return recruiters.RecruiterIn(**defaults)


async def test_new_recruiter_awards_ten_points(db, user):
    resp = await recruiters.add_recruiter(_body(), user, db)
    assert resp["duplicate"] is False
    assert resp["points_awarded"] == points_config.NEW_RECRUITER == 10
    assert await points_service.get_balance(db, user.id) == 10


async def test_enrich_existing_recruiter_awards_two_points(db, user):
    await recruiters.add_recruiter(_body(phone=None), user, db)

    resp = await recruiters.add_recruiter(_body(phone="050-1234567"), user, db)

    assert resp["duplicate"] is True
    assert resp["points_awarded"] == points_config.ENRICH_RECRUITER == 2
    assert resp["recruiter"]["phone"] == "050-1234567"
    assert await points_service.get_balance(db, user.id) == 12


async def test_duplicate_with_no_new_info_awards_nothing(db, user):
    await recruiters.add_recruiter(_body(phone="050-1234567"), user, db)

    resp = await recruiters.add_recruiter(_body(phone="050-1234567"), user, db)

    assert resp["duplicate"] is True
    assert resp["points_awarded"] == 0
    assert await points_service.get_balance(db, user.id) == 10


async def test_daily_recruiter_cap_stops_further_points(db, user):
    for i in range(points_config.DAILY_RECRUITER_CAP):
        resp = await recruiters.add_recruiter(
            _body(email=f"recruiter{i}@acme.com"), user, db
        )
        assert resp["points_awarded"] == points_config.NEW_RECRUITER

    over_cap = await recruiters.add_recruiter(
        _body(email="recruiter-over-cap@acme.com"), user, db
    )
    assert over_cap["duplicate"] is False
    assert over_cap["points_awarded"] == 0
    assert "מכסה" in over_cap["message"]

    expected_balance = points_config.DAILY_RECRUITER_CAP * points_config.NEW_RECRUITER
    assert await points_service.get_balance(db, user.id) == expected_balance


async def test_blocked_personal_domain_rejected(db, user):
    with pytest.raises(HTTPException) as exc_info:
        await recruiters.add_recruiter(_body(email="dana@gmail.com"), user, db)
    assert exc_info.value.status_code == 400


async def test_invalid_email_format_rejected(db, user):
    with pytest.raises(HTTPException) as exc_info:
        await recruiters.add_recruiter(_body(email="not-an-email"), user, db)
    assert exc_info.value.status_code == 400


async def test_email_normalization_dedupes_case_and_whitespace(db, user):
    await recruiters.add_recruiter(_body(email="Dana@Acme.com"), user, db)

    resp = await recruiters.add_recruiter(_body(email="  dana@acme.com  "), user, db)

    assert resp["duplicate"] is True


async def test_no_double_points_for_same_user_and_recruiter(db, user):
    # Enrich once (earns points), then "enrich" again with the same already-filled
    # field — no update happens, so no second credit either.
    await recruiters.add_recruiter(_body(phone=None), user, db)
    await recruiters.add_recruiter(_body(phone="050-1111111"), user, db)
    balance_after_enrich = await points_service.get_balance(db, user.id)

    resp = await recruiters.add_recruiter(_body(phone="050-1111111"), user, db)

    assert resp["points_awarded"] == 0
    assert await points_service.get_balance(db, user.id) == balance_after_enrich


async def test_search_by_normalized_company_matches_case_and_prefix(db, user):
    await recruiters.add_recruiter(_body(company="  Acme   Corp  "), user, db)

    exact = await recruiters.search_recruiters("acme corp", user, db)
    assert len(exact["results"]) == 1

    prefix = await recruiters.search_recruiters("Acme", user, db)
    assert len(prefix["results"]) == 1

    none_match = await recruiters.search_recruiters("Other Inc", user, db)
    assert none_match["results"] == []
