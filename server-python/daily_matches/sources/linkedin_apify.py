"""LinkedIn's jobs through Apify, when DM_APIFY_TOKEN is set.

LinkedIn refuses cloud servers, and a home connection after a few requests
(2026-10-14), so its public search is read by an Apify Actor instead
(valig/linkedin-jobs-scraper: $0.40 per 1,000 jobs on Apify's free plan,
which gives $5 of usage a month and pauses, never bills, when it's spent).

Paying per job, the collector pays only for jobs it doesn't have:
  - the searches run one after another, each told to skip (skipJobId) the
    jobs the earlier ones returned, so a job matching two fields is paid once;
  - LinkedIn jobs already in the pool are skipped too;
  - Friday and Saturday, when few jobs are posted in Israel, are skipped
    (SKIP_WEEKDAYS); Sunday's searches reach back over the weekend.
And it spends the month's credit evenly: each day gets what's left of it,
divided by the working days left in Apify's billing cycle (daily_budget).
The report says what was spent, what's left, and for how many days.
"""
import asyncio
import logging
import math
import os
from datetime import datetime, timedelta, timezone

import httpx

from daily_matches import config
from daily_matches.sources.aggregators import _env_list, _record
from daily_matches.sources.linkedin import _looks_technical

logger = logging.getLogger(__name__)

API = "https://api.apify.com/v2"
ACTOR = os.environ.get("DM_APIFY_ACTOR", "valig~linkedin-jobs-scraper")
PRICE_PER_1K = float(os.environ.get("DM_APIFY_PRICE_PER_1K", "0.40"))  # the Actor's price on the free plan
# Grouped, so a day is a few Actor runs; each run skips what the earlier ones found.
SEARCHES = _env_list("DM_APIFY_SEARCHES", [
    'backend OR frontend OR "full stack" OR fullstack OR "software engineer" OR developer OR programmer',
    'devops OR SRE OR "platform engineer" OR "cloud engineer" OR "data engineer" OR "data scientist" '
    'OR "machine learning" OR "AI engineer" OR LLM OR "computer vision"',
    'QA OR "automation engineer" OR SDET OR android OR iOS OR mobile OR embedded OR firmware '
    'OR "security engineer" OR "security researcher" OR cyber',
    '"team lead" OR "engineering manager" OR "tech lead" OR architect',
])
SKIP_WEEKDAYS = (4, 5)  # Friday, Saturday (Python's weekday(): Monday is 0)
MAX_PER_RUN = 1000  # the Actor's own maximum
RUN_TIMEOUT_S = 900
WAIT_STEP_S = 60  # Apify's longest waitForFinish


class ApifyError(Exception):
    pass


def token() -> str:
    return os.environ.get("DM_APIFY_TOKEN", "").strip()


def window_hours(il_now: datetime) -> int:
    """How far back today's searches look: a day plus slack, and on Sunday
    back over the skipped weekend."""
    return 74 if il_now.weekday() == 6 and SKIP_WEEKDAYS else 26


def working_days_left(il_today, cycle_end) -> int:
    """Days from today to the end of the billing cycle, today included, that
    aren't skipped."""
    days, day = 0, il_today
    while day <= cycle_end:
        days += day.weekday() not in SKIP_WEEKDAYS
        day += timedelta(days=1)
    return max(1, days)


def daily_budget(limits: dict, il_now: datetime) -> dict:
    """Today's share of the month's credit, from Apify's /users/me/limits."""
    used = float(((limits.get("current") or {}).get("monthlyUsageUsd")) or 0)
    cap = float(((limits.get("limits") or {}).get("maxMonthlyUsageUsd")) or 5)
    end_raw = (limits.get("monthlyUsageCycle") or {}).get("endAt")
    try:
        cycle_end = config.to_israel(datetime.fromisoformat(end_raw.replace("Z", "+00:00"))).date()
    except (AttributeError, ValueError):
        cycle_end = il_now.date() + timedelta(days=30)
    left = max(0.0, cap - used)
    days = working_days_left(il_now.date(), cycle_end)
    usd = left / days
    return {"used_usd": round(used, 2), "limit_usd": round(cap, 2), "left_usd": round(left, 2),
            "working_days_left": days, "today_usd": round(usd, 3),
            "today_jobs": int(usd / PRICE_PER_1K * 1000)}


async def _api(client, method: str, path: str, **kwargs) -> dict:
    resp = await client.request(method, f"{API}{path}", **kwargs)
    if resp.status_code >= 400:
        try:
            err = (resp.json().get("error") or {})
            detail = f"{err.get('type', '')}: {err.get('message', '')}"
        except ValueError:
            detail = resp.text[:120]
        raise ApifyError(f"HTTP {resp.status_code} {detail}"[:200])
    return resp.json()


