"""billing: subscriptions, their license keys, checkouts

Revision ID: a7d4e2c9f1b3
Revises: c6e2a9f4d1b8
Create Date: 2026-10-15 18:00:00.000000

Subscriptions sold through the card processor (billing/). Additive only.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'a7d4e2c9f1b3'
down_revision: Union[str, None] = 'c6e2a9f4d1b8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "billing_subscriptions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("provider_ref", sa.String(length=120), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=False, server_default=""),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("current_period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_resend_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_billing_subscriptions_provider_ref", "billing_subscriptions", ["provider_ref"])
    op.create_index("ix_billing_subscriptions_email", "billing_subscriptions", ["email"])
    op.create_table(
        "billing_keys",
        sa.Column("key_hash", sa.String(length=64), primary_key=True),
        sa.Column("subscription_id", sa.Integer(),
                  sa.ForeignKey("billing_subscriptions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_billing_keys_subscription_id", "billing_keys", ["subscription_id"])
    op.create_table(
        "billing_checkouts",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("subscription_id", sa.Integer(),
                  sa.ForeignKey("billing_subscriptions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("pending_key", sa.String(length=40), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("billing_checkouts")
    op.drop_index("ix_billing_keys_subscription_id", table_name="billing_keys")
    op.drop_table("billing_keys")
    op.drop_index("ix_billing_subscriptions_email", table_name="billing_subscriptions")
    op.drop_index("ix_billing_subscriptions_provider_ref", table_name="billing_subscriptions")
    op.drop_table("billing_subscriptions")
