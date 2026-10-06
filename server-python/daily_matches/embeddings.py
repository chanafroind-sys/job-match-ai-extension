"""Voyage AI embeddings over plain httpx (already a dependency).

Jobs are embedded as `document`, CVs as `query`: retrieval here means "find
the postings this CV should apply to", and Voyage prepends a different
instruction for each side. Voyage vectors come back unit-length, so cosine
similarity and dot product rank identically.

Rate limits depend on the Voyage account: one without a payment method allows
only a few requests per minute (about 3, seen in production), one with a card
2,000 (and the free tokens still apply). Instead of assuming either, the
client adapts:
  - the first 429 sets a pause between requests (Retry-After, else 20 s) that
    stays for the rest of the call: the limit is usually on requests, so
    spacing them out is what helps;
  - a request that is refused even after that pause is too big for the
    per-minute token limit, so it is halved;
  - three successes in a row double the size again, up to the normal batch.
Only a long run of consecutive 429s gives up.
"""
import asyncio
import logging
import os

import httpx

from daily_matches import config

logger = logging.getLogger(__name__)

MAX_CONSECUTIVE_RATE_LIMITS = 10
DEFAULT_PAUSE_S = 20.0  # between requests once Voyage pushes back without a Retry-After
GROW_AFTER_SUCCESSES = 3
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
    size = config.EMBED_BATCH_TEXTS
    pause = 0.0        # learned spacing between requests; 0 until Voyage pushes back
    refusals = 0       # consecutive 429s
    successes = 0      # consecutive successes since the last size change
    async with httpx.AsyncClient(transport=_transport) as client:
        while len(out) < len(texts):
            if pause:
                await _sleep(pause)
            batch = _next_batch(texts, len(out), size)
            try:
                out.extend(await _post(client, key, batch, input_type))
            except _RateLimited as rl:
                refusals += 1
                successes = 0
                if refusals > MAX_CONSECUTIVE_RATE_LIMITS:
                    raise EmbeddingUnavailable(
                        f"Voyage kept rate-limiting ({refusals - 1} times in a row); "
                        "an account without a payment method allows only a few requests per minute")
                if pause and refusals > 1:
                    size = max(1, len(batch) // 2)  # refused even when spaced out: too many tokens
                pause = max(pause, rl.retry_after or DEFAULT_PAUSE_S)
                logger.warning("[DM] Voyage rate limit: %ss between requests, next %d texts (%d/%d done)",
                               pause, size, len(out), len(texts))
                continue
            refusals = 0
            successes += 1
            if successes >= GROW_AFTER_SUCCESSES and size < config.EMBED_BATCH_TEXTS:
                size = min(config.EMBED_BATCH_TEXTS, size * 2)
                successes = 0
    return out
