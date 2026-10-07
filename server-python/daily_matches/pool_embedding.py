"""Keeps dm_job_embeddings in step with daily_job_pool, and enforces retention.

Runs after the daily sync (daily_matches/daily_pipeline.py, from the GitHub
workflow), and on demand from POST /api/daily-matches/admin/embed-pool. Only active jobs
whose embedding text changed, or whose vector came from another model, are
sent to Voyage, so a normal day embeds just the new postings.
"""
import logging

from sqlalchemy import delete, select

from app.models.job_pool import DailyJobPool
from daily_matches import config, embeddings, store
from daily_matches.models import DmCvEmbedding, DmJobEmbedding, DmRun, DmRunResult
from daily_matches.text_prep import job_embedding_text, sha256

logger = logging.getLogger(__name__)


async def embed_pool(session, now=None) -> dict:
    since = (now or config.utcnow()) - config.ACTIVE_WINDOW
    jobs = (await session.execute(
        select(DailyJobPool.id, DailyJobPool.title, DailyJobPool.company, DailyJobPool.category,
               DailyJobPool.seniority, DailyJobPool.description)
        .where(DailyJobPool.scraped_at >= since)
    )).all()
    index = await store.job_embedding_index(session)

    todo: list[tuple[str, str, str]] = []
    for job in jobs:
        text = job_embedding_text(job.title, job.company, job.category, job.seniority, job.description)
        digest = sha256(text)
        if index.get(job.id) != (config.EMBED_TAG, digest):
            todo.append((job.id, text, digest))

    report = {"model": config.EMBED_TAG, "active_jobs": len(jobs), "to_embed": len(todo), "embedded": 0}
    for i in range(0, len(todo), config.EMBED_BATCH_TEXTS):
        chunk = todo[i:i + config.EMBED_BATCH_TEXTS]
        # Release the connection while Voyage works: on a rate-limited account a
        # chunk can take minutes, and Neon closes a connection idle that long.
        # The next statement checks out a fresh one (the engine pre-pings).
        await session.commit()
        vectors = await embeddings.embed_texts([text for _, text, _ in chunk], "document")
        await store.upsert_job_embeddings(session, [
            {"job_id": job_id, "model": config.EMBED_TAG, "content_hash": digest, "embedding": vec}
            for (job_id, _, digest), vec in zip(chunk, vectors)
        ])
        await session.commit()  # per chunk, so a failure later keeps earlier progress
        report["embedded"] += len(chunk)
    logger.warning("[DM] job embeddings: %s", report)
    return report


async def purge_retention(session) -> dict:
    """Old decks, idle CV vectors, and vectors whose job was purged. On Postgres
    the foreign key already cascades job deletions; the explicit delete covers
    SQLite, where it isn't enforced."""
    now = config.utcnow()
    old_runs = select(DmRun.id).where(DmRun.match_day < config.match_day(now - config.RESULTS_RETENTION))
    results = await session.execute(delete(DmRunResult).where(DmRunResult.run_id.in_(old_runs)))
    cvs = await session.execute(delete(DmCvEmbedding).where(
        DmCvEmbedding.last_used_at < now - config.CV_EMBED_RETENTION))
    orphans = await session.execute(delete(DmJobEmbedding).where(
        DmJobEmbedding.job_id.not_in(select(DailyJobPool.id))))
    await session.commit()
    return {"deck_cards": results.rowcount or 0, "cv_vectors": cvs.rowcount or 0,
            "orphan_job_vectors": orphans.rowcount or 0}
