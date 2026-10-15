"""Billing tables (migration a7d4e2c9f1b3). All new; nothing existing changes.

Keys are stored as SHA-256 hashes. The one plaintext copy is the checkout's
pending_key, held only until the extension that paid collects it once.
"""
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class BillingSubscription(Base):
    __tablename__ = "billing_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    # The processor's id for the standing order; renewals and cancellations find the row by it.
    provider_ref: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(254), nullable=False, default="", index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False)  # active | past_due | cancelled
    current_period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_resend_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow,
                                                 nullable=False)


class BillingKey(Base):
    __tablename__ = "billing_keys"

    key_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        ForeignKey("billing_subscriptions.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class BillingCheckout(Base):
    """One "subscribe" click. The id is the secret the extension polls with."""

    __tablename__ = "billing_checkouts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    provider: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)  # pending | paid | claimed
    subscription_id: Mapped[int | None] = mapped_column(
        ForeignKey("billing_subscriptions.id", ondelete="SET NULL"), nullable=True)
    pending_key: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
