"""daily matches: jobs a paid source already charged for

Revision ID: b7d3f1a9c2e4
Revises: a4c9e2f7b1d5
Create Date: 2026-10-15 10:00:00.000000

dm_paid_jobs remembers, for a few days, every job LinkedIn's Apify Actor
charged for, kept in the pool or not, so the next search skips it
(daily_matches/sources/linkedin_apify.py). Additive only.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b7d3f1a9c2e4'
down_revision: Union[str, None] = 'a4c9e2f7b1d5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dm_paid_jobs",
        sa.Column("source", sa.String(length=20), primary_key=True),
        sa.Column("external_id", sa.String(length=64), primary_key=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_dm_paid_jobs_paid_at", "dm_paid_jobs", ["paid_at"])


def downgrade() -> None:
    op.drop_index("ix_dm_paid_jobs_paid_at", table_name="dm_paid_jobs")
    op.drop_table("dm_paid_jobs")
