from datetime import datetime
from sqlalchemy import String, Text, DateTime, Index
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class DailyJobPool(Base):
    __tablename__ = "daily_job_pool"

    # מזהה ייחודי שנוצר מ-MD5 של כתובת ה-URL למניעת כפילויות
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    external_job_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    company: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    seniority: Mapped[str] = mapped_column(String(50), nullable=False, default="Unknown", index=True)
    
    url: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    scraped_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    # אינדקס מורכב לשליפה מהירה לפי קטגוריה, ותק ותאריך פרסום
    __table_args__ = (
        Index("ix_job_match_lookup", "category", "seniority", "published_at"),
    )