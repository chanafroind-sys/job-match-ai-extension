import json
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.core.models import Recruiter, User
from app.routes import emails


@pytest.fixture
async def recruiter(db, user):
    r = Recruiter(
        full_name="דנה כהן",
        email="dana@acme.com",
        phone=None,
        company="Acme Corp",
        company_normalized="acme corp",
        added_by_user_id=user.id,
    )
    db.add(r)
    await db.commit()
    await db.refresh(r)
    return r


def _letter_body(**overrides):
    defaults = dict(
        jobTitle="Backend Developer",
        company="Acme Corp",
        jobText="We need a backend developer with Python and FastAPI experience.",
        recruiterName="Dana Cohen",
        cvSummary="5 years Python, FastAPI, PostgreSQL.",
    )
    defaults.update(overrides)
    return emails.RecruiterLetterRequest(**defaults)


async def test_draft_letter_uses_haiku_model(db, user):
    mock_response = json.dumps({"subject": "Backend Developer role", "body": "Hello, I'm a great fit."})
    with patch("main.call_claude", new=AsyncMock(return_value=mock_response)) as mock_call:
        resp = await emails.draft_recruiter_letter(_letter_body(), user)

    assert resp["subject"] == "Backend Developer role"
    assert resp["body"] == "Hello, I'm a great fit."
    assert mock_call.call_args.kwargs["model"] == "claude-haiku-4-5-20251001"


async def test_draft_letter_truncates_long_body(db, user):
    long_body = "א" * 2000
    mock_response = json.dumps({"subject": "Backend Developer role", "body": long_body})
    with patch("main.call_claude", new=AsyncMock(return_value=mock_response)):
        resp = await emails.draft_recruiter_letter(_letter_body(), user)

    assert len(resp["body"]) <= emails._MAX_LETTER_BODY_CHARS


def _log_open_body(**overrides):
    defaults = dict(recruiter_id=1, job_url_hash="abc123", job_title="Backend Developer", company="Acme Corp")
    defaults.update(overrides)
    return emails.LogOpenRequest(**defaults)


async def test_log_open_charges_point_and_returns_email(db, user, recruiter):
    await emails.points_service.credit(db, user.id, emails.ActionType.RECRUITER_ADDED_NEW, 5)
    await db.commit()

    resp = await emails.log_email_open(_log_open_body(recruiter_id=recruiter.id), user, db)

    assert resp["email"] == "dana@acme.com"
    assert resp["balance"] == 4
    assert await emails.points_service.get_balance(db, user.id) == 4


async def test_log_open_duplicate_returns_409(db, user, recruiter):
    await emails.points_service.credit(db, user.id, emails.ActionType.RECRUITER_ADDED_NEW, 5)
    await db.commit()

    await emails.log_email_open(_log_open_body(recruiter_id=recruiter.id), user, db)

    with pytest.raises(HTTPException) as exc_info:
        await emails.log_email_open(_log_open_body(recruiter_id=recruiter.id), user, db)
    assert exc_info.value.status_code == 409

    # Only one point was ever charged
    assert await emails.points_service.get_balance(db, user.id) == 4


async def test_log_open_insufficient_balance_returns_402(db, user, recruiter):
    with pytest.raises(HTTPException) as exc_info:
        await emails.log_email_open(_log_open_body(recruiter_id=recruiter.id), user, db)
    assert exc_info.value.status_code == 402
    assert await emails.points_service.get_balance(db, user.id) == 0


async def test_log_open_unknown_recruiter_returns_404(db, user):
    with pytest.raises(HTTPException) as exc_info:
        await emails.log_email_open(_log_open_body(recruiter_id=999999), user, db)
    assert exc_info.value.status_code == 404


async def test_search_recruiters_does_not_return_email(db, user, recruiter):
    from app.routes import recruiters

    resp = await recruiters.search_recruiters("acme", user, db)
    assert len(resp["results"]) == 1
    assert "email" not in resp["results"][0]
