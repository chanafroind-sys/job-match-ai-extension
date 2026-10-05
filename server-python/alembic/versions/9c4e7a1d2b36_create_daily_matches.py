"""create daily matches tables

Revision ID: 9c4e7a1d2b36
Revises: 31b1084c4b25
Create Date: 2026-10-04 12:00:00.000000

Creates the dm_* tables for Daily Matches (daily_matches/models.py). Additive
only: no existing table is altered, including daily_job_pool. Job vectors live
in their own table, keyed one-to-one on daily_job_pool.id.

The web service runs `alembic upgrade head` before it starts, so a failing
migration would take every existing feature down. This one therefore never
fails over pgvector. On Postgres it enables the extension when the server
offers it. If the extension is missing or can't be created, the vector columns
become JSON, and daily_matches/store.py, which reads the live column type,
searches in Python instead.
"""
import logging
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = '9c4e7a1d2b36'
down_revision: Union[str, None] = '31b1084c4b25'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

log = logging.getLogger("alembic.runtime.migration")

EMBED_DIM = 1024  # daily_matches/config.py EMBED_DIM


class _Vector(sa.types.UserDefinedType):
    cache_ok = True

    def __init__(self, dim: int):
        self.dim = dim

    def get_col_spec(self, **kw):
        return f"vector({self.dim})"


def _embedding_type():
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return sa.JSON()
    available = bind.execute(sa.text(
        "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).scalar()
    if not available:
        log.warning("pgvector is not available on this server; dm_* vectors will be JSON")
        return sa.JSON()
    try:
        with bind.begin_nested():  # a savepoint, so a refusal doesn't abort the migration
            bind.execute(sa.text("CREATE EXTENSION IF NOT EXISTS vector"))
    except Exception as exc:  # noqa: BLE001
        log.warning("CREATE EXTENSION vector failed (%s); dm_* vectors will be JSON", exc)
        return sa.JSON()
    return _Vector(EMBED_DIM)


def upgrade() -> None:
    embedding = _embedding_type()

    op.create_table(
        'dm_job_embeddings',
        sa.Column('job_id', sa.String(length=32),
                  sa.ForeignKey('daily_job_pool.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('model', sa.String(length=40), nullable=False),
        sa.Column('content_hash', sa.String(length=64), nullable=False),
        sa.Column('embedding', embedding, nullable=False),
        sa.Column('embedded_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        'dm_cv_embeddings',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('subject', sa.String(length=80), nullable=False),
        sa.Column('cv_hash', sa.String(length=64), nullable=False),
        sa.Column('model', sa.String(length=40), nullable=False),
        sa.Column('embedding', embedding, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('last_used_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint('subject', 'cv_hash', 'model', name='uq_dm_cv_embeddings_subject_hash_model'),
    )

    op.create_table(
        'dm_runs',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('subject', sa.String(length=80), nullable=False),
        sa.Column('match_day', sa.Date(), nullable=False),
        sa.Column('entitlement', sa.String(length=16), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('pool_size', sa.Integer(), nullable=True),
        sa.Column('candidates', sa.Integer(), nullable=True),
        sa.Column('results', sa.Integer(), nullable=True),
        sa.Column('input_tokens', sa.Integer(), nullable=True),
        sa.Column('output_tokens', sa.Integer(), nullable=True),
        sa.Column('cache_read_tokens', sa.Integer(), nullable=True),
        sa.Column('cache_write_tokens', sa.Integer(), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.UniqueConstraint('subject', 'match_day', name='uq_dm_runs_subject_day'),
    )

    op.create_table(
        'dm_run_results',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('run_id', sa.Integer(), sa.ForeignKey('dm_runs.id', ondelete='CASCADE'), nullable=False),
        sa.Column('job_id', sa.String(length=32), nullable=False),
        sa.Column('rank', sa.SmallInteger(), nullable=False),
        sa.Column('vector_score', sa.Float(), nullable=False),
        sa.Column('match_score', sa.SmallInteger(), nullable=True),
        sa.Column('best_cv_ref', sa.String(length=64), nullable=True),
        sa.Column('analysis', sa.JSON(), nullable=True),
        sa.Column('job_snapshot', sa.JSON(), nullable=False),
        sa.Column('user_action', sa.String(length=16), nullable=True),
        sa.Column('action_at', sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint('run_id', 'job_id', name='uq_dm_run_results_run_job'),
    )

    op.create_table(
        'dm_trials',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('install_hash', sa.String(length=64), nullable=False, unique=True),
        sa.Column('cv_fingerprint', sa.String(length=64), nullable=False, unique=True),
        sa.Column('ip_hash', sa.String(length=64), nullable=False),
        sa.Column('run_id', sa.Integer(), sa.ForeignKey('dm_runs.id', ondelete='SET NULL'), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index('ix_dm_trials_ip_created', 'dm_trials', ['ip_hash', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_dm_trials_ip_created', table_name='dm_trials')
    op.drop_table('dm_trials')
    op.drop_table('dm_run_results')
    op.drop_table('dm_runs')
    op.drop_table('dm_cv_embeddings')
    op.drop_table('dm_job_embeddings')
    # The vector extension is left installed: dropping it could break other users of it.