async def _run(client, query: str, hours: int, limit: int, skip: list[str], sleep) -> list[dict]:
    """One Actor run, to its end; its jobs."""
    # datePosted takes only a day, a week or a month (refused on 2026-10-14);
    # LinkedIn's own f_TPR, passed through urlParam, takes any window.
    body = {"keywords": query, "location": "Israel", "limit": limit, "skipJobId": skip,
            "urlParam": [{"key": "f_TPR", "value": f"r{hours * 3600}"}]}
    charge_cap = round(limit * PRICE_PER_1K / 1000 * 1.1 + 0.005, 3)  # Apify stops the run past this
    run = (await _api(client, "POST", f"/acts/{ACTOR}/runs", json=body,
                      params={"maxTotalChargeUsd": charge_cap, "timeout": RUN_TIMEOUT_S}))["data"]
    waited = 0
    while run.get("status") in ("READY", "RUNNING", "TIMING-OUT", "ABORTING") and waited <= RUN_TIMEOUT_S + 60:
        run = (await _api(client, "GET", f"/actor-runs/{run['id']}", params={"waitForFinish": WAIT_STEP_S}))["data"]
        waited += WAIT_STEP_S
        if run.get("status") in ("READY", "RUNNING"):
            await sleep(1)
    if run.get("status") not in ("SUCCEEDED", "ABORTED", "TIMED-OUT"):  # a stopped run keeps what it found
        raise ApifyError(f"run {run.get('status')}")
    items = await _api(client, "GET", f"/datasets/{run['defaultDatasetId']}/items",
                       params={"clean": "true", "format": "json"})
    return items if isinstance(items, list) else []


def _to_record(item: dict) -> dict | None:
    job_id = str(item.get("id") or "").strip()
    if not job_id or not _looks_technical(item.get("title") or ""):
        return None
    posted = None
    if item.get("postedDate"):
        try:
            posted = datetime.fromisoformat(str(item["postedDate"]).replace("Z", "+00:00"))
            posted = posted if posted.tzinfo else posted.replace(tzinfo=timezone.utc)
        except ValueError:
            posted = None
    return _record(company=item.get("companyName") or "", title=item.get("title") or "",
                   url=f"https://www.linkedin.com/jobs/view/{job_id}", direct="",
                   description=item.get("description") or "", posted=posted, external_id=job_id)


async def fetch_linkedin_apify(in_pool: list[str], *, now: datetime | None = None, transport=None,
                               sleep=asyncio.sleep) -> tuple[list[dict], dict]:
    """in_pool: LinkedIn job ids the pool holds already (never paid for again)."""
    report: dict = {"via_apify": True, "searches": [], "cards": 0, "jobs": 0, "not_tech_or_short": 0,
                    "blocked": None, "cost_usd": 0.0}
    il_now = config.to_israel(now or config.utcnow())
    if il_now.weekday() in SKIP_WEEKDAYS:
        report["skipped"] = "weekend: Sunday's searches cover it"
        return [], report
    headers = {"Authorization": f"Bearer {token()}"}
    records: dict[str, dict] = {}
    async with httpx.AsyncClient(headers=headers, transport=transport, timeout=90) as client:
        try:
            budget = daily_budget((await _api(client, "GET", "/users/me/limits"))["data"], il_now)
        except (ApifyError, httpx.HTTPError, KeyError) as exc:
            report["blocked"] = f"apify: {exc}"[:200]
            return [], report
        report["credit"] = budget
        left = budget["today_jobs"]
        skip = list(dict.fromkeys(str(i) for i in in_pool))
        hours = window_hours(il_now)
        for query in SEARCHES:
            if left <= 0:
                report["searches"].append({"query": query, "jobs": 0, "skipped": "today's budget is spent"})
                continue
            try:
                items = await _run(client, query, hours, min(MAX_PER_RUN, left), skip, sleep)
            except (ApifyError, httpx.HTTPError) as exc:
                report["blocked"] = f"apify: {exc}"[:200]
                break
            left -= len(items)
            report["cards"] += len(items)
            report["cost_usd"] += len(items) * PRICE_PER_1K / 1000
            report["searches"].append({"query": query, "jobs": len(items), "capped": len(items) >= MAX_PER_RUN})
            for item in items:
                skip.append(str(item.get("id") or ""))
                rec = _to_record(item)
                if rec:
                    records.setdefault(rec["id"], rec)
                else:
                    report["not_tech_or_short"] += 1
    report["cost_usd"] = round(report["cost_usd"], 3)
    report["jobs"] = len(records)
    # Today's budget ran out before the searches did: some of today's jobs weren't fetched.
    report["budget_capped"] = left <= 0
    # At today's spending, how many more working days the credit lasts (vs. working_days_left).
    rest = budget["left_usd"] - report["cost_usd"]
    report["credit"]["lasts_working_days"] = math.floor(rest / report["cost_usd"]) if report["cost_usd"] else None
    logger.warning("[DM] linkedin (apify): %s", {k: v for k, v in report.items() if k != "searches"})
    return list(records.values()), report
