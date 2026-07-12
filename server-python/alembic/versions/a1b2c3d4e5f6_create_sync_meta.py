"""create sync_meta

Revision ID: a1b2c3d4e5f6
Revises: c9741b45e070
Create Date: 2026-07-12 16:00:00.000000

Lazy-sync bookkeeping table for the employees Google Sheet pull (Render's free
tier has no cron, so the sync timestamp is checked/updated on request instead).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'c9741b45e070'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'sync_meta',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('key', sa.String(length=64), nullable=False),
        sa.Column('last_synced_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('key'),
    )


def downgrade() -> None:
    op.drop_table('sync_meta')
