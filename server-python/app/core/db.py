import os
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

_DEV_DB_PATH = Path(__file__).resolve().parent.parent.parent / "dev.db"
DEFAULT_SQLITE_URL = f"sqlite+aiosqlite:///{_DEV_DB_PATH.as_posix()}"


def _normalize_database_url(raw: str) -> str:
    """Render (and Heroku-style) DATABASE_URL uses postgres(ql):// — the async
    engine needs the asyncpg driver spelled out explicitly."""
    if raw.startswith("postgres://"):
        return raw.replace("postgres://", "postgresql+asyncpg://", 1)
    if raw.startswith("postgresql://") and "+asyncpg" not in raw:
        return raw.replace("postgresql://", "postgresql+asyncpg://", 1)
    return raw


DATABASE_URL = _normalize_database_url(os.getenv("DATABASE_URL", DEFAULT_SQLITE_URL))

_engine_kwargs: dict = {}
if DATABASE_URL.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}


# Neon (and other serverless Postgres) suspends idle connections and closes
# them server-side, which asyncpg doesn't detect until the next checkout —
# surfacing as InterfaceError: connection is closed on a pooled connection
# that's actually dead. pool_pre_ping validates a connection with a cheap
# round-trip before handing it out (transparently discarding and replacing it
# if the ping fails); pool_recycle proactively retires connections older than
# 5 minutes so they're refreshed well before Neon's own idle suspend kicks in.
engine = create_async_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=300,
    **_engine_kwargs,
)
async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session_factory() as session:
        yield session
