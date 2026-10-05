"""Vector storage and search, with two interchangeable backends.

pgvector — Postgres where the migration could create vector(1024) columns.
    Vectors travel to the database as text literals cast explicitly
    (CAST(CAST(:v AS text) AS vector)) and never travel back: searches return
    similarities, and the CV vector is read inside the query by row id. So no
    vector codec is ever registered on the shared engine; registering one would
    make every connection, V1's included, depend on the extension.
json — SQLite (dev, tests), or Postgres without pgvector. Vectors are JSON and
    cosine runs in Python. Fine for a pool of a few thousand jobs.

The mode is read from the live column type, so it always matches what the
migration actually created.
"""
import json
import math
from datetime import datetime

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.job_pool import DailyJobPool
from daily_matches import config
from daily_matches.models import DmCvEmbedding, DmJobEmbedding, DmRun, DmRunResult

# Jobs the user acted on never come back in a later deck.
EXCLUDED_ACTIONS = ("saved", "skipped", "applied")

_mode_cache: dict[str, str] = {}


async def vector_mode(session: AsyncSession) -> str:
    bind = session.bind
    key = str(bind.url)
    if key in _mode_cache:
        return _mode_cache[key]
    mode = "json"
    if bind.dialect.name == "postgresql":
        udt = (await session.execute(text(
            "SELECT udt_name FROM information_schema.columns "
            "WHERE table_name = 'dm_job_embeddings' AND column_name = 'embedding'"
        ))).scalar()
        mode = "pgvector" if udt == "vector" else "json"
    _mode_cache[key] = mode
    return mode


def to_pgvector(vec: list[float]) -> str:
    return "[" + ",".join(format(float(x), ".7g") for x in vec) + "]"


def _insert(session: AsyncSession):
    if session.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    return insert


# ── Job vectors ───────────────────────────────────────────────────────────────

async def job_embedding_index(session: AsyncSession) -> dict[str, tuple[str, str]]:
    rows = await session.execute(select(DmJobEmbedding.job_id, DmJobEmbedding.model, DmJobEmbedding.content_hash))
    return {r.job_id: (r.model, r.content_hash) for r in rows}


async def upsert_job_embeddings(session: AsyncSession, rows: list[dict]) -> None:
    """rows: {job_id, model, content_hash, embedding}. Caller commits."""
    if not rows:
        return
    now = config.utcnow()
    if await vector_mode(session) == "pgvector":
        await session.execute(text(
            "INSERT INTO dm_job_embeddings (job_id, model, content_hash, embedding, embedded_at) "
            "VALUES (:job_id, :model, :content_hash, CAST(CAST(:embedding AS text) AS vector), :now) "
            "ON CONFLICT (job_id) DO UPDATE SET model = excluded.model, "
            "content_hash = excluded.content_hash, embedding = excluded.embedding, "
            "embedded_at = excluded.embedded_at"
        ), [{**r, "embedding": to_pgvector(r["embedding"]), "now": now} for r in rows])
        return
    insert = _insert(session)
    stmt = insert(DmJobEmbedding).values([{**r, "embedded_at": now} for r in rows])
    stmt = stmt.on_conflict_do_update(
        index_elements=["job_id"],
        set_={c: stmt.excluded[c] for c in ("model", "content_hash", "embedding", "embedded_at")},
    )
    await session.execute(stmt)


# ── CV vectors ────────────────────────────────────────────────────────────────

async def find_cv_embedding(session: AsyncSession, subject: str, cv_hash: str) -> int | None:
    return (await session.execute(select(DmCvEmbedding.id).where(
        DmCvEmbedding.subject == subject, DmCvEmbedding.cv_hash == cv_hash,
        DmCvEmbedding.model == config.EMBED_TAG,
    ))).scalar()


async def save_cv_embedding(session: AsyncSession, subject: str, cv_hash: str, vec: list[float]) -> int:
    """Insert-or-refresh; returns the row id. Caller commits."""
    now = config.utcnow()
    params = {"subject": subject, "cv_hash": cv_hash, "model": config.EMBED_TAG, "now": now}
    if await vector_mode(session) == "pgvector":
        row_id = (await session.execute(text(
            "INSERT INTO dm_cv_embeddings (subject, cv_hash, model, embedding, created_at, last_used_at) "
            "VALUES (:subject, :cv_hash, :model, CAST(CAST(:embedding AS text) AS vector), :now, :now) "
            "ON CONFLICT (subject, cv_hash, model) DO UPDATE SET embedding = excluded.embedding, "
            "last_used_at = excluded.last_used_at RETURNING id"
        ), {**params, "embedding": to_pgvector(vec)})).scalar()
        return int(row_id)
    insert = _insert(session)
    stmt = insert(DmCvEmbedding).values(
        subject=subject, cv_hash=cv_hash, model=config.EMBED_TAG, embedding=vec,
        created_at=now, last_used_at=now,
    ).on_conflict_do_update(
        index_elements=["subject", "cv_hash", "model"],
        set_={"embedding": vec, "last_used_at": now},
    )
    await session.execute(stmt)
    return int(await find_cv_embedding(session, subject, cv_hash))


