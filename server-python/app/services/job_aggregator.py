"""Daily job-pool aggregator: pulls open tech positions located in Israel from
public ATS career-board APIs (Greenhouse, Lever, Ashby, SmartRecruiters,
Workday) plus — only when RAPIDAPI_KEY is set — the JSearch API, classifies
each by category/seniority, and upserts them into daily_job_pool.

Per-source failures are logged and counted in the returned report instead of
being swallowed, so an empty pool is diagnosable from the sync response/logs.
"""
import asyncio
import hashlib
import html
import logging
import os
import re
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

import httpx
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.job_pool import DailyJobPool
from app.services.israel_job_sources import COMPANIES

logger = logging.getLogger(__name__)

RAPIDAPI_KEY = os.getenv("RAPIDAPI_KEY", "")
RAPIDAPI_HOST = "jsearch.p.rapidapi.com"

# JSearch is an optional extra source — the ATS boards above don't need a key.
JSEARCH_QUERIES = [
    "Backend Developer in Israel",
    "Full Stack Engineer in Israel",
    "DevOps Engineer in Israel",
    "Frontend Developer in Israel",
    "Machine Learning Engineer in Israel",
    "Data Engineer in Israel",
]

# Rows not re-seen by a sync for this long are treated as closed and purged.
STALE_AFTER = timedelta(days=7)

HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; JobMatchAI-Aggregator/1.0)"}
WORKDAY_PAGE_SIZE = 20
UPSERT_CHUNK = 500

CATEGORIES = [
    "Backend", "Frontend", "Full Stack", "DevOps", "Mobile", "Data", "AI / ML",
    "QA", "Security", "Embedded", "Hardware",
]

# Free-text category spellings the API accepts → canonical CATEGORIES value.
CATEGORY_ALIASES = {
    "backend": "Backend", "back end": "Backend", "back-end": "Backend", "server": "Backend",
    "server side": "Backend", "software engineer": "Backend",
    "frontend": "Frontend", "front end": "Frontend", "front-end": "Frontend",
    "fullstack": "Full Stack", "full stack": "Full Stack", "full-stack": "Full Stack",
    "devops": "DevOps", "sre": "DevOps", "infrastructure": "DevOps", "cloud": "DevOps",
    "platform": "DevOps",
    "mobile": "Mobile", "ios": "Mobile", "android": "Mobile",
    "data": "Data", "data engineering": "Data", "bi": "Data",
    "ai / ml": "AI / ML", "ai/ml": "AI / ML", "ai": "AI / ML", "ml": "AI / ML",
    "machine learning": "AI / ML", "data science": "AI / ML",
    "qa": "QA", "automation": "QA", "testing": "QA",
    "security": "Security", "cyber": "Security",
    "embedded": "Embedded", "firmware": "Embedded",
    "hardware": "Hardware", "chip design": "Hardware",
}


def normalize_category(raw: str) -> str | None:
    key = re.sub(r"\s+", " ", (raw or "").strip().lower())
    if not key:
        return None
    for cat in CATEGORIES:
        if cat.lower() == key:
            return cat
    return CATEGORY_ALIASES.get(key)


# ---------------------------------------------------------------------------
# Location filter
# ---------------------------------------------------------------------------

_ISRAEL_RE = re.compile(
    r"israel|tel[\s-]?aviv|herzl|jerusalem|haifa|ra.?anana|petah|petach|ramat[\s-]?gan|"
    r"netanya|rehovot|yokne|be.?er[\s-]?sheva|hod[\s-]?hasharon|kfar[\s-]?saba|or[\s-]?yehuda|"
    r"rosh[\s-]?ha.?ayin|airport city|caesarea|\blod\b|modi.?in|givatayim|bnei[\s-]?brak|holon|"
    r"migdal[\s-]?ha.?emek|\bTLV\b",
    re.I,
)


def is_israel_location(*texts: str | None) -> bool:
    return any(t and _ISRAEL_RE.search(t) for t in texts)


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def _rx(*patterns: str) -> re.Pattern:
    return re.compile("|".join(patterns), re.I)

