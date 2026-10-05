"""Daily Matches tables. All new; app/core/models.py, app/models/job_pool.py and
the daily_job_pool table itself are not modified.

The embedding columns are declared as JSON here. That is the real type on
SQLite (dev, tests) and in the no-pgvector fallback. On Postgres with pgvector
the migration creates them as vector(1024), and daily_matches/store.py only
reaches them through explicit SQL, never through these ORM attributes.
"""
from datetime import date, datetime

from sqlalchemy import (
    JSON,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

import app.models.job_pool  # noqa: F401  (registers daily_job_pool, the FK target below)
from app.core.db import Base
from daily_matches.config import utcnow


class DmJobEmbedding(Base):
    """One vector per daily_job_pool row, rewritten when the job text changes."""

    __tablename__ = "dm_job_embeddings"

    job_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("daily_job_pool.id", ondelete="CASCADE"), primary_key=True)
    model: Mapped[str] = mapped_column(String(40), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    embedding: Mapped[list] = mapped_column(JSON, nullable=False, deferred=True)
    embedded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class DmCvEmbedding(Base):
    """The lazy CV vector cache, keyed by a hash of the CV text. No CV text is
    stored anywhere on the server."""

    __tablename__ = "dm_cv_embeddings"
    __table_args__ = (
        UniqueConstraint("subject", "cv_hash", "model", name="uq_dm_cv_embeddings_subject_hash_model"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subject: Mapped[str] = mapped_column(String(80), nullable=False)
    cv_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    model: Mapped[str] = mapped_column(String(40), nullable=False)
    embedding: Mapped[list] = mapped_column(JSON, nullable=False, deferred=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class DmRun(Base):
    """One row per subject per Israel calendar day. The unique constraint is the
    once-a-day lock: a second click, tab or device can't create a second run."""

    __tablename__ = "dm_runs"
    __table_args__ = (UniqueConstraint("subject", "match_day", name="uq_dm_runs_subject_day"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    subject: Mapped[str] = mapped_column(String(80), nullable=False)
    match_day: Mapped[date] = mapped_column(Date, nullable=False)
    entitlement: Mapped[str] = mapped_column(String(16), nullable=False)  # subscription | trial
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # running | done | failed
    pool_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    candidates: Mapped[int | None] = mapped_column(Integer, nullable=True)
    results: Mapped[int | None] = mapped_column(Integer, nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_read_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_write_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class DmRunResult(Base):
    """One card of a deck. job_snapshot keeps what the card shows, so a deck
    still renders after daily_job_pool purges the job."""

    __tablename__ = "dm_run_results"
    __table_args__ = (UniqueConstraint("run_id", "job_id", name="uq_dm_run_results_run_job"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("dm_runs.id", ondelete="CASCADE"), nullable=False)
    job_id: Mapped[str] = mapped_column(String(32), nullable=False)
    rank: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    vector_score: Mapped[float] = mapped_column(Float, nullable=False)
    match_score: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)  # None = analysis failed
    best_cv_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)
    analysis: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    job_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    user_action: Mapped[str | None] = mapped_column(String(16), nullable=True)  # viewed | saved | skipped | applied
    action_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DmTrial(Base):
    """One free run per install and per CV, ever. A row is reserved when a trial
    run starts and becomes consumed only if the run delivers cards; a failed
    run deletes it."""

    __tablename__ = "dm_trials"
    __table_args__ = (Index("ix_dm_trials_ip_created", "ip_hash", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    install_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    cv_fingerprint: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    ip_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    run_id: Mapped[int | None] = mapped_column(ForeignKey("dm_runs.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # reserved | consumed
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
