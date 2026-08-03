"""Tests for dual-key authorization: Gumroad subscription vs. the caller's own
Claude API key.

Covers the resolution order (subscription first, personal key as fallback), the
per-request client binding that decides whose credits pay for a call, and the
translation of Anthropic failures into messages a user can act on.
"""
import sys
from pathlib import Path

import httpx
import pytest
from anthropic import APIStatusError
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module
from main import (
    ERR_KEY_INVALID,
    ERR_NO_CREDIT,
    ERR_NO_KEY,
    ERR_RATE_LIMIT,
    _ac,
    _request_client,
    ai_error,
    require_auth,
    using_own_key,
)

FAKE_KEY = "sk-ant-api03-" + "x" * 20


@pytest.fixture(autouse=True)
def _reset_request_client():
    """Each test starts on the server's own client, as a fresh request would."""
    token = _request_client.set(None)
    yield
    _request_client.reset(token)


def _status_error(status: int, message: str) -> APIStatusError:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(status, request=request, json={"error": {"message": message}})
    return APIStatusError(message, response=response, body=None)


class TestResolutionOrder:
    async def test_valid_license_uses_server_key(self, monkeypatch):
        async def _ok(key):
            return key
        monkeypatch.setattr(main_module, "require_license", _ok)

        identity = await require_auth("LIC-1234", FAKE_KEY)

        assert identity == "LIC-1234"
        assert not using_own_key()
        assert _ac() is main_module.anthropic_client

    async def test_own_key_used_when_no_license(self, monkeypatch):
        identity = await require_auth("", FAKE_KEY)

        assert identity.startswith("byok:")
        assert using_own_key()
        assert _ac() is not main_module.anthropic_client

    async def test_same_own_key_reuses_one_client(self):
        await require_auth("", FAKE_KEY)
        first = _ac()
        _request_client.set(None)
        await require_auth("", FAKE_KEY)
        assert _ac() is first

    async def test_invalid_license_falls_back_to_own_key(self, monkeypatch):
        async def _reject(key):
            raise HTTPException(status_code=403, detail="Invalid or expired license key.")
        monkeypatch.setattr(main_module, "require_license", _reject)

        identity = await require_auth("EXPIRED", FAKE_KEY)

        assert identity.startswith("byok:")
        assert using_own_key()

    async def test_invalid_license_without_own_key_still_fails(self, monkeypatch):
        async def _reject(key):
            raise HTTPException(status_code=403, detail="Invalid or expired license key.")
        monkeypatch.setattr(main_module, "require_license", _reject)

        with pytest.raises(HTTPException) as exc:
            await require_auth("EXPIRED", "")
        assert exc.value.status_code == 403

    async def test_no_key_at_all_asks_for_one(self):
        with pytest.raises(HTTPException) as exc:
            await require_auth("", "")
        assert exc.value.status_code == 401
        assert ERR_NO_KEY in exc.value.detail

    async def test_malformed_own_key_rejected_without_calling_anthropic(self):
        with pytest.raises(HTTPException) as exc:
            await require_auth("", "my-claude-key")
        assert ERR_KEY_INVALID in exc.value.detail
        assert not using_own_key()

    async def test_missing_headers_are_not_treated_as_keys(self):
        """Endpoints called directly get FastAPI's Header sentinel, not None."""
        from fastapi import Header

        with pytest.raises(HTTPException) as exc:
            await require_auth(Header(None), Header(None))
        assert ERR_NO_KEY in exc.value.detail


class TestErrorTranslation:
    async def test_out_of_credit_on_own_key_explains_top_up(self):
        await require_auth("", FAKE_KEY)
        err = ai_error(_status_error(400, "Your credit balance is too low to access the API"))

        assert err.status_code == 402
        assert ERR_NO_CREDIT in err.detail
        assert "console.anthropic.com/settings/billing" in err.detail

    async def test_bad_own_key_points_at_settings(self):
        await require_auth("", FAKE_KEY)
        err = ai_error(_status_error(401, "invalid x-api-key"))

        assert err.status_code == 401
        assert ERR_KEY_INVALID in err.detail

    async def test_server_key_failure_never_blames_the_user(self):
        err = ai_error(_status_error(401, "invalid x-api-key"))

        assert err.status_code == 503
        assert ERR_KEY_INVALID not in err.detail

    async def test_rate_limit_is_reported_as_temporary(self):
        await require_auth("", FAKE_KEY)
        err = ai_error(_status_error(429, "rate_limit_error"))

        assert err.status_code == 429
        assert ERR_RATE_LIMIT in err.detail

    def test_unretryable_statuses_skip_the_retry_loop(self):
        assert not main_module._retryable(_status_error(401, "bad key"))
        assert not main_module._retryable(_status_error(400, "credit balance is too low"))
        assert main_module._retryable(_status_error(429, "slow down"))
        assert main_module._retryable(_status_error(529, "overloaded"))
        assert main_module._retryable(RuntimeError("boom"))


class TestUsageAccounting:
    async def test_own_key_calls_do_not_consume_the_monthly_quota(self, monkeypatch):
        """The 100-analyses cap protects the server's credits; a user paying with
        their own key isn't spending them."""
        calls = []
        monkeypatch.setattr(main_module, "increment_usage", lambda k: calls.append(k))

        await require_auth("", FAKE_KEY)
        if not using_own_key():
            main_module.increment_usage("x")

        assert calls == []