# Title rules, checked in order — the first match wins. Explicit role words
# come before domain words ("Backend Engineer, Cloud Security" → Backend), and
# "AI" alone is treated as a modifier, not a role ("AI QA Lead" → QA).
_HARDWARE_STRONG = _rx(
    r"\basic\b", r"\bvlsi\b", r"\brtl\b", r"\bfpga\b", r"physical design", r"design verification",
    r"verification engineer", r"\bdft\b", r"chip design", r"\bsoc (?:design|architect)", r"layout engineer",
    r"hardware (?:engineer|architect|design|developer)", r"\banalog\b", r"silicon (?:design|validation)",
)
_TITLE_RULES: list[tuple[str, re.Pattern]] = [
    ("Full Stack", _rx(r"full[\s-]?stack")),
    ("Frontend", _rx(r"front[\s-]?end", r"\bui (?:engineer|developer)", r"\bweb developer")),
    ("Hardware", _HARDWARE_STRONG),  # before Backend: "Physical Design Backend Engineer" is chip work
    ("Backend", _rx(r"back[\s-]?end", r"server[\s-]side", r"\bapi (?:engineer|developer)")),
    ("Mobile", _rx(r"\bmobile\b", r"\bios\b", r"\bandroid\b", r"react native", r"\bflutter\b")),
    ("DevOps", _rx(r"dev[\s-]?ops", r"\bsre\b", r"site reliability", r"\bplatform engineer",
                   r"infrastructure engineer", r"\bcloud engineer", r"production engineer",
                   r"\bdevsecops\b", r"build (?:and|&) release", r"\bfinops\b")),
    ("QA", _rx(r"\bqa\b", r"quality assurance", r"\bsdet\b", r"test automation", r"automation engineer",
               r"automation developer", r"software test", r"\btester\b", r"software verification")),
    ("Security", _rx(r"security (?:researcher|engineer|analyst|architect|engineering)", r"\bcyber",
                     r"penetration", r"\bpentest", r"vulnerability research", r"malware",
                     r"threat (?:research|intel)", r"\bsoc (?:analyst|engineer)", r"application security",
                     r"\bappsec\b")),
    ("AI / ML", _rx(r"machine learning", r"\bml\b", r"\bmlops\b", r"\bllm", r"deep learning",
                    r"computer vision", r"\bnlp\b", r"data scien", r"\balgorithm", r"\bgenai\b",
                    r"applied scientist", r"research scientist",
                    r"\bai (?:engineer|developer|researcher|scientist|research)", r"\bai\s*/\s*ml\b",
                    r"\bai\s*&\s*ml\b", r"applied ai")),
    ("Data", _rx(r"data engineer", r"data analyst", r"\bbi\b", r"business intelligence", r"big data",
                 r"analytics engineer", r"data platform", r"\betl\b", r"data architect")),
    ("Hardware", _rx(r"hardware", r"silicon", r"\bchip\b", r"board design", r"\bpcb\b",
                     r"signal integrity", r"\bcad engineer")),
    ("Embedded", _rx(r"embedded", r"firmware", r"linux kernel", r"\bkernel\b", r"\bbsp\b",
                     r"low[\s-]level", r"device driver", r"\brtos\b")),
    ("Backend", _rx(r"\bjava\b", r"\bpython\b", r"\bgolang\b", r"\bgo (?:developer|engineer)",
                    r"\bnode(?:\.?js)?\b", r"\.net\b", r"\bc#", r"\bscala\b", r"\bruby\b", r"\bphp\b",
                    r"\bc\+\+", r"\brust\b", r"\bdistributed systems", r"\bmicroservices")),
    ("Frontend", _rx(r"\breact\b", r"\bangular\b", r"\bvue\b", r"\btypescript\b", r"\bjavascript\b")),
]

# A generic software title with no explicit area — resolved from the description.
_GENERIC_SOFTWARE = _rx(
    r"software", r"\bdeveloper\b", r"\bprogrammer\b", r"r&d", r"\bsw\b", r"\bswe\b",
    r"engineering (?:manager|team lead|group lead)", r"\btech(?:nical)? lead\b", r"\bdev team lead",
)

# Checked first: roles adjacent to tech ("AI Product Manager", "Solutions
# Engineer") that shouldn't land in an engineering category.
_NON_ENGINEERING = _rx(
    r"product (?:manager|owner|lead|marketing)", r"program manager", r"project manager", r"\bsales\b",
    r"account (?:executive|manager)", r"marketing", r"recruit", r"talent", r"customer (?:success|support)",
    r"support (?:specialist|representative)", r"solutions? (?:engineer|architect|consultant)", r"pre[\s-]?sales",
    r"technical writer", r"designer", r"\blegal\b", r"counsel", r"\bfinance\b", r"accountant", r"payroll",
    r"\bhr\b", r"people partner", r"business (?:development|partner)", r"partner manager",
    r"office manager", r"\bbdr\b", r"\bsdr\b", r"procurement", r"buyer", r"administrative",
)

