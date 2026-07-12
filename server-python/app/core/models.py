import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    text,
)
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from .db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ActionType(str, enum.Enum):
    RECRUITER_ADDED_NEW = "recruiter_added_new"
    RECRUITER_ENRICHED = "recruiter_enriched"
    EMAIL_SENT = "email_sent"
    REFERRAL_REQUESTED = "referral_requested"
    REFERRAL_REFUND = "referral_refund"
    ADMIN_ADJUSTMENT = "admin_adjustment"


class SendStatus(str, enum.Enum):
    SENT = "sent"
    FAILED = "failed"


class ReferralStatus(str, enum.Enum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"
    EXPIRED = "expired"


class User(Base):
    """Identity is the Gumroad license key. No password/session — license_key_hash
    is exactly main.py's _ws_user_id(license_key) (sha256(key)[:16])."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    license_key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    gmail_refresh_token_enc: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Recruiter(Base):
    __tablename__ = "recruiters"
    __table_args__ = (
        Index("ix_recruiters_company_normalized", "company_normalized"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    company: Mapped[str] = mapped_column(String(255), nullable=False)
    company_normalized: Mapped[str] = mapped_column(String(255), nullable=False)
    added_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=_utcnow
    )


class PointsLedger(Base):
    """No balance column on users — balance is always SUM(delta) for a user_id."""

    __tablename__ = "points_ledger"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    action_type: Mapped[ActionType] = mapped_column(SAEnum(ActionType, native_enum=False, length=32), nullable=False)
    delta: Mapped[int] = mapped_column(Integer, nullable=False)
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SendLog(Base):
    __tablename__ = "send_log"
    __table_args__ = (
        # Partial unique index — only a *successful* send blocks re-sending to the
        # same recruiter for the same job; failed attempts can be retried freely.
        Index(
            "uq_send_log_user_recruiter_job_sent",
            "user_id", "recruiter_id", "job_url_hash",
            unique=True,
            sqlite_where=text("status = 'sent'"),
            postgresql_where=text("status = 'sent'"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    recruiter_id: Mapped[int] = mapped_column(ForeignKey("recruiters.id"), nullable=False)
    job_url_hash: Mapped[str] = mapped_column(String(32), nullable=False)
    job_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    company: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[SendStatus] = mapped_column(SAEnum(SendStatus, native_enum=False, length=16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Employee(Base):
    __tablename__ = "employees"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    company: Mapped[str] = mapped_column(String(255), nullable=False)
    company_normalized: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    domains: Mapped[list | None] = mapped_column(JSON, nullable=True)
    min_match_threshold: Mapped[int] = mapped_column(Integer, default=75, server_default=text("75"), nullable=False)
    is_opted_in: Mapped[bool] = mapped_column(Boolean, default=False, server_default=text("0"), nullable=False)
    source_row_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=_utcnow
    )


class ReferralRequest(Base):
    __tablename__ = "referral_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"), nullable=False)
    job_url_hash: Mapped[str] = mapped_column(String(32), nullable=False)
    job_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    company: Mapped[str | None] = mapped_column(String(255), nullable=True)
    match_score: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[ReferralStatus] = mapped_column(
        SAEnum(ReferralStatus, native_enum=False, length=16),
        default=ReferralStatus.PENDING,
        server_default=ReferralStatus.PENDING.value,
        nullable=False,
    )
    token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, default=lambda: uuid.uuid4().hex)
    points_charged: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
