"""create daily job pool table

Revision ID: 31b1084c4b25
Revises: f3a7c1e9b8d2
Create Date: 2026-09-23 12:51:58.896502

Creates daily_job_pool, mirroring app/models/job_pool.py:DailyJobPool.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '31b1084c4b25'
down_revision: Union[str, None] = 'f3a7c1e9b8d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'daily_job_pool',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('external_job_id', sa.String(length=255), nullable=True),
        sa.Column('title', sa.String(length=255), nullable=False),
        sa.Column('company', sa.String(length=255), nullable=False),
        sa.Column('category', sa.String(length=100), nullable=False),
        sa.Column('seniority', sa.String(length=50), nullable=False),
        sa.Column('url', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('published_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('scraped_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_daily_job_pool_category', 'daily_job_pool', ['category'])
    op.create_index('ix_daily_job_pool_seniority', 'daily_job_pool', ['seniority'])
    op.create_index('ix_daily_job_pool_published_at', 'daily_job_pool', ['published_at'])
    op.create_index('ix_job_match_lookup', 'daily_job_pool', ['category', 'seniority', 'published_at'])


def downgrade() -> None:
    op.drop_index('ix_job_match_lookup', table_name='daily_job_pool')
    op.drop_index('ix_daily_job_pool_published_at', table_name='daily_job_pool')
    op.drop_index('ix_daily_job_pool_seniority', table_name='daily_job_pool')
    op.drop_index('ix_daily_job_pool_category', table_name='daily_job_pool')
    op.drop_table('daily_job_pool')
