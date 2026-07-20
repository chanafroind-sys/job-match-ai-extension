"""create v2_cv_semantic_maps

Revision ID: e7f1a9c3b2d4
Revises: d4f8b21c9a3e
Create Date: 2026-07-16 10:00:00.000000

V2-only table: one row per user, holding the AI structural map of their most
recently uploaded CV. Written once at upload time (POST /api/v2/semantic-map),
read-only during job navigation (GET /api/v2/cv-blocks) — never recomputed at
read time. Does not modify the existing users table.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e7f1a9c3b2d4'
down_revision: Union[str, None] = 'd4f8b21c9a3e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'v2_cv_semantic_maps',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('cv_hash', sa.String(length=32), nullable=False),
        sa.Column('blocks', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('(CURRENT_TIMESTAMP)'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', name='uq_v2_cv_semantic_maps_user_id'),
    )


def downgrade() -> None:
    op.drop_table('v2_cv_semantic_maps')
