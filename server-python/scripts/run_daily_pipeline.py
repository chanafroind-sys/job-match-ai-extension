"""Daily pipeline — the Render cron's entrypoint: collect today's jobs, then
embed them for Daily Matches (daily_matches/daily_pipeline.py has the logic).

Schedule it at "0 3,4 * * *" (UTC). It acts only from 06:00 Israel time and
only once per Israel day, so it runs at 06:00 in both summer and winter.

    python scripts/run_daily_pipeline.py            # what the cron runs
    python scripts/run_daily_pipeline.py --force    # sync + embed now, whatever the hour

Exits 1 whenever production isn't left with a fresh, fully embedded pool, so
a broken day shows up as a failed cron run instead of an empty feature.
"""
import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.db import DATABASE_URL, async_session_factory, engine  # noqa: E402
from daily_matches import config  # noqa: E402
from daily_matches.daily_pipeline import (  # noqa: E402
    PipelineError,
    active_count,
    run_pipeline,
    verify_web_reads_same_db,
)
from daily_matches.embeddings import EmbeddingUnavailable  # noqa: E402


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="run now, ignoring the hour and today's run")
    parser.add_argument("--no-verify", action="store_true", help="skip the cross-check against the web service")
    args = parser.parse_args(argv)

    # The host only, never the credentials: enough to see which database this is.
    print(f"[pipeline] database host: {urlparse(DATABASE_URL.replace('+asyncpg', '')).hostname}")
    try:
        async with async_session_factory() as session:
            report = await run_pipeline(session, force=args.force)
            if "skipped" not in report and not args.no_verify:
                backend = await active_count(session, config.utcnow(), "Backend")
                report["web_check"] = await verify_web_reads_same_db(backend)
    except (PipelineError, EmbeddingUnavailable) as exc:
        print(f"[pipeline] FAILED: {exc}", file=sys.stderr)
        return 1
    finally:
        await engine.dispose()
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per request otherwise (~1k/run)
    sys.exit(asyncio.run(main(sys.argv[1:])))
