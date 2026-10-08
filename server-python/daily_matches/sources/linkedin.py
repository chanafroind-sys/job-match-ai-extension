"""LinkedIn's public job search, read the way a logged-out visitor's browser
does (the jobs-guest endpoints), for the most complete free coverage of jobs
posted in Israel in the last day.

Two phases, so each LinkedIn request counts:
  1. Search, one query per field (Backend, Frontend, DevOps…): ten cards a
     page, paged until a query runs dry. Cards carry the id, title and company.
  2. Details, only for cards worth it: not already in the pool, and a title
     that could be a tech role (the same classifier as the pool, plus Hebrew
     hints). That's where the description and, sometimes, the company's own
     apply link come from.
Requests are paced. LinkedIn answers too many requests with HTTP 429: the
collector waits and tries again, and after repeated refusals stops and keeps
what it has. The report says, per query, how many cards it found, so a cap
on coverage shows up in the run log instead of passing silently.
"""
import asyncio
import html as html_lib
import logging
import random
import re
from datetime import datetime, timezone

import httpx

from app.services import job_aggregator as agg
from daily_matches.sources.aggregators import _env_list, _int, _record, hebrew_hints

logger = logging.getLogger(__name__)

SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
DETAIL_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/126.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9,he;q=0.8",
}
# One query per field: a single broad query stops at LinkedIn's page limit long
# before it has every job. Each is a LinkedIn boolean query.
SEARCHES = _env_list("DM_LINKEDIN_SEARCHES", [
    "backend", "frontend", '"full stack" OR fullstack', '"software engineer"', "developer OR programmer",
    'devops OR SRE OR "platform engineer" OR "cloud engineer"', '"data engineer" OR "data scientist" OR "BI developer"',
    '"machine learning" OR "AI engineer" OR LLM OR "computer vision"', 'QA OR "automation engineer" OR SDET',
    "android OR iOS OR mobile", "embedded OR firmware", '"security engineer" OR "security researcher" OR cyber',
    '"team lead" OR "engineering manager" OR "tech lead"',
])
HOURS = _int("DM_LINKEDIN_HOURS", 26)  # a day plus slack, so consecutive 06:00 runs overlap
MAX_PAGES = _int("DM_LINKEDIN_PAGES", 10)  # ten cards a page
MAX_DETAILS = _int("DM_LINKEDIN_DETAILS", 700)
PAGE_PAUSE = (1.5, 3.5)  # seconds between search pages
DETAIL_PAUSE = (0.6, 1.4)
DETAIL_CONCURRENCY = 2
BLOCK_PAUSE = 45  # after a 429
MAX_BLOCKS = 3  # 429s in a row before a phase gives up

_CARD_ID = re.compile(r'data-entity-urn="urn:li:jobPosting:(\d+)"')
_FIELDS = {
    "title": re.compile(r'class="base-search-card__title"[^>]*>(.*?)</h3>', re.S),
    "company": re.compile(r'class="base-search-card__subtitle"[^>]*>(.*?)</h4>', re.S),
    "location": re.compile(r'class="job-search-card__location"[^>]*>(.*?)</span>', re.S),
    "date": re.compile(r'<time[^>]*datetime="([0-9-]+)"'),
}
_TAGS = re.compile(r"<[^>]+>")
_APPLY = re.compile(r'<code id="applyUrl"[^>]*>\s*<!--\s*"?(https?://[^"]+?)"?\s*-->', re.S)


def _text(fragment: str) -> str:
    return " ".join(html_lib.unescape(_TAGS.sub(" ", fragment)).split())


def parse_cards(page: str) -> list[dict]:
    cards = []
    for chunk in page.split("</li>"):
        m = _CARD_ID.search(chunk)
        if not m:
            continue
        card = {"id": m.group(1)}
        for name, rx in _FIELDS.items():
            found = rx.search(chunk)
            card[name] = (found.group(1) if name == "date" else _text(found.group(1))) if found else ""
        if card["title"]:
            cards.append(card)
    return cards


def _div_inner(page: str, marker: str) -> str:
    """The inner HTML of the div whose class contains marker, nested divs included."""
    start = page.find(marker)
    if start < 0:
        return ""
    open_end = page.find(">", start)
    depth, i = 1, open_end + 1
    for m in re.finditer(r"<(/?)div\b", page[i:]):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return page[i:i + m.start()]
    return page[i:]


