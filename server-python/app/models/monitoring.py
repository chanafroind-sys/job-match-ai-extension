"""What the admin's system-status panel reads (app/core/monitoring.py writes
them). Aggregates and fingerprints only: no license key, no CV, no job text."""
from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class AppError(Base):
    """One server failure: a 5xx answer, an exception, or a request that took
    too long. Grouped by kind/route/status when read."""

    __tablename__ = "app_errors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(20), nullable=False)  # server_error | exception | slow
    route: Mapped[str] = mapped_column(String(160), nullable=False)
    status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    detail: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)


class LicenseActivity(Base):
    """A license that verified: when first and last, on which plan. The key is
    stored only as a one-way fingerprint. Payment-provider agnostic: whichever
    provider verifies a license calls monitoring.record_license."""

    __tablename__ = "license_activity"

    key_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    tier: Mapped[str] = mapped_column(String(20), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)  # False: cancelled, period not over
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False, index=True)


class AiUsageDaily(Base):
    """Tokens per day and model for every Claude call outside Daily Matches
    (whose runs keep their own usage in dm_runs)."""

    __tablename__ = "ai_usage_daily"

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    model: Mapped[str] = mapped_column(String(60), primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
