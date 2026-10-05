"""Daily Matches: embed new or changed jobs in daily_job_pool, then apply
retention. Chained after run_job_pool_sync.py in the Render cron
(render.yaml), so it runs against the same DATABASE_URL right after each sync.

    python scripts/run_job_embeddings.py

Exits 0 without doing anything when VOYAGE_API_KEY isn't set, so an
unconfigured Daily Matches never marks the existing sync cron as failed. Exits
1 when the key is set but embedding fails, so a broken setup shows up as a
failed cron run.
"""
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.db import async_session_factory, engine  # noqa: E402
from daily_matches.embeddings import EmbeddingUnavailable  # noqa: E402
from daily_matches.pool_embedding import embed_pool, purge_retention  # noqa: E402


async def main() -> int:
    if not os.getenv("VOYAGE_API_KEY", "").strip():
        print("[DM] VOYAGE_API_KEY is not set: skipping job embeddings (Daily Matches stays unavailable)")
        return 0
    try:
        async with async_session_factory() as session:
            report = await embed_pool(session)
            report["purged"] = await purge_retention(session)
    except EmbeddingUnavailable as exc:
        print(f"[DM] job embeddings failed: {exc}", file=sys.stderr)
        return 1
    finally:
        await engine.dispose()
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    sys.exit(asyncio.run(main()))
