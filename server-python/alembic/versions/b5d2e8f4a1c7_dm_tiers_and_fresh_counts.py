"""daily matches: result tiers and fresh-job counts

Revision ID: b5d2e8f4a1c7
Revises: 9c4e7a1d2b36
Create Date: 2026-10-07 12:00:00.000000

Every job a run analyzes is now stored, shown or not, so no job is analyzed or
shown to the same person twice. dm_run_results.tier says which: strong and
maybe are the deck, hidden scored below it. NULL is a row from before this
revision, and those were all shown. dm_runs.fresh_jobs is how many new jobs
matched the person's filters, before the daily analysis cap.

Additive only, on dm_* tables.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'b5d2e8f4a1c7'
down_revision: Union[str, None] = '9c4e7a1d2b36'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("dm_run_results") as batch:
        batch.add_column(sa.Column("tier", sa.String(length=8), nullable=True))
    with op.batch_alter_table("dm_runs") as batch:
        batch.add_column(sa.Column("fresh_jobs", sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("dm_runs") as batch:
        batch.drop_column("fresh_jobs")
    with op.batch_alter_table("dm_run_results") as batch:
        batch.drop_column("tier")
