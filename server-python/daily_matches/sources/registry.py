"""The self-growing company registry.

Aggregators (LinkedIn, Indeed, JSearch) often link a job to the company's own
ATS board. Each such board on an ATS with a public job-board API is recorded
in dm_sources and, from the next fetch on, read directly through that API,
the same way V1's hand-made list (app/services/israel_job_sources.py) is. A
board found once keeps being read even if the aggregators stop working, and
its jobs come with full descriptions and an application form auto-fill can use.

Comeet boards are recorded too, but not fetched: there is no Comeet adapter
yet, and per COMPANY_RADAR.md none is written before a real board is probed.
"""
import asyncio
import logging
import re
from urllib.parse import parse_qs, urlparse

import httpx
from sqlalchemy import select

from app.services import job_aggregator as agg
from app.services.israel_job_sources import COMPANIES
from daily_matches import config
from daily_matches.models import DmSource

logger = logging.getLogger(__name__)

FETCHABLE = ("greenhouse", "lever", "ashby", "smartrecruiters", "workday")
MAX_FAILURES = 5  # consecutive failed fetches before a board is skipped
FETCH_CONCURRENCY = 8

_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")


def _slug_of(ats: str, params: dict) -> str:
    if ats == "workday":
        return f"{params['host']}/{params['site']}".lower()
    key = {"greenhouse": "board", "lever": "site", "ashby": "board", "smartrecruiters": "company"}.get(ats, "slug")
    return str(params.get(key, "")).lower()


# V1's hand-made list is fetched by V1's sync already.
_KNOWN = {(c["ats"], _slug_of(c["ats"], c["params"])) for c in COMPANIES}


def board_from_url(url: str | None) -> tuple[str, str, dict] | None:
    """(ats, slug, fetch params) for a job URL on a known ATS board, else None."""
    if not url:
        return None
    try:
        u = urlparse(url.strip())
    except ValueError:
        return None
    host = (u.netloc or "").lower().split(":")[0]
    parts = [p for p in u.path.split("/") if p]
    if host.endswith("greenhouse.io"):
        board = (parse_qs(u.query).get("for") or [None])[0] if parts[:1] == ["embed"] else (parts[0] if parts else None)
        if board and _SLUG.match(board):
            return "greenhouse", board.lower(), {"board": board.lower()}
        return None
    if host.endswith("lever.co") and host.startswith("jobs.") and parts:
        site = parts[0]
        if _SLUG.match(site):
            params = {"site": site.lower(), **({"region": "eu"} if ".eu." in host else {})}
            return "lever", site.lower(), params
        return None
    if host == "jobs.ashbyhq.com" and parts and _SLUG.match(parts[0]):
        return "ashby", parts[0].lower(), {"board": parts[0]}
    if host in ("jobs.smartrecruiters.com", "careers.smartrecruiters.com") and parts and _SLUG.match(parts[0]):
        return "smartrecruiters", parts[0].lower(), {"company": parts[0]}
    if host.endswith(".myworkdayjobs.com"):
        rest = parts[1:] if parts and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", parts[0]) else parts
        if rest and _SLUG.match(rest[0]) and rest[0] != "job":
            return "workday", f"{host}/{rest[0]}".lower(), {"host": host, "site": rest[0]}
        return None
    if host.endswith("comeet.com") and len(parts) >= 3 and parts[0] == "jobs":
        slug, uid = parts[1], parts[2]
        if _SLUG.match(slug) and re.fullmatch(r"[0-9A-Za-z]{1,4}\.[0-9A-Za-z]{2,6}", uid):
            return "comeet", f"{slug}/{uid}".lower(), {"slug": slug, "uid": uid}
    return None


async def record_boards(session, records: list[dict], found_via: str) -> list[DmSource]:
    """Adds the boards behind these aggregator records to dm_sources. Returns
    the new rows. Caller commits."""
    seen = {(s.ats, s.slug) for s in (await session.execute(select(DmSource.ats, DmSource.slug))).all()}
    added: list[DmSource] = []
    for rec in records:
        for url in (rec.get("apply_url"), rec.get("url")):
            found = board_from_url(url)
            if not found:
                continue
            ats, slug, params = found
            if (ats, slug) in seen or (ats, slug) in _KNOWN:
                break
            seen.add((ats, slug))
            row = DmSource(ats=ats, slug=slug, company=(rec.get("company") or slug)[:255], params=params,
                           found_via=found_via, first_seen_at=config.utcnow(), failures=0)
            session.add(row)
            added.append(row)
            break
    return added


async def fetch_boards(session, rows: list[DmSource] | None = None) -> tuple[list[dict], dict]:
    """Every fetchable, healthy registry board through its ATS API. Returns
    (records, report). Each board's outcome is written back to its row; the
    caller commits."""
    if rows is None:
        rows = (await session.execute(select(DmSource).where(
            DmSource.ats.in_(FETCHABLE), DmSource.failures < MAX_FAILURES))).scalars().all()
    rows = [r for r in rows if r.ats in FETCHABLE]
    report = {"boards": len(rows), "ok": 0, "failed": 0, "jobs": 0}
    if not rows:
        return [], report
    sem = asyncio.Semaphore(FETCH_CONCURRENCY)
    results: dict[int, tuple[list[dict] | None, str | None]] = {}

    async with httpx.AsyncClient(headers=agg.HTTP_HEADERS, follow_redirects=True) as client:
        async def one(row: DmSource):
            async with sem:
                try:
                    found = await agg.FETCHERS[row.ats](client, row.company, dict(row.params))
                    results[row.id or id(row)] = (found, None)
                except Exception as exc:  # noqa: BLE001 — one board never sinks the rest
                    results[row.id or id(row)] = (None, f"{type(exc).__name__}: {exc}"[:200])
        await asyncio.gather(*(one(r) for r in rows))

    records: list[dict] = []
    now = config.utcnow()
    for row in rows:
        found, error = results.get(row.id or id(row), (None, "not run"))
        row.last_fetched_at = now
        if error is None:
            row.failures, row.last_count = 0, len(found)
            records.extend(found)
            report["ok"] += 1
        else:
            row.failures = (row.failures or 0) + 1
            report["failed"] += 1
            logger.warning("[DM] board %s:%s failed: %s", row.ats, row.slug, error)
    report["jobs"] = len(records)
    return records, report
