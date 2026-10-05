"""Voyage AI embeddings over plain httpx (already a dependency).

Jobs are embedded as `document`, CVs as `query`: retrieval here means "find
the postings this CV should apply to", and Voyage prepends a different
instruction for each side. Voyage vectors come back unit-length, so cosine
similarity and dot product rank identically.
"""
import asyncio
import logging
import os

import httpx

from daily_matches import config

logger = logging.getLogger(__name__)


class EmbeddingUnavailable(RuntimeError):
    """No API key, or Voyage kept failing. Callers turn this into a clear
    "not ready" message instead of a stack trace."""


def _batches(texts: list[str]):
    batch, chars = [], 0
    for text in texts:
        if batch and (len(batch) >= config.EMBED_BATCH_TEXTS or chars + len(text) > config.EMBED_BATCH_CHARS):
            yield batch
            batch, chars = [], 0
        batch.append(text)
        chars += len(text)
    if batch:
        yield batch


async def _post(client: httpx.AsyncClient, key: str, batch: list[str], input_type: str) -> list[list[float]]:
    payload = {
        "input": batch,
        "model": config.EMBED_MODEL,
        "input_type": input_type,
        "output_dimension": config.EMBED_DIM,
        "truncation": True,
    }
    last: Exception | None = None
    for attempt in range(3):
        try:
            resp = await client.post(config.VOYAGE_URL, json=payload,
                                     headers={"Authorization": f"Bearer {key}"}, timeout=60.0)
            if resp.status_code in (429, 500, 502, 503, 504):
                last = RuntimeError(f"Voyage HTTP {resp.status_code}")
                await asyncio.sleep(2 * (attempt + 1))
                continue
            if resp.status_code >= 400:
                raise EmbeddingUnavailable(f"Voyage HTTP {resp.status_code}: {resp.text[:200]}")
            data = sorted(resp.json().get("data", []), key=lambda d: d.get("index", 0))
            vectors = [d["embedding"] for d in data]
            if len(vectors) != len(batch) or any(len(v) != config.EMBED_DIM for v in vectors):
                raise EmbeddingUnavailable("Voyage returned an unexpected number or size of vectors")
            return vectors
        except httpx.TransportError as e:
            last = e
            await asyncio.sleep(2 * (attempt + 1))
    raise EmbeddingUnavailable(f"Voyage unreachable after retries: {last}")


async def embed_texts(texts: list[str], input_type: str) -> list[list[float]]:
    """One vector per input text, in order. Raises EmbeddingUnavailable."""
    if not texts:
        return []
    key = os.getenv("VOYAGE_API_KEY", "").strip()
    if not key:
        raise EmbeddingUnavailable("VOYAGE_API_KEY is not set")
    out: list[list[float]] = []
    async with httpx.AsyncClient() as client:
        for batch in _batches(texts):
            out.extend(await _post(client, key, batch, input_type))
    return out