_FRONTEND_SIGNALS = _rx(r"\breact\b", r"\bangular\b", r"\bvue\b", r"\bcss\b", r"\bhtml\b",
                        r"\bredux\b", r"\bnext\.?js\b", r"\bfront[\s-]?end\b", r"\bui\b")
_BACKEND_SIGNALS = _rx(r"\bjava\b", r"\bpython\b", r"\bgolang\b", r"\bnode\.?js\b", r"\bc#",
                       r"\.net\b", r"\bscala\b", r"\bkotlin\b", r"\bspring\b", r"\bdjango\b",
                       r"\bmicroservices?\b", r"\bkafka\b", r"\bsql\b", r"\bpostgres",
                       r"\bmongo", r"\bredis\b", r"\bback[\s-]?end\b", r"\bdistributed\b")
_EMBEDDED_SIGNALS = _rx(r"\bembedded\b", r"\bfirmware\b", r"\bkernel\b", r"\brtos\b",
                        r"\bdevice drivers?\b", r"\bbare[\s-]metal\b")

_SENIOR = _rx(r"\bsenior\b", r"\bsr\.?\b", r"\blead\b", r"\bprincipal\b", r"\bstaff\b", r"\barchitect\b",
              r"\bhead of\b", r"\bmanager\b", r"\bdirector\b", r"\bexpert\b", r"\bdistinguished\b")
_JUNIOR = _rx(r"\bjunior\b", r"\bjr\.?\b", r"\bstudent\b", r"\bintern\b", r"\binternship\b", r"\bentry\b",
              r"\bgraduate\b", r"\bnew grad", r"\bjunior-mid\b")
_MID = _rx(r"\bmid\b", r"\bmid-level\b", r"\bintermediate\b")


def classify_seniority(title: str) -> str:
    if _JUNIOR.search(title):
        return "Junior"
    if _SENIOR.search(title):
        return "Senior"
    if _MID.search(title):
        return "Mid"
    return "Unknown"


def classify_category(title: str, description: str = "") -> str | None:
    """Tech category for a job title, or None for non-tech roles (sales, HR…).

    Generic titles ("Software Engineer", "R&D Team Lead") are resolved from
    how strongly the description leans frontend vs. backend vs. embedded.
    """
    if _NON_ENGINEERING.search(title):
        return None
    for category, pattern in _TITLE_RULES:
        if pattern.search(title):
            return category
    if not _GENERIC_SOFTWARE.search(title):
        return None

    desc = description or ""
    fe = len(_FRONTEND_SIGNALS.findall(desc))
    be = len(_BACKEND_SIGNALS.findall(desc))
    emb = len(_EMBEDDED_SIGNALS.findall(desc))
    if emb >= 2 and emb >= be:
        return "Embedded"
    if fe >= 2 and be >= 2 and min(fe, be) * 2 >= max(fe, be):
        return "Full Stack"
    if fe > be and fe >= 2:
        return "Frontend"
    return "Backend"


def classify_job_title(title: str, description: str = "") -> tuple[str | None, str]:
    return classify_category(title, description), classify_seniority(title)


def is_potential_tech_title(title: str) -> bool:
    """Cheap pre-filter so per-job detail calls (Workday, SmartRecruiters)
    are only made for titles that could classify into a tech category."""
    return any(p.search(title) for _, p in _TITLE_RULES) or bool(_GENERIC_SOFTWARE.search(title))


# ---------------------------------------------------------------------------
# HTML → text (keeps line breaks — downstream matcher splits on them)
# ---------------------------------------------------------------------------

_BLOCK_TAGS = {"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section"}


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")
        if tag == "li":
            self.parts.append("• ")

    def handle_endtag(self, tag):
        if tag in _BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        self.parts.append(data)


