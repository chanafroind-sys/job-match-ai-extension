"""End-to-end check of the daily job-pool pipeline against live ATS APIs.

Fetches from every configured source, upserts into a throwaway SQLite DB
(or DATABASE_URL if --use-database-url is passed), then queries it the way
GET /jobs/matched-pool does and prints counts plus sample rows.

    python scripts/verify_job_pool.py
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.core.db import DATABASE_URL, Base  # noqa: E402
from app.models.job_pool import DailyJobPool  # noqa: E402
from app.services.job_aggregator import run_daily_aggregation  # noqa: E402


async def main() -> int:
    if "--use-database-url" in sys.argv:
        url = DATABASE_URL
    else:
        url = f"sqlite+aiosqlite:///{Path(tempfile.gettempdir(), 'jma_job_pool_verify.db').as_posix()}"
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all, tables=[DailyJobPool.__table__])
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as session:
        report = await run_daily_aggregation(session)
    print(json.dumps({k: v for k, v in report.items() if k != "sources"}, indent=2, ensure_ascii=False))
    print("\nper-source kept counts:")
    for label, n in sorted(report["sources"].items(), key=lambda kv: -kv[1]):
        print(f"  {n:4d}  {label}")

    async with Session() as session:
        total = await session.scalar(select(func.count()).select_from(DailyJobPool))
        rows = (await session.execute(
            select(DailyJobPool.category, func.count()).group_by(DailyJobPool.category)
            .order_by(func.count().desc())
        )).all()
        print(f"\nrows in daily_job_pool: {total}")
        for cat, n in rows:
            print(f"  {n:4d}  {cat}")
        sample = (await session.execute(
            select(DailyJobPool).where(DailyJobPool.category == "Backend")
            .order_by(DailyJobPool.published_at.desc()).limit(5)
        )).scalars().all()
        print("\nsample Backend rows:")
        for j in sample:
            print(f"  - {j.title} | {j.company} | {j.seniority} | {j.published_at:%Y-%m-%d}\n"
                  f"    {j.url}\n    desc: {len(j.description or '')} chars — {(j.description or '')[:90]!r}")
    await engine.dispose()
    return 0 if total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
