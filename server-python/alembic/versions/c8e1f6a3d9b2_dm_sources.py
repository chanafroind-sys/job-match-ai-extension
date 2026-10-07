"""daily matches: discovered company job boards

Revision ID: c8e1f6a3d9b2
Revises: b5d2e8f4a1c7
Create Date: 2026-10-07 15:00:00.000000

dm_sources holds company job boards found through aggregators' apply links
(daily_matches/sources/registry.py). Additive only.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c8e1f6a3d9b2'
down_revision: Union[str, None] = 'b5d2e8f4a1c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dm_sources",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ats", sa.String(length=20), nullable=False),
        sa.Column("slug", sa.String(length=160), nullable=False),
        sa.Column("company", sa.String(length=255), nullable=False),
        sa.Column("params", sa.JSON(), nullable=False),
        sa.Column("found_via", sa.String(length=20), nullable=False),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_count", sa.Integer(), nullable=True),
        sa.Column("failures", sa.Integer(), nullable=False, server_default="0"),
        sa.UniqueConstraint("ats", "slug", name="uq_dm_sources_ats_slug"),
    )


def downgrade() -> None:
    op.drop_table("dm_sources")
