"""Daily Matches' own job sources, added to daily_job_pool after V1's sync.

V1's sync reads a fixed list of ~60 company boards. This adds:
  registry     company boards discovered from aggregators' apply links, read
               through their public ATS APIs (registry.py)
  linkedin     jobs posted in Israel in the last day, through JobSpy
  jsearch      Google for Jobs through RapidAPI, when DM_JSEARCH_KEY is set
  indeed       Indeed Israel, through JobSpy

Listings are deduplicated against the pool and each other, the company's own
board winning (dedupe.py), and stored with V1's upsert, so V1's pool match
sees them too. No V1 code changes: this only adds rows of the same shape.

Every source is optional and isolated: one failing, blocked or missing is
reported and the rest still land.
"""
import asyncio
import logging

from sqlalchemy import select

from app.models.job_pool import DailyJobPool
from app.services import job_aggregator as agg
from daily_matches.sources import aggregators, registry
from daily_matches.sources.dedupe import drop_copies, job_key

logger = logging.getLogger(__name__)

NEW_BOARDS_PER_DAY = 60  # newly discovered boards read on the day they're found


async def _known_keys(session) -> dict[str, str]:
    rows = await session.execute(select(DailyJobPool.id, DailyJobPool.company, DailyJobPool.title))
    return {job_key(r.company, r.title): r.id for r in rows}


def _strip(records: list[dict]) -> list[dict]:
    return [{k: v for k, v in r.items() if not k.startswith("_")} for r in records]


async def collect_extra(session, *, scrape=None, jsearch_transport=None) -> dict:
    """Fetches every extra source and upserts what's new. Never raises for a
    source's failure; the report says what happened to each."""
    report: dict = {}
    known = await _known_keys(session)
    await session.commit()  # no connection held through the network work below

    board_records, report["registry"] = await registry.fetch_boards(session)
    await session.commit()  # board health (failures, last_count)

    (linkedin, report["linkedin"]), (jsearch, report["jsearch"]), (indeed, report["indeed"]) = await asyncio.gather(
        aggregators.fetch_jobspy("linkedin", aggregators.LINKEDIN_SEARCHES, scrape=scrape),
        aggregators.fetch_jsearch(transport=jsearch_transport),
        aggregators.fetch_jobspy("indeed", aggregators.INDEED_SEARCHES, scrape=scrape),
    )

    # Boards behind today's aggregator links: recorded for every day to come,
    # and read right away, so today's jobs come from the company's own board.
    new_rows = []
    for via, recs in (("linkedin", linkedin), ("jsearch", jsearch), ("indeed", indeed)):
        new_rows += await registry.record_boards(session, recs, via)
    await session.commit()
    fetchable = [r for r in new_rows if r.ats in registry.FETCHABLE][:NEW_BOARDS_PER_DAY]
    new_board_records, report["new_boards"] = await registry.fetch_boards(session, fetchable)
    report["new_boards"]["discovered"] = {
        ats: sum(1 for r in new_rows if r.ats == ats) for ats in sorted({r.ats for r in new_rows})}
    await session.commit()

    batch, dropped = [], 0
    for recs in (board_records, new_board_records, linkedin, jsearch, indeed):  # best copy first
        kept, n = drop_copies(recs, known)
        batch += kept
        dropped += n
    # Postgres refuses an upsert that touches one row twice; the first copy is the best one.
    unique, ids = [], set()
    for rec in batch:
        if rec["id"] not in ids:
            ids.add(rec["id"])
            unique.append(rec)
    report["stored"] = await agg.upsert_jobs(session, _strip(unique))
    report["copies_dropped"] = dropped
    logger.warning("[DM] extra sources: %s", report)
    return report
