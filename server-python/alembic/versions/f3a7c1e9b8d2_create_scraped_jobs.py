"""create scraped_jobs

Revision ID: f3a7c1e9b8d2
Revises: e7f1a9c3b2d4
Create Date: 2026-07-29 10:00:00.000000

Moves the crowdsourced community jobs pool off raw_jobs.json (a file next to
main.py, wiped on every Render deploy because the container disk is ephemeral)
and into Postgres. Anonymous by design — no user_id column, no FK. url is
UNIQUE so dedup is a database constraint instead of a whole-file rewrite.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a7c1e9b8d2'
down_revision: Union[str, None] = 'e7f1a9c3b2d4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'scraped_jobs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('url', sa.String(length=1024), nullable=False),
        sa.Column('title', sa.String(length=255), nullable=False, server_default=''),
        sa.Column('text', sa.String(), nullable=False),
        sa.Column('scraped_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('url', name='uq_scraped_jobs_url'),
    )
    op.create_index('ix_scraped_jobs_scraped_at', 'scraped_jobs', ['scraped_at'])


def downgrade() -> None:
    op.drop_index('ix_scraped_jobs_scraped_at', table_name='scraped_jobs')
    op.drop_table('scraped_jobs')
