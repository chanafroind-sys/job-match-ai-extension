"""Check Point, whose careers site runs on its own system.

careers.checkpoint.com lists jobs from a Solr index, ten a page; a country
filter (fa[]=country_s:Israel) and rows=N return them all in one page, each
card with its id (data-id), title (data-title) and location. A job's page
(a=show&joborderid=N) holds its description in #jobOrderInfo. Neither shows
when a job was posted, so a job counts as new from the day the pool first
sees it.

Probed live on 2026-10-15: 94 positions in Israel. Read as one more registry
board (ats "checkpoint", seeded in employers.py); a job page is fetched only
for a title that may be tech, one at a time, paced.
"""
import asyncio
import html as html_lib
import re

import httpx

from app.services import job_aggregator as agg

BASE = "https://careers.checkpoint.com/index.php"
ROWS = 500
PAUSE_S = 0.5
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                         "Chrome/140.0 Safari/537.36"}

_CARD = re.compile(r'data-id="(\d+)"\s+data-title="([^"]*)"')
_PLACE = re.compile(r'class="place">\s*([^<]+)<')
_BODY = re.compile(r'<div id="jobOrderInfo">(.*?)<div id="(?:shareSection|linksContainer|footerMenu|statement)"', re.S)

_sleep = asyncio.sleep  # tests replace it


def parse_list(page: str) -> list[dict]:
    """The cards of a search page: id, title, location."""
    out, seen = [], set()
    for card in page.split('<div class="position">')[1:]:
        m = _CARD.search(card)
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        place = _PLACE.search(card)
        out.append({"id": m.group(1), "title": html_lib.unescape(m.group(2)).strip(),
                    "location": html_lib.unescape(place.group(1)).strip() if place else ""})
    return out


def parse_job(page: str) -> str:
    m = _BODY.search(page)
    return agg.html_to_text(m.group(1)) if m else ""


async def fetch_checkpoint(client: httpx.AsyncClient, company: str, params: dict) -> list[dict]:
    """The Israeli tech positions as pool records. Raises when the list can't
    be read, so the registry counts the failure."""
    country = params.get("country", "Israel")
    resp = await client.get(f"{BASE}?module=cpcareers&a=search&q=&fa[]=country_s:{country}&rows={ROWS}",
                            headers=HEADERS, timeout=60.0)
    resp.raise_for_status()
    out = []
    for job in parse_list(resp.text):
        if not agg.is_potential_tech_title(job["title"]):
            continue  # a job page only for jobs that may be kept
        url = f"{BASE}?m=cpcareers&a=show&joborderid={job['id']}"
        try:
            page = await client.get(url, headers=HEADERS, timeout=30.0)
            page.raise_for_status()
        except httpx.HTTPError:
            continue  # one job page never sinks the list
        rec = agg.build_record(company=company or "Check Point", title=job["title"], url=url,
                               description=parse_job(page.text), published_at=None, external_id=job["id"])
        if rec:
            out.append(rec)
        await _sleep(PAUSE_S)
    return out
