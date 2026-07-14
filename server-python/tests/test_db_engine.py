"""Guards the pool config that fixes the production Neon/asyncpg
"connection is closed" 500s (serverless Postgres suspends and drops idle
connections that asyncpg/SQLAlchemy don't otherwise notice until checkout).

pool_pre_ping's actual behavior (silently discarding a dead connection and
retrying) isn't practical to exercise without a real dead connection, so this
just asserts the pool is configured the way we need it to be — a regression
here means the Neon fix has silently been lost.
"""

from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import db as db_module
from app.core.db import get_db

APP_ROOT = Path(db_module.__file__).resolve().parent.parent  # server-python/app
MAIN_PY = APP_ROOT.parent / "main.py"


def test_engine_has_pre_ping_and_recycle_configured():
    assert db_module.engine.pool._pre_ping is True
    assert db_module.engine.pool._recycle == 300


def test_exactly_one_create_async_engine_call_app_wide():
    # Regression guard for "exactly one engine app-wide" — a second
    # create_async_engine(...) elsewhere would mean some code path pools
    # connections independently of the pre_ping/recycle config above.
    sources = list(APP_ROOT.rglob("*.py")) + [MAIN_PY]
    hits = [p for p in sources if "create_async_engine(" in p.read_text(encoding="utf-8")]
    assert hits == [Path(db_module.__file__)]


async def test_get_db_sessions_are_bound_to_the_single_engine():
    agen = get_db()
    session = await agen.__anext__()
    try:
        assert isinstance(session, AsyncSession)
        assert session.bind is db_module.engine
    finally:
        await agen.aclose()
