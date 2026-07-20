"""V2-only database models. A NEW, isolated table — never a modification to
app/core/models.py's existing User table (which V1 features like points and
referrals already depend on). Only imports Base/User for the FK reference;
nothing in app/core is edited to make this exist."""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from app.core.db import Base


class V2CvSemanticMap(Base):
    """The AI structural map of a user's most recently uploaded CV — written
    exactly once per upload by POST /api/v2/semantic-map, read (never
    recomputed) by GET /api/v2/cv-blocks during job navigation. One row per
    user; a new upload overwrites the previous map outright."""

    __tablename__ = "v2_cv_semantic_maps"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_v2_cv_semantic_maps_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    cv_hash: Mapped[str] = mapped_column(String(32), nullable=False)
    blocks: Mapped[list] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
