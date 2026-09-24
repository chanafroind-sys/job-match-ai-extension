"""Daily job-pool sync — the Render cron job's entrypoint (see render.yaml).

Runs the aggregator against DATABASE_URL and exits non-zero when the sync
yields no jobs, so a silently-empty pool shows up as a failed cron run
instead of going unnoticed.

    python scripts/run_job_pool_sync.py
"""
import asyncio
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.db import async_session_factory, engine  # noqa: E402
from app.services.job_aggregator import run_daily_aggregation  # noqa: E402


async def main() -> int:
    try:
        async with async_session_factory() as session:
            report = await run_daily_aggregation(session)
    finally:
        await engine.dispose()
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    if report["fetched"] == 0:
        print("[JobPool] sync fetched 0 jobs — failing the run", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per request otherwise (~1k/run)
    sys.exit(asyncio.run(main()))
