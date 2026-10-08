import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.core.models import Base, User


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture
async def db(engine):
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session


@pytest_asyncio.fixture
async def user(db):
    u = User(license_key_hash="testhash1234")
    db.add(u)
    await db.commit()
    await db.refresh(u)
    return u


@pytest.fixture(autouse=True)
def _reset_daily_matches_process_state():
    """Daily Matches keeps two per-process timers (store.cached_pool_counts,
    entitlement's reservation cleanup); each test starts with them cold."""
    from daily_matches import entitlement, store
    store._counts_cache.update(at=0.0, value=None)
    entitlement._last_cleanup["at"] = 0.0
    yield
