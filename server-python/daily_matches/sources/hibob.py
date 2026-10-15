"""HiBob's careers sites, where companies that run HR on HiBob post their jobs.

A company's site is {name}-{id}.careers.hibob.com. Its page loads every
published job from /api/job-ad: title, country, description, requirements
and publishedAt in one list. The endpoint answers 401 to a request that
doesn't come from the site's own page, so the request says it does
(Referer), as the page's browser does. Probed on 2026-10-15: HiBob's own
site, 82 jobs, 20 in Israel.

Sites are found on companies' careers pages (careers_site.boards_in_html,
through registry.board_from_url) or seeded (employers.SEED_BOARDS).
"""
import re

import httpx

from app.services import job_aggregator as agg

_NANOS = re.compile(r"(\.\d{6})\d+")


def _published(raw):
    return agg.parse_datetime(_NANOS.sub(r"\1", raw)) if raw else None


async def fetch_hibob(client: httpx.AsyncClient, company: str, params: dict) -> list[dict]:
    """A site's Israeli tech jobs as pool records. Raises when the site can't
    be read, so the registry counts the failure."""
    base = f"https://{params['host']}"
    resp = await client.get(f"{base}/api/job-ad", timeout=30.0,
                            headers={"Referer": f"{base}/jobs", "Accept": "application/json"})
    resp.raise_for_status()
    out = []
    for ad in (resp.json() or {}).get("jobAdDetails") or []:
        if not isinstance(ad, dict) or not (ad.get("country") == "Israel" or agg.is_israel_location(ad.get("site"))):
            continue
        body = "\n".join(f"<h3>{name}</h3>{ad[key]}" for key, name in (
            ("description", "Description"), ("responsibilities", "Responsibilities"),
            ("requirements", "Requirements")) if ad.get(key))
        rec = agg.build_record(company=company, title=ad.get("title"), url=f"{base}/jobs/{ad.get('id')}",
                               description=agg.html_to_text(body), published_at=_published(ad.get("publishedAt")),
                               external_id=ad.get("id"))
        if rec:
            out.append(rec)
    return out
