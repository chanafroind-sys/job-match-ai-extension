"""daily matches: what each day's collection brought, per source

Revision ID: a4c9e2f7b1d5
Revises: c8e1f6a3d9b2
Create Date: 2026-10-13 15:00:00.000000

dm_pipeline_days holds one aggregate summary per Israel day of the daily
pipeline (new jobs per source, LinkedIn's state, boards found), for the
health report (daily_matches/report.py). Additive only.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a4c9e2f7b1d5'
down_revision: Union[str, None] = 'c8e1f6a3d9b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "dm_pipeline_days",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("summary", sa.JSON(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("dm_pipeline_days")
