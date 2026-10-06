"""Voyage client: adapts to rate limits instead of failing the backfill."""
import json

import httpx
import pytest

from daily_matches import config, embeddings


@pytest.fixture
def voyage(monkeypatch):
    """A fake Voyage that answers 429 to requests over `limit` texts until
    `refusals` run out, and records every request and pause."""
    state = {"limit": 10_000, "refusals": 0, "requests": [], "pauses": [], "status": None, "retry_after": None}

    def handler(request):
        body = json.loads(request.content)
        n = len(body["input"])
        state["requests"].append(n)
        if state["status"]:
            return httpx.Response(state["status"], text="nope")
        if n > state["limit"] or state["refusals"] > 0:
            state["refusals"] = max(0, state["refusals"] - 1)
            headers = {"retry-after": str(state["retry_after"])} if state["retry_after"] else {}
            return httpx.Response(429, headers=headers, json={"detail": "rate limit"})
        return httpx.Response(200, json={"data": [
            {"index": i, "embedding": [float(len(t))] + [0.0] * (config.EMBED_DIM - 1)}
            for i, t in enumerate(body["input"])]})

    async def fake_sleep(seconds):
        state["pauses"].append(seconds)

    monkeypatch.setenv("VOYAGE_API_KEY", "test-key")
    monkeypatch.setattr(embeddings, "_transport", httpx.MockTransport(handler))
    monkeypatch.setattr(embeddings, "_sleep", fake_sleep)
    return state


TEXTS = [f"job {i} " + "x" * i for i in range(100)]


async def test_plain_run_keeps_order(voyage):
    vectors = await embeddings.embed_texts(TEXTS, "document")
    assert [v[0] for v in vectors] == [float(len(t)) for t in TEXTS]
    assert voyage["requests"] == [64, 36] and voyage["pauses"] == []


async def test_429_shrinks_requests_until_they_fit(voyage):
    voyage["limit"] = 10  # an account that only accepts small requests
    vectors = await embeddings.embed_texts(TEXTS, "document")
    assert len(vectors) == 100 and [v[0] for v in vectors] == [float(len(t)) for t in TEXTS]
    assert voyage["requests"][:4] == [64, 32, 16, 8]
    assert all(n <= 10 for n in voyage["requests"][4:])


async def test_waits_as_long_as_voyage_asks(voyage):
    voyage["refusals"], voyage["retry_after"] = 2, 7
    await embeddings.embed_texts(TEXTS[:5], "query")
    assert voyage["pauses"] == [7.0, 7.0]


async def test_growing_pause_without_retry_after(voyage):
    voyage["refusals"] = 4
    await embeddings.embed_texts(TEXTS[:5], "query")
    assert voyage["pauses"] == [20, 40, 60, 60]


async def test_gives_up_after_too_many_refusals_in_a_row(voyage):
    voyage["refusals"] = 999
    with pytest.raises(embeddings.EmbeddingUnavailable, match="rate-limiting"):
        await embeddings.embed_texts(TEXTS[:5], "query")
    assert len(voyage["pauses"]) == embeddings.MAX_CONSECUTIVE_RATE_LIMITS


async def test_rejected_request_fails_at_once(voyage):
    voyage["status"] = 401
    with pytest.raises(embeddings.EmbeddingUnavailable, match="HTTP 401"):
        await embeddings.embed_texts(TEXTS[:5], "query")
    assert voyage["requests"] == [5]


async def test_missing_key(monkeypatch):
    monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
    with pytest.raises(embeddings.EmbeddingUnavailable, match="not set"):
        await embeddings.embed_texts(["x"], "query")
