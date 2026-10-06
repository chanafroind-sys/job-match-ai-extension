"""Voyage AI embeddings over plain httpx (already a dependency).

Jobs are embedded as `document`, CVs as `query`: retrieval here means "find
the postings this CV should apply to", and Voyage prepends a different
instruction for each side. Voyage vectors come back unit-length, so cosine
similarity and dot product rank identically.

Rate limits depend on the Voyage account: an account without a payment method
gets far lower per-minute limits than one with a card (where the free tokens
still apply). Instead of assuming either, the client adapts. A 429 halves the
request size and waits as long as Voyage asks (Retry-After) or a growing
pause, then carries on, so a large first backfill just takes longer instead of
failing. Only a long run of consecutive 429s gives up.
"""
import asyncio
import logging
import os

import httpx

from daily_matches import config

logger = logging.getLogger(__name__)

MAX_CONSECUTIVE_RATE_LIMITS = 10
RATE_LIMIT_PAUSES_S = (20, 40, 60)  # used when Voyage sends no Retry-After
SERVER_ERROR_RETRIES = 3

# Swapped out by tests.
_sleep = asyncio.sleep
_transport: httpx.AsyncBaseTransport | None = None


class EmbeddingUnavailable(RuntimeError):
    """No API key, a rejected request, or Voyage kept failing. Callers turn
    this into a clear "not ready" message instead of a stack trace."""


class _RateLimited(Exception):
    def __init__(self, retry_after: float | None):
        super().__init__("rate limited")
        self.retry_after = retry_after


def _next_batch(texts: list[str], start: int, max_texts: int) -> list[str]:
    batch, chars = [], 0
    for text in texts[start:start + max_texts]:
        if batch and chars + len(text) > config.EMBED_BATCH_CHARS:
            break
        batch.append(text)
        chars += len(text)
    return batch


def _retry_after(resp: httpx.Response) -> float | None:
    try:
        return max(1.0, float(resp.headers.get("retry-after", "")))
    except ValueError:
        return None


async def _post(client: httpx.AsyncClient, key: str, batch: list[str], input_type: str) -> list[list[float]]:
    payload = {
        "input": batch,
        "model": config.EMBED_MODEL,
        "input_type": input_type,
        "output_dimension": config.EMBED_DIM,
        "truncation": True,
    }
    last: Exception | None = None
    for attempt in range(SERVER_ERROR_RETRIES):
        try:
            resp = await client.post(config.VOYAGE_URL, json=payload,
                                     headers={"Authorization": f"Bearer {key}"}, timeout=60.0)
        except httpx.TransportError as exc:
            last = exc
            await _sleep(2 * (attempt + 1))
            continue
        if resp.status_code == 429:
            raise _RateLimited(_retry_after(resp))
        if resp.status_code >= 500:
            last = RuntimeError(f"Voyage HTTP {resp.status_code}")
            await _sleep(2 * (attempt + 1))
            continue
        if resp.status_code >= 400:
            raise EmbeddingUnavailable(f"Voyage HTTP {resp.status_code}: {resp.text[:200]}")
        data = sorted(resp.json().get("data", []), key=lambda d: d.get("index", 0))
        vectors = [d["embedding"] for d in data]
        if len(vectors) != len(batch) or any(len(v) != config.EMBED_DIM for v in vectors):
            raise EmbeddingUnavailable("Voyage returned an unexpected number or size of vectors")
        return vectors
    raise EmbeddingUnavailable(f"Voyage unreachable after retries: {last}")


async def embed_texts(texts: list[str], input_type: str) -> list[list[float]]:
    """One vector per input text, in order. Raises EmbeddingUnavailable."""
    if not texts:
        return []
    key = os.getenv("VOYAGE_API_KEY", "").strip()
    if not key:
        raise EmbeddingUnavailable("VOYAGE_API_KEY is not set")
    out: list[list[float]] = []
    max_texts = config.EMBED_BATCH_TEXTS
    limited = 0
    async with httpx.AsyncClient(transport=_transport) as client:
        while len(out) < len(texts):
            batch = _next_batch(texts, len(out), max_texts)
            try:
                out.extend(await _post(client, key, batch, input_type))
                limited = 0
            except _RateLimited as rl:
                limited += 1
                if limited > MAX_CONSECUTIVE_RATE_LIMITS:
                    raise EmbeddingUnavailable(
                        f"Voyage kept rate-limiting ({limited} times in a row); "
                        "an account without a payment method has very low per-minute limits")
                max_texts = max(1, len(batch) // 2)
                pause = rl.retry_after or RATE_LIMIT_PAUSES_S[min(limited, len(RATE_LIMIT_PAUSES_S)) - 1]
                logger.warning("[DM] Voyage rate limit: waiting %ss, next request %d texts (%d/%d done)",
                               pause, max_texts, len(out), len(texts))
                await _sleep(pause)
    return out