async def touch_cv_embeddings(session: AsyncSession, row_ids: list[int]) -> None:
    if row_ids:
        await session.execute(update(DmCvEmbedding).where(DmCvEmbedding.id.in_(row_ids))
                              .values(last_used_at=config.utcnow()))


# ── Pool counts ───────────────────────────────────────────────────────────────

async def pool_counts(session: AsyncSession, since: datetime) -> dict:
    active = (await session.execute(select(func.count()).select_from(DailyJobPool)
                                    .where(DailyJobPool.scraped_at >= since))).scalar() or 0
    embedded = (await session.execute(
        select(func.count()).select_from(DmJobEmbedding)
        .join(DailyJobPool, DailyJobPool.id == DmJobEmbedding.job_id)
        .where(DailyJobPool.scraped_at >= since, DmJobEmbedding.model == config.EMBED_TAG)
    )).scalar() or 0
    return {"active": int(active), "embedded": int(embedded)}


# ── Search ────────────────────────────────────────────────────────────────────

def _excluded_subquery(subject: str):
    return (select(DmRunResult.job_id)
            .join(DmRun, DmRun.id == DmRunResult.run_id)
            .where(DmRun.subject == subject, DmRunResult.user_action.in_(EXCLUDED_ACTIONS)))


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _as_vector(value) -> list[float]:
    return json.loads(value) if isinstance(value, str) else list(value)


async def search_jobs(session: AsyncSession, cv_rows: dict[str, int], subject: str,
                      since: datetime, limit: int) -> dict[str, list[tuple[str, float]]]:
    """For each CV (alias → dm_cv_embeddings.id), the `limit` most similar
    active jobs the subject hasn't acted on, best first."""
    out: dict[str, list[tuple[str, float]]] = {}
    if await vector_mode(session) == "pgvector":
        excluded_sql = (
            "SELECT r.job_id FROM dm_run_results r JOIN dm_runs u ON u.id = r.run_id "
            "WHERE u.subject = :subject AND r.user_action IN ('saved', 'skipped', 'applied')"
        )
        sql = text(
            "SELECT e.job_id AS job_id, 1 - (e.embedding <=> q.embedding) AS sim "
            "FROM dm_job_embeddings e "
            "JOIN daily_job_pool j ON j.id = e.job_id "
            "CROSS JOIN (SELECT embedding FROM dm_cv_embeddings WHERE id = :cv_row) q "
            "WHERE j.scraped_at >= :since AND e.model = :model "
            f"AND e.job_id NOT IN ({excluded_sql}) "
            "ORDER BY e.embedding <=> q.embedding LIMIT :lim"
        )
        for alias, row_id in cv_rows.items():
            rows = await session.execute(sql, {"cv_row": row_id, "since": since, "model": config.EMBED_TAG,
                                               "subject": subject, "lim": limit})
            out[alias] = [(r.job_id, float(r.sim)) for r in rows]
        return out

    jobs = (await session.execute(
        select(DmJobEmbedding.job_id, DmJobEmbedding.embedding)
        .join(DailyJobPool, DailyJobPool.id == DmJobEmbedding.job_id)
        .where(DailyJobPool.scraped_at >= since, DmJobEmbedding.model == config.EMBED_TAG,
               DmJobEmbedding.job_id.not_in(_excluded_subquery(subject)))
    )).all()
    job_vecs = [(r.job_id, _as_vector(r.embedding)) for r in jobs]
    cvs = (await session.execute(select(DmCvEmbedding.id, DmCvEmbedding.embedding)
                                 .where(DmCvEmbedding.id.in_(list(cv_rows.values()))))).all()
    cv_vecs = {r.id: _as_vector(r.embedding) for r in cvs}
    for alias, row_id in cv_rows.items():
        vec = cv_vecs.get(row_id)
        if vec is None:
            out[alias] = []
            continue
        scored = sorted(((jid, _cosine(vec, jv)) for jid, jv in job_vecs), key=lambda t: -t[1])
        out[alias] = scored[:limit]
    return out
