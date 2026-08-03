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
        return SimpleNamespace(
            content=[SimpleNamespace(text='{"score": 71, "summary": "ok"}')],
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


async def test_binding_reaches_sub_tasks(clients):
    """generate_cv fans out with gather/create_task; a context copied at task
    creation must already carry the caller's client."""
    seen = []

    async def _probe():
        seen.append(main_module._ac())

    await main_module.require_auth("", OWN_KEY)
    await asyncio.gather(_probe(), _probe())

    assert seen == [clients.personal, clients.personal]
