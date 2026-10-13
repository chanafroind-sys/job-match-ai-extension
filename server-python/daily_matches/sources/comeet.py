"""Comeet, the applicant-tracking system many Israeli tech companies post on.

A company's board is hosted at comeet.com/jobs/{slug}/{uid}. The page carries
the company's public careers-API token (COMPANY_DATA.token): the same token
its own careers site uses in the browser. With it, Comeet's careers API
returns every published position with its description and requirements
(details=true). So a board costs two requests a day: the page, then the API.

Probed live on 2026-10-13: Upwind Security (49.004), 89 positions, 26 in
Israel, each with "Description" and "Requirements" in its details.

A board can't be found from the company's name: its address needs the uid.
Boards come from links (registry.board_from_url) and from SEED_BOARDS below.
"""
import asyncio
import json
import logging
import re

import httpx

from app.services import job_aggregator as agg

logger = logging.getLogger(__name__)

HOSTED = "https://www.comeet.com/jobs/{slug}/{uid}"
API = "https://www.comeet.co/careers-api/2.0/company/{uid}/positions"
API_TIMEOUT_S = 60.0  # Comeet's advice for a large list
_TOKEN = re.compile(r'"token"\s*:\s*"([0-9A-Fa-f]{16,64})"')

# Israeli companies whose Comeet boards were found through search and read
# live on 2026-10-13: 40 of them had 323 Israeli tech positions between them.
# The registry's start (registry.seed_boards); boards found in job links join
# them on their own. (slug, uid, company)
SEED_BOARDS: tuple[tuple[str, str, str], ...] = (
    ("vastdata", "43.001", "VAST Data"),
    ("team8", "61.003", "Team8"),
    ("dreamgroup", "99.002", "Dream"),
    ("abra_rnd", "15.007", "abra"),
    ("comm-it", "76.008", "CommIT"),
    ("infinidat", "D6.003", "INFINIDAT"),
    ("paragon", "76.006", "Paragon"),
    ("drivenets", "72.006", "DRIVENETS"),
    ("cyera", "17.008", "Cyera"),
    ("fetcherr", "68.006", "Fetcherr"),
    ("upwind", "49.004", "Upwind Security"),
    ("alice", "D5.005", "Alice"),
    ("majesticlabs", "AA.004", "Majestic Labs"),
    ("vega", "C9.009", "Vega"),
    ("noma_security", "3A.005", "Noma Security"),
    ("zenity", "19.000", "Zenity"),
    ("deloitte", "F7.00B", "Deloitte"),
    ("silverfort", "54.007", "Silverfort"),
    ("oligosecurity", "5A.00B", "Oligo Security"),
    ("kaltura", "E2.00D", "Kaltura"),
    ("kelatechnologies", "2A.007", "Kela Technologies"),
    ("exodigo", "89.005", "Exodigo"),
    ("inmanage", "B7.006", "inManage"),
    ("coralogix", "06.004", "Coralogix"),
    ("classiq", "F7.008", "Classiq"),
    ("uveye", "92.00F", "UVeye"),
    ("somekhchaikin", "F3.007", "KPMG"),
    ("kenshoo", "22.00A", "Skai"),
    ("dbank", "F8.004", "Discount Bank"),
    ("cyberillium", "58.004", "Cyberillium"),
    ("cognyte", "F2.009", "Cognyte"),
    ("checkmarx", "C0.008", "Checkmarx"),
    ("abra-web-mobile", "D3.004", "abra Web & Mobile"),
    ("overwolf", "B1.001", "Overwolf"),
    ("guardio", "57.000", "Guardio"),
    ("global-e", "62.002", "Global-e"),
    ("genpact", "B9.008", "Genpact"),
    ("rapyd", "73.00E", "Rapyd"),
    ("incredibuild", "66.00F", "Incredibuild"),
    ("Kayhut", "F0.00B", "Kayhut"),
    # No Israeli tech opening on 2026-10-13, but Israeli R&D that hires: read daily all the same.
    ("webbing", "46.00E", "Webbing"),
    ("unleash", "B9.009", "Unleash"),
    ("papayaglobal", "16.005", "Papaya Global"),
    ("morphisec", "65.00C", "Morphisec"),
    ("moovit", "63.007", "Moovit"),
    ("joinattil", "38.00A", "AT&T Israel"),
    ("grip", "A8.001", "Grip Security"),
    ("btbisrael", "78.00B", "Be The Bank"),
    ("algosec", "71.006", "AlgoSec"),
    ("RemitlyIL", "34.00D", "Remitly IL"),
)


def company_data(html: str) -> dict:
    """The COMPANY_DATA object of a hosted board page, or {}."""
    at = html.find("COMPANY_DATA")
    if at < 0:
        return {}
    start = html.find("{", at)
    try:
        data, _ = json.JSONDecoder().raw_decode(html[start:])
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _in_israel(position: dict) -> bool:
    loc = position.get("location") or {}
    return loc.get("country") == "IL" or agg.is_israel_location(loc.get("name"), loc.get("city"), loc.get("state"))


def _description(position: dict) -> str:
    parts = [f"<h3>{d.get('name') or ''}</h3>{d.get('value') or ''}" for d in position.get("details") or []]
    return agg.html_to_text("\n".join(parts))


async def _positions(client: httpx.AsyncClient, uid: str, token: str) -> list:
    for attempt in range(2):
        try:
            resp = await client.get(API.format(uid=uid), params={"token": token, "details": "true"},
                                    timeout=API_TIMEOUT_S)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                await asyncio.sleep(2)
                continue
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, list) else []
        except httpx.TransportError:
            if attempt:
                raise
            await asyncio.sleep(2)
    return []


async def fetch_comeet(client: httpx.AsyncClient, company: str, params: dict) -> list[dict]:
    """A board's Israeli tech positions as pool records. Raises when the board
    can't be read (no page, no token), so the registry counts the failure."""
    page = await client.get(HOSTED.format(slug=params["slug"], uid=params["uid"]), timeout=30.0)
    page.raise_for_status()
    data = company_data(page.text)
    token = data.get("token") or (_TOKEN.search(page.text) or [None, None])[1]
    if not token:
        raise ValueError("no careers token on the board's page")
    name = (data.get("name") or company or "").strip()
    out = []
    for p in await _positions(client, params["uid"], token):
        if not isinstance(p, dict) or not _in_israel(p):
            continue
        rec = agg.build_record(
            company=name, title=p.get("name"), url=p.get("url_comeet_hosted_page") or p.get("url_active_page"),
            description=_description(p), published_at=agg.parse_datetime(p.get("time_updated")),
            external_id=p.get("uid"),
        )
        if rec:
            out.append(rec)
    return out
