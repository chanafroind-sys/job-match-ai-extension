"""Where a company's jobs really live, found from outside: its Workday board,
or whatever ATS its own careers page shows.

probe.py guesses Greenhouse, Lever and Ashby boards from a company's name.
Two ATSs can't be guessed that way, and this finds them:

Workday  a board is {tenant}.wd{N}.myworkdayjobs.com/{site}. The tenant is
         usually the company's name; N is one of a few data centers. A
         wrong pair answers robots.txt with 422, a real one with its
         robots.txt, which names the board's sites (probed 2026-10-13:
         nvidia.wd5 → NVIDIAExternalCareerSite, intel.wd1 → External).
Comeet   a board's address carries a uid that no name gives away. The
         company's own careers page does: either links to its Comeet board,
         or Comeet's careers widget, whose public token (the same one the
         page's browser uses) opens Comeet's careers API, where each
         position links back to the board (probed 2026-10-13: Upwind,
         Silverfort and Zenity show the token; Cyera links its board).

The careers page comes from the aggregator listing when it names the
company's website (JSearch, Indeed), else from guessing the company's domain.
Every board found here is only a candidate: probe.py trusts it only after it
lists one of the company's jobs.
"""
import asyncio
import re

import httpx

from daily_matches.sources import comeet
from daily_matches.sources.registry import board_from_url

WORKDAY_DCS = (1, 3, 5, 10, 12, 103, 108)  # the wd{N} hosts that answer (2026-10-13)
MAX_SITES = 3  # Workday sites tried per tenant
GUESSED_TLDS = ("com", "io", "co.il", "ai")
MAX_HTML = 3_000_000
TIMEOUT_S = 15.0

_ROBOTS_PATH = re.compile(r"^(?:allow|disallow|sitemap)\s*:\s*(?:https?://[^/\s]+)?/([A-Za-z0-9_-]+)/", re.I | re.M)
_NOT_A_SITE = re.compile(r"refreshfacet|hidden|private|temp|test|sandbox", re.I)
_URL = re.compile(r"https?://[^\s\"'<>()\\]+", re.I)
_COMEET_TOKEN = re.compile(r"token[\"'\s:=]{1,8}([0-9A-F]{16,64})\b", re.I)
_COMEET_UID = re.compile(r"[\"'/]([0-9A-F]{2}\.[0-9A-F]{3})[\"'/]", re.I)
# The company's own uid, by name: COMEET.init's "company-uid", the WordPress plugin's "comeet_uid".
_COMEET_COMPANY_UID = re.compile(r"(?:company[-_]?uid|comeet_uid)[\"'\s:=]{1,8}([0-9A-F]{2}\.[0-9A-F]{3})\b", re.I)


def workday_sites(robots: str) -> list[str]:
    """A Workday host's job-board sites, from its robots.txt: the published
    ones (Allow, Sitemap) first. A company's main board can be Disallowed
    too (Palo Alto's is), so those come after."""
    found = [(line.split(":", 1)[0].strip().lower(), m.group(1)) for line in robots.splitlines()
             if (m := _ROBOTS_PATH.match(line.strip()))]
    order = {"allow": 0, "sitemap": 0, "disallow": 1}
    sites = [s for _, s in sorted(found, key=lambda kv: order.get(kv[0], 2)) if not _NOT_A_SITE.search(s)]
    return list(dict.fromkeys(sites))[:MAX_SITES]


def boards_in_html(html: str) -> list[tuple[str, str, dict]]:
    """Every ATS board a page links to (registry.board_from_url), in order."""
    out, seen = [], set()
    for url in _URL.findall(html.replace("\\/", "/")):
        found = board_from_url(url)
        if found and found[:2] not in seen:
            seen.add(found[:2])
            out.append(found)
    return out


def comeet_widget(html: str) -> tuple[str | None, list[str]]:
    """Comeet's careers widget on a page: its token and the uids it might be
    for, the one named as the company's first (a page lists its positions'
    uids too, which look the same)."""
    text = re.sub(r"\\+", "", html)
    token = _COMEET_TOKEN.search(text) if "comeet" in text.lower() else None
    if not token:
        return None, []
    named = _COMEET_COMPANY_UID.findall(text)
    return token.group(1), list(dict.fromkeys(m.upper() for m in named + _COMEET_UID.findall(text)))[:12]


async def _get(client: httpx.AsyncClient, sem: asyncio.Semaphore, url: str, **kwargs) -> httpx.Response | None:
    async with sem:
        try:
            return await client.get(url, timeout=TIMEOUT_S, **kwargs)
        except (httpx.HTTPError, ValueError):
            return None


async def workday_boards(client, sem, tenants: list[str]) -> list[tuple[str, str, dict]]:
    """Workday boards that exist under these tenant names."""
    out = []
    for tenant in tenants:
        if not re.fullmatch(r"[a-z0-9]{2,40}", tenant):
            continue
        for dc in WORKDAY_DCS:
            host = f"{tenant}.wd{dc}.myworkdayjobs.com"
            resp = await _get(client, sem, f"https://{host}/robots.txt")
            if resp is None or resp.status_code != 200:
                continue
            out += [("workday", f"{host}/{site}".lower(), {"host": host, "site": site})
                    for site in workday_sites(resp.text)]
            break  # a tenant lives in one data center
    return out


async def _comeet_board(client, sem, token: str, uids: list[str]) -> tuple[str, str, dict] | None:
    """The widget's board: the uid the token opens, and the board address its
    positions link to."""
    for uid in uids:
        resp = await _get(client, sem, comeet.API.format(uid=uid), params={"token": token})
        if resp is None or resp.status_code != 200:
            continue
        try:
            positions = resp.json()
        except ValueError:
            continue
        for p in positions if isinstance(positions, list) else []:
            found = board_from_url((p or {}).get("url_comeet_hosted_page"))
            if found and found[0] == "comeet":
                return found
        return None  # the right uid, but no position to learn the board's address from
    return None


def careers_pages(site: str | None, names: list[str]) -> list[str]:
    """Pages to read: the company's own site when the listing named it, else
    its guessed domains."""
    if site:
        m = re.match(r"^(?:https?://)?([^/\s?#]+)", site.strip(), re.I)
        if m and "." in m.group(1):
            origin = f"https://{m.group(1).lower()}"
            return [f"{origin}/careers", origin]
    alnum = [n for n in names if re.fullmatch(r"[a-z0-9]{2,40}", n)][:1]
    return [f"https://www.{n}.{tld}/careers" for n in alnum for tld in GUESSED_TLDS]


async def site_boards(client, sem, site: str | None, names: list[str]) -> list[tuple[str, str, dict]]:
    """The boards a company's careers page shows, from the first page that
    shows any."""
    for url in careers_pages(site, names):
        resp = await _get(client, sem, url, follow_redirects=True)
        if resp is None or resp.status_code != 200:
            continue
        html = resp.text[:MAX_HTML]
        found = boards_in_html(html)
        if not any(ats == "comeet" for ats, _, _ in found):
            token, uids = comeet_widget(html)
            board = await _comeet_board(client, sem, token, uids) if token else None
            if board:
                found.append(board)
        if found:
            return found
    return []