def parse_detail(page: str) -> tuple[str, str]:
    """(description as text, the company's own apply link or "")."""
    description = agg.html_to_text(_div_inner(page, "show-more-less-html__markup"))
    apply = _APPLY.search(page)
    return description, (html_lib.unescape(apply.group(1)) if apply else "")


def _looks_technical(title: str) -> bool:
    hints = hebrew_hints(title)
    return agg.classify_category(f"{title} ({hints})" if hints else title, "") is not None


class _Blocked(Exception):
    pass


async def _get(client, url: str, params: dict | None, state: dict, sleep) -> str | None:
    """One request; waits out a 429 and retries. None for a missing job;
    _Blocked after MAX_BLOCKS refusals in a row."""
    for _ in range(MAX_BLOCKS):
        resp = await client.get(url, params=params)
        if resp.status_code == 429:
            state["blocks"] += 1
            await sleep(BLOCK_PAUSE)
            continue
        state["blocks"] = 0
        if resp.status_code in (404, 410):
            return None
        resp.raise_for_status()
        return resp.text
    raise _Blocked()


async def fetch_linkedin(known_ids: set[str] | frozenset = frozenset(), *, transport=None,
                         sleep=asyncio.sleep) -> tuple[list[dict], dict]:
    report: dict = {"searches": [], "cards": 0, "already_in_pool": 0, "not_tech": 0,
                    "details_ok": 0, "details_failed": 0, "no_description": 0, "blocked": None, "jobs": 0}
    cards: dict[str, dict] = {}
    state = {"blocks": 0}
    pause = lambda span: sleep(random.uniform(*span))  # noqa: E731

    async with httpx.AsyncClient(headers=HEADERS, transport=transport, timeout=30, follow_redirects=True) as client:
        # Phase 1: search.
        try:
            for query in SEARCHES:
                found = 0
                for page in range(MAX_PAGES):
                    params = {"keywords": query, "location": "Israel", "f_TPR": f"r{HOURS * 3600}",
                              "start": page * 10}
                    body = await _get(client, SEARCH_URL, params, state, sleep)
                    page_cards = parse_cards(body or "")
                    for card in page_cards:
                        cards.setdefault(card["id"], card)
                    found += len(page_cards)
                    if len(page_cards) < 10:
                        break  # the query ran dry
                    await pause(PAGE_PAUSE)
                report["searches"].append({"query": query, "cards": found})
                await pause(PAGE_PAUSE)
        except _Blocked:
            report["blocked"] = "search"
        except Exception as exc:  # noqa: BLE001 — keep what the searches found so far
            report["blocked"] = f"search: {type(exc).__name__}: {exc}"[:200]
        report["cards"] = len(cards)

        # Phase 2: details, only where they're worth a request.
        todo = []
        for card in cards.values():
            url = f"https://www.linkedin.com/jobs/view/{card['id']}"
            if agg.hash_url(url) in known_ids:
                report["already_in_pool"] += 1
            elif not _looks_technical(card["title"]):
                report["not_tech"] += 1
            else:
                todo.append((card, url))
        todo = todo[:MAX_DETAILS]
        sem = asyncio.Semaphore(DETAIL_CONCURRENCY)
        records: dict[str, dict] = {}
        stop = asyncio.Event()

        async def detail(card: dict, url: str):
            if stop.is_set():
                return
            async with sem:
                if stop.is_set():
                    return
                try:
                    body = await _get(client, DETAIL_URL.format(id=card["id"]), None, state, sleep)
                except _Blocked:
                    stop.set()
                    report["blocked"] = report["blocked"] or "details"
                    return
                except Exception:  # noqa: BLE001
                    report["details_failed"] += 1
                    return
                await pause(DETAIL_PAUSE)
            if body is None:
                report["details_failed"] += 1
                return
            report["details_ok"] += 1
            description, apply = parse_detail(body)
            posted = None
            if card["date"]:
                try:
                    posted = datetime.fromisoformat(card["date"]).replace(tzinfo=timezone.utc)
                except ValueError:
                    posted = None
            rec = _record(company=card["company"], title=card["title"], url=url, direct=apply,
                          description=description, posted=posted, external_id=card["id"])
            if rec:
                records.setdefault(rec["id"], rec)
            elif len(description.strip()) < 300:
                report["no_description"] += 1

        await asyncio.gather(*(detail(c, u) for c, u in todo))
    report["jobs"] = len(records)
    logger.warning("[DM] linkedin: %s", {k: v for k, v in report.items() if k != "searches"})
    return list(records.values()), report