def html_to_text(raw: str | None) -> str:
    if not raw:
        return ""
    # Greenhouse returns its content entity-encoded ("&lt;div&gt;…").
    if re.search(r"&lt;\w", raw):
        raw = html.unescape(raw)
    parser = _TextExtractor()
    parser.feed(raw)
    text = "".join(parser.parts).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def hash_url(url: str) -> str:
    return hashlib.md5(url.strip().encode("utf-8")).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_datetime(value) -> datetime | None:
    """ISO strings, 'YYYY-MM-DD', and epoch seconds/milliseconds → aware UTC."""
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            secs = value / 1000 if value > 1e11 else value
            return datetime.fromtimestamp(secs, tz=timezone.utc)
        dt = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, OverflowError, OSError):
        return None


def build_record(*, company: str, title: str, url: str, description: str,
                 published_at: datetime | None, external_id: str | None) -> dict | None:
    """Normalized daily_job_pool row, or None if the job isn't a tech role."""
    title = (title or "").strip()
    url = (url or "").strip()
    if not title or not url:
        return None
    category, seniority = classify_job_title(title, description)
    if category is None:
        return None
    now = _utcnow()
    return {
        "id": hash_url(url),
        "external_job_id": (str(external_id)[:255] if external_id else None),
        "title": title[:255],
        "company": (company or "Unknown")[:255],
        "category": category,
        "seniority": seniority,
        "url": url,
        "description": description or "",
        "published_at": published_at or now,
        "scraped_at": now,
    }


async def _get_json(client: httpx.AsyncClient, method: str, url: str, **kwargs):
    """One retry on 429/5xx/transport errors; raises on final failure."""
    for attempt in range(2):
        try:
            resp = await client.request(method, url, timeout=30.0, **kwargs)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                await asyncio.sleep(2)
                continue
            resp.raise_for_status()
            return resp.json()
        except httpx.TransportError:
            if attempt == 0:
                await asyncio.sleep(2)
                continue
            raise


# ---------------------------------------------------------------------------
# ATS fetchers — each returns raw normalized records (pre-classification
# filtering happens in build_record) for Israeli locations only.
# ---------------------------------------------------------------------------

async def fetch_greenhouse(client, company: str, params: dict) -> list[dict]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{params['board']}/jobs"
    data = await _get_json(client, "GET", url, params={"content": "true"})
    out = []
    for job in data.get("jobs", []):
        location = (job.get("location") or {}).get("name", "")
        offices = " ".join(o.get("name", "") + " " + (o.get("location") or "") for o in job.get("offices") or [])
        if not is_israel_location(location, offices):
            continue
        rec = build_record(
            company=company, title=job.get("title"), url=job.get("absolute_url"),
            description=html_to_text(job.get("content")),
            published_at=parse_datetime(job.get("first_published") or job.get("updated_at")),
            external_id=job.get("id"),
        )
        if rec:
            out.append(rec)
    return out


async def fetch_lever(client, company: str, params: dict) -> list[dict]:
    host = "api.eu.lever.co" if params.get("region") == "eu" else "api.lever.co"
    data = await _get_json(client, "GET", f"https://{host}/v0/postings/{params['site']}", params={"mode": "json"})
    out = []
    for p in data if isinstance(data, list) else []:
        cats = p.get("categories") or {}
        if not is_israel_location(cats.get("location"), " ".join(cats.get("allLocations") or []),
                                  "IL" if p.get("country") == "IL" else None):
            continue
        parts = [p.get("description") or ""]
        for section in p.get("lists") or []:
            parts.append(f"<h3>{section.get('text', '')}</h3>{section.get('content', '')}")
        parts.append(p.get("additional") or "")
        rec = build_record(
            company=company, title=p.get("text"), url=p.get("hostedUrl") or p.get("applyUrl"),
            description=html_to_text("\n".join(parts)),
            published_at=parse_datetime(p.get("createdAt")), external_id=p.get("id"),
        )
        if rec:
            out.append(rec)
    return out


