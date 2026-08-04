"""End-to-end check that a caller's own Claude key actually pays for the call.

The client is bound per-request through a ContextVar rather than passed down
every prompt helper, so the thing worth proving is that the binding survives the
paths that leave the endpoint's own frame: a plain endpoint, a StreamingResponse
whose generator runs after the handler returns, and a sub-task spawned with
asyncio.gather.
"""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module

OWN_KEY = "sk-ant-api03-" + "z" * 20


class _FakeMessages:
    def __init__(self, owner):
        self._owner = owner

    async def create(self, **kwargs):
        self._owner.calls.append(kwargs)
        # /api/extract-profile validates the shape it gets back, so answer it
        # with a real-looking profile rather than the generic analysis blob.
        blob = json.dumps(kwargs, default=str)
        text = ('{"experience": {"backend": {"python": {"industry_years": 8}}}, '
                '"industry_summary": {"total_years_industry": 8}}'
                if "CANDIDATE CV" in blob or "profile" in blob.lower()
                else '{"score": 71, "summary": "ok"}')
        return SimpleNamespace(
            content=[SimpleNamespace(text=text)],
            stop_reason="end_turn",
            usage=SimpleNamespace(cache_read_input_tokens=0, cache_creation_input_tokens=0),
        )

    def stream(self, **kwargs):
        self._owner.calls.append(kwargs)
        return _FakeStream(self._owner)


class _FakeStream:
    def __init__(self, owner):
        self._owner = owner

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        async def _gen():
            for chunk in ('###STRATEGY###{"fit_type":"high_fit","questions":[]}',
                          "###SUMMARY###", "סיכום קצר"):
                yield chunk
        return _gen()


class FakeClient:
    """Stands in for an AsyncAnthropic client and records what it was asked to do."""

    def __init__(self, label):
        self.label = label
        self.calls = []
        self.messages = _FakeMessages(self)


@pytest.fixture
def clients(monkeypatch):
    server = FakeClient("server")
    personal = FakeClient("personal")
    monkeypatch.setattr(main_module, "anthropic_client", server)
    monkeypatch.setattr(main_module, "_byok_client", lambda key: personal)
    return SimpleNamespace(server=server, personal=personal)


def test_plain_endpoint_uses_the_callers_key(clients):
    transport = TestClient(main_module.app)
    with transport:
        resp = transport.post(
            "/api/analyze",
            headers={"X-Anthropic-Key": OWN_KEY},
            json={"cvText": "CV text here", "jobText": "Job text here", "answers": []},
        )

    assert resp.status_code == 200, resp.text
    assert len(clients.personal.calls) == 1
    assert clients.server.calls == []


def test_streaming_endpoint_uses_the_callers_key(clients):
    """The SSE generator runs after the handler returns — the binding has to
    survive into the task Starlette iterates it from."""
    transport = TestClient(main_module.app)
    with transport:
        resp = transport.post(
            "/api/stream-deep-analysis",
            headers={"X-Anthropic-Key": OWN_KEY},
            json={"cvText": "CV text here", "jobText": "Job text here", "answers": []},
        )

    assert resp.status_code == 200, resp.text
    assert "[DONE]" in resp.text
    assert len(clients.personal.calls) == 1
    assert clients.server.calls == []


def test_no_key_asks_for_one_instead_of_calling_anything(clients):
    transport = TestClient(main_module.app)
    with transport:
        resp = transport.post(
            "/api/analyze",
            json={"cvText": "CV text here", "jobText": "Job text here", "answers": []},
        )

    assert resp.status_code == 401
    assert main_module.ERR_NO_KEY in resp.json()["detail"]
    assert clients.personal.calls == []
    assert clients.server.calls == []


def test_streaming_no_key_reports_through_the_event_stream(clients):
    """An SSE endpoint can't answer 401 — the client is already reading a stream,
    so the error has to arrive as an event or the UI hangs."""
    transport = TestClient(main_module.app)
    with transport:
        resp = transport.post(
            "/api/stream-deep-analysis",
            json={"cvText": "CV text here", "jobText": "Job text here", "answers": []},
        )

    assert resp.status_code == 200
    first = json.loads(resp.text.split("data: ", 1)[1].split("\n", 1)[0])
    assert main_module.ERR_NO_KEY in first["error"]
    assert clients.personal.calls == []


class TestKeylessCvAnalysis:
    """/api/extract-profile is deliberately open: a new user's first CV upload
    has to produce a profile, or every later job match scores against nothing."""

    CV = "Senior Backend Engineer with 8 years of Python, FastAPI and PostgreSQL experience. " * 3

    @pytest.fixture(autouse=True)
    def _fresh_limiter(self):
        from app.core import rate_limit
        rate_limit._hits.clear()
        yield
        rate_limit._hits.clear()

    def test_runs_on_the_server_key_with_no_key_at_all(self, clients):
        transport = TestClient(main_module.app)
        with transport:
            resp = transport.post("/api/extract-profile", json={"cvText": self.CV})

        assert resp.status_code == 200, resp.text
        assert len(clients.server.calls) == 1
        assert clients.personal.calls == []

    def test_a_personal_key_still_pays_for_itself(self, clients):
        transport = TestClient(main_module.app)
        with transport:
            resp = transport.post("/api/extract-profile",
                                  headers={"X-Anthropic-Key": OWN_KEY},
                                  json={"cvText": self.CV})

        assert resp.status_code == 200, resp.text
        assert len(clients.personal.calls) == 1
        assert clients.server.calls == []

    def test_keyless_callers_are_rate_limited_per_ip(self, clients, monkeypatch):
        monkeypatch.setattr(main_module, "ANON_PROFILE_MAX", 2)
        transport = TestClient(main_module.app)
        with transport:
            for _ in range(2):
                assert transport.post("/api/extract-profile",
                                      json={"cvText": self.CV}).status_code == 200
            blocked = transport.post("/api/extract-profile", json={"cvText": self.CV})

        assert blocked.status_code == 429
        assert main_module.ERR_RATE_LIMIT in blocked.json()["detail"]
        assert len(clients.server.calls) == 2   # the blocked call never reached Claude

    def test_the_limit_does_not_apply_to_callers_with_a_key(self, clients, monkeypatch):
        monkeypatch.setattr(main_module, "ANON_PROFILE_MAX", 1)
        transport = TestClient(main_module.app)
        with transport:
            for _ in range(3):
                resp = transport.post("/api/extract-profile",
                                      headers={"X-Anthropic-Key": OWN_KEY},
                                      json={"cvText": self.CV})
                assert resp.status_code == 200, resp.text

        assert len(clients.personal.calls) == 3


async def test_binding_reaches_sub_tasks(clients):
    """generate_cv fans out with gather/create_task; a context copied at task
    creation must already carry the caller's client."""
    seen = []

    async def _probe():
        seen.append(main_module._ac())

    await main_module.require_auth("", OWN_KEY)
    await asyncio.gather(_probe(), _probe())

    assert seen == [clients.personal, clients.personal]
