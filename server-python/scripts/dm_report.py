"""Prints the Daily Matches health report (daily_matches/report.py) as JSON.

    python scripts/dm_report.py            # the last 3 days
    python scripts/dm_report.py --days 7

Read-only, aggregates only: safe for a public GitHub Actions log.
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.db import async_session_factory, engine  # noqa: E402
from daily_matches.report import build_report  # noqa: E402


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=3)
    args = parser.parse_args(argv)
    try:
        async with async_session_factory() as session:
            report = await build_report(session, days=args.days)
    finally:
        await engine.dispose()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
