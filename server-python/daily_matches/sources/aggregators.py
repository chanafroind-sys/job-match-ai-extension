"""Aggregator sources: jobs posted in Israel in the last day, from LinkedIn and
Indeed (through the JobSpy library) and from JSearch (Google for Jobs, on
RapidAPI).

Each returns daily_job_pool records built by V1's build_record, so the
classification (category, seniority, tech-only) is the same as everywhere
else, plus a "_links" key the registry reads (stripped before upsert). Where
a listing links to the company's own application page, that page becomes the
record's URL: it is what auto-fill and the apply button need.

JobSpy reads the sites the way a browser does, so it is installed only where
the daily pipeline runs (the GitHub workflow), never in the web service. Both
sources are optional: missing (no package, no key) means skipped, and a
failure is reported without failing the pipeline.
"""
import asyncio
import json
import logging
import os
import re
from datetime import date, datetime, timezone

import httpx

from app.services import job_aggregator as agg

logger = logging.getLogger(__name__)

JOBSPY_VERSION = "1.2.0"  # .github/workflows/daily-pipeline.yml installs this one


def _env_list(name: str, default: list[str]) -> list[str]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = json.loads(raw)
        return [str(v) for v in value] if isinstance(value, list) else default
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


# LinkedIn rate-limits a single IP after roughly ten result pages, so a few
# broad searches beat many narrow ones. Each search is a LinkedIn boolean query.
LINKEDIN_SEARCHES = _env_list("DM_LINKEDIN_SEARCHES", [
    'software OR developer OR programmer',
    'engineer NOT sales NOT mechanical NOT civil',
    'devops OR "data engineer" OR "machine learning" OR "QA automation"',
])
LINKEDIN_RESULTS = _int("DM_LINKEDIN_RESULTS", 150)  # per search
INDEED_SEARCHES = _env_list("DM_INDEED_SEARCHES", ["software engineer", "developer"])
INDEED_RESULTS = _int("DM_INDEED_RESULTS", 100)
HOURS_OLD = 26  # a day plus slack, so consecutive 06:00 runs overlap instead of leaving a gap

# /search answers 404 since JSearch moved to /search-v2 (cursor paging, one credit per page).
JSEARCH_URL = "https://jsearch.p.rapidapi.com/search-v2"
JSEARCH_HOST = "jsearch.p.rapidapi.com"
# The free plan is 200 credits a month and every page of ten jobs costs one.
# Three queries of two pages: 6 a day, about 180 a month.
JSEARCH_QUERIES = _env_list("DM_JSEARCH_QUERIES", [
    "software engineer in Israel", "developer in Israel", "devops OR data OR QA engineer in Israel",
])
JSEARCH_PAGES = _int("DM_JSEARCH_PAGES", 2)


def _as_utc(value) -> datetime | None:
    if value is None or value != value:  # None or NaN (pandas)
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    return agg.parse_datetime(value)


def _text(value) -> str:
    return "" if value is None or value != value else str(value)


# V1's classifier reads English titles. Israeli boards post many in Hebrew, so
# a Hebrew title gets these English words added for classification only; the
# stored title stays as posted.
_HEBREW_HINTS = [
    (r"פול\s*-?\s*סטא?ק|פולסטא?ק", "full stack"), (r"צד\s+שרת|בקאנד|בק\s*-?\s*אנד", "backend"),
    (r"צד\s+לקוח|פרונט\s*-?\s*אנד|פרונטאנד", "frontend"), (r"דב\s*-?\s*אופס|דבאופס", "devops"),
    (r"אוטומציה", "automation engineer"), (r"בודק(?:/ת|ת)?\s+תוכנה|בדיקות\s+תוכנה|\bQA\b", "qa"),
    (r"דאטה|נתונים", "data engineer"), (r"סייבר|אבטחת\s+מידע", "cyber security engineer"),
    (r"תשתיות", "infrastructure engineer"), (r"משובצ|אמבדד", "embedded"),
    (r"בינה\s+מלאכותית|למידת\s+מכונה", "machine learning"), (r"מובייל|אנדרואיד", "mobile"),
    (r"מפתח(?:/ת|ת)?|מתכנת(?:/ת|ת)?", "developer"), (r"תוכנה", "software"), (r"מהנדס(?:/ת|ת)?", "engineer"),
    (r"בכיר(?:/ה|ה)?", "senior"), (r"ראש\s+צוות", "team lead"),
    (r"ג'?וניור|מתחיל(?:/ה|ה)?|סטודנט(?:/ית|ית)?|ללא\s+ניסיון", "junior"),
    (r"מנהל(?:/ת|ת)?\s+מוצר", "product manager"), (r"מכירות", "sales"), (r"גיוס", "recruiter"),
]
_HEBREW = re.compile(r"[֐-׿]")


def hebrew_hints(title: str) -> str:
    if not _HEBREW.search(title or ""):
        return ""
    return " ".join(word for pattern, word in _HEBREW_HINTS if re.search(pattern, title))


MIN_DESCRIPTION = 300  # chars; LinkedIn sometimes serves a job page without its text


