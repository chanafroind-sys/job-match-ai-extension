"""monitoring: server failures, paying licenses, AI usage

Revision ID: c6e2a9f4d1b8
Revises: b7d3f1a9c2e4
Create Date: 2026-10-15 13:00:00.000000

What the admin console's system-status panel reads (app/core/monitoring.py):
app_errors (5xx, exceptions, slow requests), license_activity (a fingerprint
per license that verified, its plan and last verification), ai_usage_daily
(tokens per day and model). Aggregates and fingerprints only. Additive only.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'c6e2a9f4d1b8'
down_revision: Union[str, None] = 'b7d3f1a9c2e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "app_errors",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("route", sa.String(length=160), nullable=False),
        sa.Column("status", sa.Integer(), nullable=True),
        sa.Column("detail", sa.String(length=300), nullable=False, server_default=""),
        sa.Column("seconds", sa.Integer(), nullable=True),
    )
    op.create_index("ix_app_errors_at", "app_errors", ["at"])
    op.create_table(
        "license_activity",
        sa.Column("key_hash", sa.String(length=64), primary_key=True),
        sa.Column("tier", sa.String(length=20), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_license_activity_last_seen", "license_activity", ["last_seen"])
    op.create_table(
        "ai_usage_daily",
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("model", sa.String(length=60), primary_key=True),
        sa.Column("calls", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cache_read_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cache_write_tokens", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("ai_usage_daily")
    op.drop_index("ix_license_activity_last_seen", table_name="license_activity")
    op.drop_table("license_activity")
    op.drop_index("ix_app_errors_at", table_name="app_errors")
    op.drop_table("app_errors")
