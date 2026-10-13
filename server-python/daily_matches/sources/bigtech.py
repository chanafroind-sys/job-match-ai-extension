"""Amazon and Microsoft, whose careers sites run on their own systems.

Each publishes a public JSON search behind its careers site, and each is read
as one more registry board (ats "amazon" / "microsoft", seeded in
employers.py), so failures and counts are tracked like any other board.

Probed live on 2026-10-13:
  Amazon     amazon.jobs/en/search.json, country ISR: 161 positions, each with
             its description and qualifications (Annapurna Labs included).
  Microsoft  apply.careers.microsoft.com/api/pcsx/search, location Israel: 25
             positions, ten a page and no description; the description comes
             from position_details, one request a job. It answers 429 to a
             quick burst, so its requests go one at a time, paced.
"""
import asyncio
import re
from datetime import datetime, timezone

import httpx

from app.services import job_aggregator as agg

AMAZON_SEARCH = "https://www.amazon.jobs/en/search.json"
AMAZON_PAGE = 100
AMAZON_MAX = 1000
MS_BASE = "https://apply.careers.microsoft.com"
MS_SEARCH = MS_BASE + "/api/pcsx/search"
MS_DETAILS = MS_BASE + "/api/pcsx/position_details"
MS_PAGE = 10
MS_MAX_PAGES = 30
MS_PAUSE_S = 1.5
MS_RATE_WAIT_S = 20.0
JSON_HEADERS = {"Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"}

_sleep = asyncio.sleep  # tests replace it


def _amazon_date(text: str | None) -> datetime | None:
    """'September  2, 2026' → that day, UTC."""
    try:
        return datetime.strptime(re.sub(r"\s+", " ", (text or "").strip()), "%B %d, %Y").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


async def fetch_amazon(client: httpx.AsyncClient, company: str, params: dict) -> list[dict]:
    out, offset, total = [], 0, None
    while offset < AMAZON_MAX and (total is None or offset < total):
        data = await agg._get_json(client, "GET", AMAZON_SEARCH, params={
            "country": params.get("country", "ISR"), "result_limit": AMAZON_PAGE, "offset": offset, "sort": "recent"},
            headers=JSON_HEADERS)
        jobs = data.get("jobs") or []
        total = int(data.get("hits") or 0)
        for j in jobs:
            if j.get("country_code") != "ISR":
                continue
            parts = [j.get("description") or "", "<h3>Basic qualifications</h3>" + (j.get("basic_qualifications") or ""),
                     "<h3>Preferred qualifications</h3>" + (j.get("preferred_qualifications") or "")]
            rec = agg.build_record(
                company=j.get("company_name") or company, title=j.get("title"),
                url=f"https://www.amazon.jobs{j['job_path']}" if j.get("job_path") else None,
                description=agg.html_to_text("\n".join(parts)), published_at=_amazon_date(j.get("posted_date")),
                external_id=j.get("id_icims") or j.get("id"))
            if rec:
                out.append(rec)
        if not jobs:
            break
        offset += len(jobs)
    return out


async def _ms_get(client: httpx.AsyncClient, url: str, params: dict) -> dict:
    """One paced request; a 429 is waited out once."""
    for attempt in range(2):
        await _sleep(MS_PAUSE_S)
        resp = await client.get(url, params=params, headers=JSON_HEADERS, timeout=30.0)
        if resp.status_code == 429 and attempt == 0:
            await _sleep(MS_RATE_WAIT_S)
            continue
        resp.raise_for_status()
        return resp.json().get("data") or {}
    return {}


async def fetch_microsoft(client: httpx.AsyncClient, company: str, params: dict) -> list[dict]:
    location = params.get("location", "Israel")
    positions: list[dict] = []
    for page in range(MS_MAX_PAGES):
        data = await _ms_get(client, MS_SEARCH, {"domain": "microsoft.com", "query": "", "location": location,
                                                 "start": page * MS_PAGE, "sort_by": "timestamp"})
        batch = data.get("positions") or []
        positions += batch
        if len(batch) < MS_PAGE or len(positions) >= int(data.get("count") or 0):
            break
    out = []
    for p in positions:
        places = " ".join((p.get("standardizedLocations") or []) + (p.get("locations") or []))
        if not (agg.is_israel_location(places) or ", IL" in places):
            continue
        if not agg.is_potential_tech_title(p.get("name") or ""):
            continue  # a details request only for jobs that may be kept
        details = await _ms_get(client, MS_DETAILS, {"position_id": p["id"], "domain": "microsoft.com", "hl": "en"})
        posted = p.get("postedTs") or p.get("creationTs")
        rec = agg.build_record(
            company=company or "Microsoft", title=p.get("name"),
            url=details.get("publicUrl") or f"{MS_BASE}/careers/job/{p['id']}",
            description=agg.html_to_text(details.get("jobDescription") or ""),
            published_at=datetime.fromtimestamp(posted, tz=timezone.utc) if posted else None,
            external_id=p.get("displayJobId") or p.get("id"))
        if rec:
            out.append(rec)
    return out