async def fetch_ashby(client, company: str, params: dict) -> list[dict]:
    data = await _get_json(client, "GET", f"https://api.ashbyhq.com/posting-api/job-board/{params['board']}")
    out = []
    for job in data.get("jobs", []):
        if job.get("isListed") is False:
            continue
        addr = ((job.get("address") or {}).get("postalAddress") or {})
        secondary = " ".join(
            str(s.get("location", "")) + " " + str(((s.get("address") or {}).get("postalAddress") or {}).get("addressCountry", ""))
            for s in job.get("secondaryLocations") or []
        )
        if not is_israel_location(job.get("location"), addr.get("addressCountry"), addr.get("addressLocality"), secondary):
            continue
        rec = build_record(
            company=company, title=job.get("title"), url=job.get("jobUrl") or job.get("applyUrl"),
            description=job.get("descriptionPlain") or html_to_text(job.get("descriptionHtml")),
            published_at=parse_datetime(job.get("publishedAt")), external_id=job.get("id"),
        )
        if rec:
            out.append(rec)
    return out


async def fetch_smartrecruiters(client, company: str, params: dict) -> list[dict]:
    base = f"https://api.smartrecruiters.com/v1/companies/{params['company']}/postings"
    postings, offset = [], 0
    while True:
        page = await _get_json(client, "GET", base, params={"country": "il", "limit": 100, "offset": offset})
        batch = page.get("content", [])
        postings.extend(batch)
        offset += len(batch)
        if not batch or offset >= page.get("totalFound", 0):
            break

    out = []
    for p in postings:
        title = p.get("name") or ""
        if not is_potential_tech_title(title):
            continue
        try:
            detail = await _get_json(client, "GET", f"{base}/{p['id']}")
        except Exception as e:  # keep the listing even if one detail call fails
            logger.warning("[JobPool] smartrecruiters detail failed for %s/%s: %s", company, p.get("id"), e)
            detail = {}
        sections = ((detail.get("jobAd") or {}).get("sections") or {})
        desc_html = "\n".join(
            f"<h3>{s.get('title', '')}</h3>{s.get('text', '')}"
            for key in ("jobDescription", "qualifications", "additionalInformation")
            if (s := sections.get(key))
        )
        url = detail.get("postingUrl") or f"https://jobs.smartrecruiters.com/{params['company']}/{p['id']}"
        rec = build_record(
            company=company, title=title, url=url, description=html_to_text(desc_html),
            published_at=parse_datetime(p.get("releasedDate")), external_id=p.get("id"),
        )
        if rec:
            out.append(rec)
    return out


async def fetch_workday(client, company: str, params: dict) -> list[dict]:
    host, site = params["host"], params["site"]
    tenant = params.get("tenant") or host.split(".")[0]
    base = f"https://{host}/wday/cxs/{tenant}/{site}"

    # searchText narrows a global board (NVIDIA: ~2k jobs) to Israel-related
    # postings; the location check below drops ones that only *mention* Israel.
    postings, offset, total = [], 0, None
    while total is None or offset < total:
        page = await _get_json(client, "POST", f"{base}/jobs", json={
            "appliedFacets": {}, "limit": WORKDAY_PAGE_SIZE, "offset": offset, "searchText": "Israel",
        })
        batch = page.get("jobPostings") or []
        if total is None:
            total = page.get("total") or 0
        postings.extend(batch)
        offset += WORKDAY_PAGE_SIZE
        if not batch:
            break

    sem = asyncio.Semaphore(6)

    async def one(p: dict) -> dict | None:
        title, path, loc_text = p.get("title") or "", p.get("externalPath"), p.get("locationsText") or ""
        if not path or not is_potential_tech_title(title):
            return None
        # "3 Locations" gives no city — resolve from the detail call instead.
        multi = bool(re.match(r"^\d+\s+locations?$", loc_text.strip(), re.I))
        if not multi and not is_israel_location(loc_text):
            return None
        async with sem:
            try:
                info = (await _get_json(client, "GET", f"{base}{path}")).get("jobPostingInfo") or {}
            except Exception as e:
                logger.warning("[JobPool] workday detail failed for %s %s: %s", company, path, e)
                return None
        if multi and not is_israel_location(info.get("location"), " ".join(info.get("additionalLocations") or []),
                                            (info.get("country") or {}).get("descriptor")):
            return None
        return build_record(
            company=company, title=info.get("title") or title,
            url=info.get("externalUrl") or f"https://{host}/en-US/{site}{path}",
            description=html_to_text(info.get("jobDescription")),
            published_at=parse_datetime(info.get("startDate")), external_id=info.get("jobReqId") or path,
        )

    return [r for r in await asyncio.gather(*(one(p) for p in postings)) if r]


