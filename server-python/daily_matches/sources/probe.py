"""From a LinkedIn listing to the company's own board — only when it's certain.

LinkedIn doesn't show logged-out readers where a job's application lives, so
apply links (registry.board_from_url) rarely reveal a company's board. This
guesses instead: for each company new to the registry, it tries the board
names a company usually gets ("Acme Labs" → acmelabs, acme-labs) on the ATSes
with public APIs (Greenhouse, Lever, Ashby).

A guessed board is trusted only if it lists, in Israel, a job with the very
same title as one of that company's aggregator listings. A different company
that happens to own the name won't have that job, so it's rejected and the
LinkedIn listing stays as it was. A verified board joins dm_sources: its jobs
are read through the company's own API from then on, with full descriptions
and an application form auto-fill can use, and dedupe drops the LinkedIn
copies in favor of them.

When the name doesn't spell a board, two more places are looked at
(careers_site.py): the company's own careers page (its Comeet board, or any
other ATS it links to) and Workday's hosts. Their boards are verified the
same way.

Companies that didn't verify are remembered (ats "probe_miss") and not tried
again for PROBE_RETRY_AFTER, so a day's probing stays small. A miss from an
older probe (PROBE_VERSION) is tried again with the newer one.
"""
import asyncio
import logging
import re
from datetime import timedelta

import httpx
from sqlalchemy import select

from app.services import job_aggregator as agg
from app.services.israel_job_sources import COMPANIES
from daily_matches import config
from daily_matches.models import DmSource
from daily_matches.sources import careers_site, registry
from daily_matches.sources.dedupe import job_key

logger = logging.getLogger(__name__)

PROBE_ATS = ("greenhouse", "lever", "ashby")
PROBE_VERSION = 2  # 2: careers pages and Workday too (2026-10-13)
MISS = "probe_miss"
MAX_COMPANIES_PER_DAY = 80
PROBE_RETRY_AFTER = timedelta(days=30)
CONCURRENCY = 6

_NOISE = re.compile(r"\b(ltd|inc|llc|corp|corporation|co|technologies|technology|israel|il|group|labs?|hq)\b\.?", re.I)


def company_key(company: str | None) -> str:
    return job_key(company, "").split("|", 1)[0]


def slug_candidates(company: str | None) -> list[str]:
    """Board names to try, most likely first. A Hebrew-only name gives none."""
    words = re.findall(r"[a-z0-9]+", _NOISE.sub(" ", (company or "").lower()))
    if not words:
        return []
    full = re.findall(r"[a-z0-9]+", (company or "").lower())
    out = ["".join(words), "-".join(words), "".join(full)]
    return [s for s in dict.fromkeys(out) if 2 <= len(s) <= 60]


def _params(ats: str, slug: str) -> dict:
    return {"greenhouse": {"board": slug}, "lever": {"site": slug}, "ashby": {"board": slug}}[ats]


async def _try(client, sem, ats: str, params: dict, company: str) -> list[dict] | None:
    async with sem:
        try:
            fetch = registry.OWN_FETCHERS.get(ats) or agg.FETCHERS[ats]
            return [r for r in await fetch(client, company, dict(params)) if r]
        except Exception:  # noqa: BLE001 — a 404 is the usual answer: no such board
            return None


