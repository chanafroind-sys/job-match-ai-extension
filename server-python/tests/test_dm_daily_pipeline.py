"""The daily pipeline: 06:00 Israel time in both seasons, once per day, sync
then embed, and a loud failure when the cron and web service use different
databases."""
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

import daily_matches.models  # noqa: F401  (registers dm_* tables before conftest's create_all)
from app.core.db import Base
from app.models.job_pool import DailyJobPool
from app.services import job_aggregator as agg
from daily_matches import daily_pipeline, embeddings, store
from daily_matches.daily_pipeline import PipelineError, run_pipeline, verify_web_reads_same_db
from tests.dm_helpers import FakeEmbedder

UTC = timezone.utc
SUMMER_0605 = datetime(2026, 7, 1, 3, 5, tzinfo=UTC)    # 06:05 in Israel (UTC+3)
SUMMER_0530 = datetime(2026, 7, 1, 2, 30, tzinfo=UTC)   # 05:30
SUMMER_0705 = datetime(2026, 7, 1, 4, 5, tzinfo=UTC)    # 07:05, the second firing
NEXT_DAY_0605 = datetime(2026, 7, 2, 3, 5, tzinfo=UTC)
WINTER_0505 = datetime(2026, 12, 1, 3, 5, tzinfo=UTC)   # 05:05 in Israel (UTC+2)
WINTER_0605 = datetime(2026, 12, 1, 4, 5, tzinfo=UTC)   # 06:05


@pytest.fixture
def world(monkeypatch):
    clock = {"now": SUMMER_0605}
    syncs = []
    monkeypatch.setattr(agg, "_utcnow", lambda: clock["now"])
    store._mode_cache.clear()
    embedder = FakeEmbedder()
    monkeypatch.setattr(embeddings, "embed_texts", embedder)

    async def fake_collect(companies=None):
        syncs.append(clock["now"])
        records = [agg.build_record(company="Acme", title=t, url=f"https://jobs.lever.co/acme/{i}",
                                    description=f"Requirements:\n• {t}", published_at=clock["now"], external_id=str(i))
                   for i, t in enumerate(["Senior Backend Engineer", "Backend Developer", "Data Engineer"])]
        return records, {"sources": {"lever:Acme": 3}, "errors": {}}
    monkeypatch.setattr(agg, "collect_jobs", fake_collect)
    return {"clock": clock, "syncs": syncs, "embedder": embedder}


async def _run(db, world, at, **kw):
    world["clock"]["now"] = at
    return await run_pipeline(db, now=at, **kw)


async def test_runs_at_six_in_summer_then_only_once(db, world):
    assert (await _run(db, world, SUMMER_0530))["skipped"].startswith("before 06:00")
    first = await _run(db, world, SUMMER_0605)
    assert first["sync"]["fetched"] == 3 and first["embed"]["embedded"] == 3
    assert first["pool"] == {"active": 3, "embedded": 3}
    second = await _run(db, world, SUMMER_0705)
    assert second["sync"]["skipped"].startswith("already ran today at 06:05")
    assert second["embed"]["to_embed"] == 0  # nothing re-sent to Voyage
    assert len(world["syncs"]) == 1


async def test_runs_at_six_in_winter(db, world):
    assert "skipped" in await _run(db, world, WINTER_0505)
    assert (await _run(db, world, WINTER_0605))["sync"]["fetched"] == 3
    assert world["syncs"] == [WINTER_0605]


async def test_next_day_syncs_again(db, world):
    await _run(db, world, SUMMER_0605)
    await _run(db, world, NEXT_DAY_0605)
    assert world["syncs"] == [SUMMER_0605, NEXT_DAY_0605]


async def test_force_runs_any_time(db, world):
    report = await _run(db, world, SUMMER_0530, force=True)
    assert report["sync"]["fetched"] == 3 and report["pool"]["embedded"] == 3


async def test_empty_sync_fails_the_run(db, world, monkeypatch):
    async def nothing(companies=None):
        return [], {"sources": {}, "errors": {"all": "down"}}
    monkeypatch.setattr(agg, "collect_jobs", nothing)
    with pytest.raises(PipelineError, match="fetched 0 jobs"):
        await _run(db, world, SUMMER_0605)


async def test_failed_embedding_fails_the_run(db, world, monkeypatch):
    async def no_key(texts, input_type):
        raise embeddings.EmbeddingUnavailable("VOYAGE_API_KEY is not set")
    monkeypatch.setattr(embeddings, "embed_texts", no_key)
    with pytest.raises(embeddings.EmbeddingUnavailable):
        await _run(db, world, SUMMER_0605)


async def test_database_without_the_migration_is_rejected(world):
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=[DailyJobPool.__table__])
    async with async_sessionmaker(eng, expire_on_commit=False)() as session:
        with pytest.raises(PipelineError, match="dm_job_embeddings is missing"):
            await run_pipeline(session, now=SUMMER_0605)
    await eng.dispose()
    assert world["syncs"] == []  # nothing fetched into the wrong database


async def test_no_database_connection_held_during_network_work(db, world, monkeypatch):
    """Neon closes connections idle for minutes; a rate-limited Voyage backfill
    held one open and died with "connection is closed" (2026-10-06)."""
    seen = []

    async def embed(texts, input_type):
        seen.append(("embed", db.in_transaction()))
        return [[1.0] + [0.0] * 1023 for _ in texts]
    monkeypatch.setattr(embeddings, "embed_texts", embed)
    real_collect = agg.collect_jobs

    async def collect(companies=None):
        seen.append(("collect", db.in_transaction()))
        return await real_collect(companies)
    monkeypatch.setattr(agg, "collect_jobs", collect)
    await _run(db, world, SUMMER_0605)
    assert seen and all(open_tx is False for _, open_tx in seen), seen


def _web(jobs):
    return httpx.MockTransport(lambda request: httpx.Response(200, json=[{"id": str(i)} for i in range(jobs)]))


async def test_web_service_on_another_database_fails_the_run():
    with pytest.raises(PipelineError, match="different database"):
        await verify_web_reads_same_db(2, transport=_web(0))


async def test_web_service_on_the_same_database_passes():
    assert (await verify_web_reads_same_db(2, transport=_web(2)))["checked"] is True


async def test_unreachable_web_service_only_warns():
    def down(request):
        raise httpx.ConnectError("no route")
    result = await verify_web_reads_same_db(2, transport=httpx.MockTransport(down))
    assert result["checked"] is False


async def test_script_prints_the_host_but_never_the_password(monkeypatch, capsys):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parent.parent / "scripts" / "run_daily_pipeline.py"
    spec = importlib.util.spec_from_file_location("run_daily_pipeline", path)
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    monkeypatch.setattr(script, "DATABASE_URL",
                        "postgresql+asyncpg://neondb_owner:s3cret@ep-x.c-9.us-east-1.aws.neon.tech/neondb?ssl=require")

    async def skipped(session, **kw):
        return {"skipped": "before 06:00 Israel time"}
    monkeypatch.setattr(script, "run_pipeline", skipped)
    assert await script.main([]) == 0
    out = capsys.readouterr().out
    assert "database: ep-x...neon.tech" in out  # enough to tell Neon from Render
    assert "s3cret" not in out and "neondb_owner" not in out and "us-east-1" not in out
    assert script.describe_database("postgresql://u:p@dpg-abc123-a.oregon-postgres.render.com/db") == "dpg-ab...render.com"

    async def broken(session, **kw):
        raise PipelineError("table dm_job_embeddings is missing")
    monkeypatch.setattr(script, "run_pipeline", broken)
    assert await script.main([]) == 1  # a broken day is a failed cron run