def _record(company, title, url, direct, description, posted, external_id) -> dict | None:
    """Every search here is already limited to Israel, so there is no location
    check. A listing whose description didn't come through is dropped: with
    only a title there is nothing to match against."""
    if len((description or "").strip()) < MIN_DESCRIPTION:
        return None
    # The company's own page when there is one: the apply button and auto-fill need it.
    best_url = direct if direct and direct.startswith("http") else url
    hints = hebrew_hints(title)
    rec = agg.build_record(company=company, title=f"{title} ({hints})" if hints else title, url=best_url,
                           description=description, published_at=posted, external_id=external_id)
    if rec:
        rec["title"] = (title or "").strip()[:255]
        rec["_links"] = [u for u in (direct, url) if u]
    return rec


# ── JobSpy: LinkedIn and Indeed ───────────────────────────────────────────────

def _jobspy_rows(scrape, site: str, term: str) -> list[dict]:
    kwargs = dict(site_name=[site], search_term=term, hours_old=HOURS_OLD, description_format="markdown",
                  verbose=0)
    if site == "linkedin":
        kwargs.update(location="Israel", results_wanted=LINKEDIN_RESULTS, fetch_description=True)
    else:
        kwargs.update(location="Israel", country_indeed="israel", results_wanted=INDEED_RESULTS)
    frame = scrape(**kwargs)
    return frame.to_dict("records") if hasattr(frame, "to_dict") else list(frame or [])


def _jobspy_record(row: dict) -> dict | None:
    return _record(
        company=_text(row.get("company")), title=_text(row.get("title")), url=_text(row.get("job_url")),
        direct=_text(row.get("job_url_direct")), description=_text(row.get("description")),
        posted=_as_utc(row.get("date_posted")), external_id=_text(row.get("id")) or None,
    )


async def fetch_jobspy(site: str, searches: list[str], scrape=None) -> tuple[list[dict], dict]:
    """One site's searches, one after another (gentler on rate limits)."""
    report: dict = {"searches": len(searches), "rows": 0, "jobs": 0, "errors": []}
    if scrape is None:
        try:
            from jobspy import scrape_jobs as scrape  # noqa: PLC0415 — optional, pipeline-only dependency
        except ImportError:
            report["skipped"] = f"python-jobspy not installed (pip install python-jobspy=={JOBSPY_VERSION})"
            return [], report
    records: dict[str, dict] = {}
    for term in searches:
        try:
            rows = await asyncio.to_thread(_jobspy_rows, scrape, site, term)
        except Exception as exc:  # noqa: BLE001 — a blocked search leaves the others
            report["errors"].append(f"{term}: {type(exc).__name__}: {exc}"[:200])
            logger.warning("[DM] %s search %r failed: %s", site, term, exc)
            continue
        report["rows"] += len(rows)
        for row in rows:
            rec = _jobspy_record(row)
            if rec:
                records.setdefault(rec["id"], rec)
    report["jobs"] = len(records)
    return list(records.values()), report


# ── JSearch (RapidAPI) ────────────────────────────────────────────────────────

def _jsearch_record(item: dict) -> dict | None:
    apply = _text(item.get("job_apply_link"))
    return _record(
        company=_text(item.get("employer_name")), title=_text(item.get("job_title")),
        url=apply or _text(item.get("job_google_link")), direct=apply,
        description=_text(item.get("job_description")),
        posted=agg.parse_datetime(item.get("job_posted_at_datetime_utc")),
        external_id=_text(item.get("job_id")) or None,
    )


async def fetch_jsearch(key: str | None = None, transport: httpx.AsyncBaseTransport | None = None
                        ) -> tuple[list[dict], dict]:
    key = key if key is not None else os.getenv("DM_JSEARCH_KEY", "")
    report: dict = {"queries": len(JSEARCH_QUERIES), "requests_charged": 0, "jobs": 0, "errors": []}
    if not key:
        report["skipped"] = "DM_JSEARCH_KEY not set"
        return [], report
    headers = {"X-RapidAPI-Key": key, "X-RapidAPI-Host": JSEARCH_HOST}
    records: dict[str, dict] = {}
    async with httpx.AsyncClient(transport=transport, timeout=60) as client:
        for query in JSEARCH_QUERIES:
            params = {"query": query, "country": "il", "date_posted": "today", "num_pages": str(JSEARCH_PAGES)}
            try:
                resp = await client.get(JSEARCH_URL, params=params, headers=headers)
                report["requests_charged"] += JSEARCH_PAGES
                if resp.status_code == 429:
                    report["errors"].append("monthly quota used up (HTTP 429)")
                    break
                resp.raise_for_status()
                body = resp.json().get("data") or []
                # v2 nests the jobs next to the paging cursor.
                data = (body.get("jobs") or body.get("data") or []) if isinstance(body, dict) else body
            except Exception as exc:  # noqa: BLE001
                report["errors"].append(f"{query}: {type(exc).__name__}: {exc}"[:200])
                continue
            for item in data:
                rec = _jsearch_record(item)
                if rec:
                    records.setdefault(rec["id"], rec)
    report["jobs"] = len(records)
    return list(records.values()), report