async def probe_companies(session, records: list[dict], client=None) -> tuple[list[DmSource], list[dict], dict]:
    """For the aggregator records' companies: verified boards (new dm_sources
    rows, caller commits), the jobs those boards returned, and a report."""
    report = {"companies": 0, "verified": 0, "missed": 0, "skipped_known": 0,
              "found_by": {"name": 0, "careers_page": 0, "workday": 0}}
    titles: dict[str, set[str]] = {}
    names: dict[str, str] = {}
    sites: dict[str, str] = {}
    for rec in records:
        ck = company_key(rec.get("company"))
        if ck:
            titles.setdefault(ck, set()).add(job_key(rec.get("company"), rec.get("title")))
            names.setdefault(ck, rec.get("company") or "")
            if rec.get("_site") and ck not in sites:
                sites[ck] = rec["_site"]

    rows = (await session.execute(select(DmSource.ats, DmSource.company, DmSource.first_seen_at,
                                         DmSource.params))).all()
    retry_from = config.utcnow() - PROBE_RETRY_AFTER
    known = {company_key(c["name"]) for c in COMPANIES}
    for ats, company, seen_at, params in rows:
        if ats != MISS or (config.as_utc(seen_at) >= retry_from and (params or {}).get("v") == PROBE_VERSION):
            known.add(company_key(company))
    todo = [ck for ck in titles if ck not in known and slug_candidates(names[ck])]
    report["skipped_known"] = len(titles) - len(todo)
    todo = todo[:MAX_COMPANIES_PER_DAY]
    report["companies"] = len(todo)
    await session.commit()  # no connection held through the network work
    if not todo:
        return [], [], report

    sem = asyncio.Semaphore(CONCURRENCY)
    own_client = client is None
    client = client or httpx.AsyncClient(headers=agg.HTTP_HEADERS, follow_redirects=True)

    async def one(ck: str):
        company = names[ck]
        candidates = slug_candidates(company)

        async def proven(ats, params):
            found = await _try(client, sem, ats, params, company)
            # The proof: the board lists one of this company's jobs, by title, in Israel.
            return found if found and any(job_key(company, r["title"]) in titles[ck] for r in found) else None

        for slug in candidates:
            for ats in PROBE_ATS:
                if found := await proven(ats, _params(ats, slug)):
                    return ck, ats, slug, _params(ats, slug), found, "name"
        # Boards a name doesn't spell: the careers page's, then Workday's.
        for via, finder in (("careers_page", lambda: careers_site.site_boards(client, sem, sites.get(ck), candidates)),
                            ("workday", lambda: careers_site.workday_boards(client, sem, candidates))):
            for ats, slug, params in await finder():
                if ats in registry.FETCHABLE and (found := await proven(ats, params)):
                    return ck, ats, slug, params, found, via
        return ck, None, None, None, None, None

    try:
        results = await asyncio.gather(*(one(ck) for ck in todo))
    finally:
        if own_client:
            await client.aclose()

    # A company probed again after PROBE_RETRY_AFTER replaces its old miss row.
    old = (await session.execute(select(DmSource).where(
        DmSource.ats == MISS, DmSource.slug.in_([ck[:160] for ck in todo])))).scalars().all()
    for row in old:
        await session.delete(row)
    await session.flush()
    taken = {(a, s) for a, s in (await session.execute(select(DmSource.ats, DmSource.slug))).all()} | registry._KNOWN

    verified, board_records = [], []
    now = config.utcnow()
    comeet_uids = {registry._comeet_uid(p) for a, _, _, p in rows if a == "comeet"}
    for ck, ats, slug, params, found, via in results:
        company = names[ck][:255]
        if ats and (ats, slug) not in taken and not (ats == "comeet" and registry._comeet_uid(params) in comeet_uids):
            taken.add((ats, slug))
            if ats == "comeet":
                comeet_uids.add(registry._comeet_uid(params))
            row = DmSource(ats=ats, slug=slug, company=company, params=params, found_via="probe",
                           first_seen_at=now, last_fetched_at=now, last_count=len(found), failures=0)
            verified.append(row)
            board_records.extend({**r, "_via": ats} for r in found)
            report["verified"] += 1
            report["found_by"][via] += 1
        elif not ats:
            row = DmSource(ats=MISS, slug=ck[:160], company=company, params={"v": PROBE_VERSION}, found_via="probe",
                           first_seen_at=now, failures=0)
            report["missed"] += 1
        else:
            continue  # the board is in the registry already
        session.add(row)
    return verified, board_records, report