async def fetch_jsearch(client, query: str) -> list[dict]:
    data = await _get_json(
        client, "GET", "https://jsearch.p.rapidapi.com/search",
        params={"query": query, "country": "il", "date_posted": "week", "num_pages": "2"},
        headers={"X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": RAPIDAPI_HOST},
    )
    out = []
    for item in data.get("data", []):
        if not is_israel_location(item.get("job_country"), item.get("job_city")):
            continue
        rec = build_record(
            company=item.get("employer_name"), title=item.get("job_title"),
            url=item.get("job_apply_link") or item.get("job_google_link"),
            description=item.get("job_description", ""),
            published_at=parse_datetime(item.get("job_posted_at_datetime_utc")),
            external_id=item.get("job_id"),
        )
        if rec:
            out.append(rec)
    return out


FETCHERS = {
    "greenhouse": fetch_greenhouse,
    "lever": fetch_lever,
    "ashby": fetch_ashby,
    "smartrecruiters": fetch_smartrecruiters,
    "workday": fetch_workday,
}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

async def collect_jobs(companies: list[dict] | None = None) -> tuple[list[dict], dict]:
    """Fetch every source concurrently. Returns (deduped records, per-source report)."""
    companies = COMPANIES if companies is None else companies
    report: dict = {"sources": {}, "errors": {}}
    sem = asyncio.Semaphore(8)

    async with httpx.AsyncClient(headers=HTTP_HEADERS, follow_redirects=True) as client:
        async def run(label: str, coro_factory):
            async with sem:
                try:
                    records = await coro_factory()
                    report["sources"][label] = len(records)
                    return records
                except Exception as e:
                    msg = f"{type(e).__name__}: {e}"[:300]
                    report["errors"][label] = msg
                    logger.warning("[JobPool] source %s failed: %s", label, msg)
                    return []

        tasks = [
            run(f"{c['ats']}:{c['name']}", lambda c=c: FETCHERS[c["ats"]](client, c["name"], c["params"]))
            for c in companies
        ]
        if RAPIDAPI_KEY:
            tasks += [run(f"jsearch:{q}", lambda q=q: fetch_jsearch(client, q)) for q in JSEARCH_QUERIES]
        else:
            report["skipped"] = ["jsearch (RAPIDAPI_KEY not set)"]
        results = await asyncio.gather(*tasks)

    # Dedupe by id: Postgres rejects an ON CONFLICT DO UPDATE statement that
    # touches the same row twice.
    by_id: dict[str, dict] = {}
    for batch in results:
        for rec in batch:
            by_id.setdefault(rec["id"], rec)
    return list(by_id.values()), report


def _insert_for(session: AsyncSession):
    if session.bind.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    return insert


async def upsert_jobs(session: AsyncSession, records: list[dict]) -> int:
    """Insert new jobs; refresh content and scraped_at for ones already stored
    so the "still open" window in /jobs/matched-pool keeps them visible."""
    if not records:
        return 0
    insert = _insert_for(session)
    for i in range(0, len(records), UPSERT_CHUNK):
        stmt = insert(DailyJobPool).values(records[i:i + UPSERT_CHUNK])
        stmt = stmt.on_conflict_do_update(
            index_elements=["id"],
            set_={col: stmt.excluded[col] for col in
                  ("title", "company", "category", "seniority", "description", "scraped_at")},
        )
        await session.execute(stmt)
    await session.commit()
    return len(records)


async def purge_stale(session: AsyncSession) -> int:
    result = await session.execute(
        delete(DailyJobPool).where(DailyJobPool.scraped_at < _utcnow() - STALE_AFTER)
    )
    await session.commit()
    return result.rowcount or 0


async def run_daily_aggregation(session: AsyncSession) -> dict:
    started = _utcnow()
    records, report = await collect_jobs()
    report["fetched"] = len(records)
    report["upserted"] = await upsert_jobs(session, records)
    report["purged_stale"] = await purge_stale(session)
    by_cat: dict[str, int] = {}
    for r in records:
        by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
    report["by_category"] = dict(sorted(by_cat.items(), key=lambda kv: -kv[1]))
    report["duration_sec"] = round((_utcnow() - started).total_seconds(), 1)
    logger.warning(
        "[JobPool] sync done: %d jobs from %d sources (%d failed) in %ss — %s",
        report["fetched"], len(report["sources"]), len(report["errors"]),
        report["duration_sec"], report["by_category"],
    )
    return report
