"""Daily Matches' extra job sources: board discovery, deduplication, the
JobSpy and JSearch adapters, and the orchestration that stores them. No
network: JobSpy, JSearch and the ATS fetchers are all faked."""
import asyncio
import json
import math
from datetime import date, datetime, timezone

import httpx
import pytest
from sqlalchemy import func, select

import daily_matches.models  # noqa: F401  (registers dm_* tables before conftest's create_all)
from app.models.job_pool import DailyJobPool
from app.services import job_aggregator as agg
from daily_matches.models import DmSource
from daily_matches.sources import (aggregators, bigtech, careers_site, collect_extra, comeet, employers, linkedin,
                                   probe, registry)
from daily_matches.sources.dedupe import drop_copies, job_key


REAL_SEEDS = comeet.SEED_BOARDS  # before _no_live_comeet empties it
REAL_EMPLOYERS = employers.SEED_BOARDS
REAL_SITE_BOARDS, REAL_WORKDAY_BOARDS = careers_site.site_boards, careers_site.workday_boards


@pytest.fixture(autouse=True)
def _no_live_comeet(monkeypatch):
    """No test reads Comeet for real: no seed boards, and a board answers
    like a missing one unless a test fakes it (_fake_fetchers). Nor careers
    pages or Workday hosts: the probe finds none there unless a test says so."""
    monkeypatch.setattr(comeet, "SEED_BOARDS", ())
    monkeypatch.setattr(employers, "SEED_BOARDS", ())

    async def nothing(*_):
        return []
    monkeypatch.setattr(careers_site, "site_boards", nothing)
    monkeypatch.setattr(careers_site, "workday_boards", nothing)

    async def missing(client, company, params):
        raise httpx.HTTPStatusError("404", request=httpx.Request("GET", "https://x"), response=httpx.Response(404))
    monkeypatch.setitem(registry.OWN_FETCHERS, "comeet", missing)


class _Frame:
    """What JobSpy returns, as far as the adapter uses it."""

    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orient):
        assert orient == "records"
        return [dict(r) for r in self.rows]


LONG_DESCRIPTION = "Requirements:\n• Python, AWS\n" + "We build backend services for payments at scale. " * 8


def _li(job_id, title, company, direct="", description=LONG_DESCRIPTION, posted=None):
    return {"id": job_id, "site": "linkedin", "job_url": f"https://www.linkedin.com/jobs/view/{job_id}",
            "job_url_direct": direct or math.nan, "title": title, "company": company,
            "location": "Tel Aviv-Yafo, Tel Aviv District, Israel", "date_posted": posted or date.today(),
            "description": description}


class FakeScrape:
    def __init__(self, by_site=None, fail_terms=()):
        self.by_site = by_site or {}
        self.fail_terms = set(fail_terms)
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["search_term"] in self.fail_terms:
            raise RuntimeError("HTTP 429")
        return _Frame(self.by_site.get(kwargs["site_name"][0], []))


class TestBoardFromUrl:
    @pytest.mark.parametrize("url, expected", [
        ("https://job-boards.greenhouse.io/newco/jobs/123", ("greenhouse", "newco", {"board": "newco"})),
        ("https://boards.greenhouse.io/NewCo/jobs/9?gh_src=x", ("greenhouse", "newco", {"board": "newco"})),
        ("https://boards.greenhouse.io/embed/job_app?for=newco&token=9", ("greenhouse", "newco", {"board": "newco"})),
        ("https://jobs.eu.lever.co/acme/5b37-aa", ("lever", "acme", {"site": "acme", "region": "eu"})),
        ("https://jobs.lever.co/acme/5b37-aa/apply", ("lever", "acme", {"site": "acme"})),
        ("https://hibob-fa0ad69d0cb34a.careers.hibob.com/jobs/96c4f519-f64b",
         ("hibob", "hibob-fa0ad69d0cb34a.careers.hibob.com", {"host": "hibob-fa0ad69d0cb34a.careers.hibob.com"})),
        ("https://jobs.ashbyhq.com/finout/4104-c2", ("ashby", "finout", {"board": "finout"})),
        ("https://jobs.smartrecruiters.com/ServiceNow/7440-staff", ("smartrecruiters", "servicenow", {"company": "ServiceNow"})),
        ("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Tel-Aviv/Eng_R1",
         ("workday", "acme.wd5.myworkdayjobs.com/external", {"host": "acme.wd5.myworkdayjobs.com", "site": "External"})),
        ("https://www.comeet.com/jobs/papaya/B2.00B/backend-developer/9A.1F3",
         ("comeet", "papaya/b2.00b", {"slug": "papaya", "uid": "B2.00B"})),
        ("https://comeet.co/jobs/global-e/62.002?coref=", ("comeet", "global-e/62.002", {"slug": "global-e", "uid": "62.002"})),
        ("https://www.linkedin.com/jobs/view/123", None),
        ("https://www.acme.com/careers/backend?gh_jid=9", None),  # a board name is needed to read it
        ("", None),
    ])
    def test_parses(self, url, expected):
        assert registry.board_from_url(url) == expected

    def test_a_greenhouse_job_on_a_company_site_keeps_its_board(self):
        rec = {"url": "https://www.acme.com/careers/backend?gh_jid=9", "external_job_id": "9", "id": "h1"}
        registry._hosted_greenhouse_url(rec, "acme")
        assert rec == {"url": "https://job-boards.greenhouse.io/acme/jobs/9", "external_job_id": "9", "id": "h1"}
        hosted = {"url": "https://job-boards.greenhouse.io/acme/jobs/9", "external_job_id": "9"}
        registry._hosted_greenhouse_url(hosted, "other")
        assert hosted["url"] == "https://job-boards.greenhouse.io/acme/jobs/9"


class TestDedupe:
    def test_key_ignores_suffixes_locations_and_punctuation(self):
        assert job_key("Wiz Ltd.", "Senior Backend Engineer - Tel Aviv (Hybrid)") == job_key("WIZ", "Senior Backend Engineer")
        assert job_key("Wiz", "Backend Engineer") != job_key("Wiz", "Frontend Engineer")

    def test_first_copy_wins_and_updates_of_a_row_stay(self):
        known = {job_key("Acme", "Backend Engineer"): "row1"}
        recs = [{"id": "row1", "company": "Acme", "title": "Backend Engineer"},          # the same row: an update
                {"id": "li-1", "company": "Acme Ltd", "title": "Backend Engineer"},     # a copy from LinkedIn
                {"id": "li-2", "company": "Beta", "title": "Data Engineer"},
                {"id": "in-2", "company": "Beta", "title": "Data Engineer - Haifa"}]  # a copy within the batch
        kept, dropped = drop_copies(recs, known)
        assert [r["id"] for r in kept] == ["row1", "li-2"] and dropped == 2


async def _no_sleep(*_):
    return None


class TestJobSpy:
    async def test_indeed_rows_become_pool_records(self):
        scrape = FakeScrape({"indeed": [
            _li("1", "Backend Engineer", "NewCo", direct="https://job-boards.greenhouse.io/newco/jobs/123"),
            _li("2", "Account Executive", "NewCo"),  # not a tech role
            _li("3", "Data Engineer", "Beta", posted=datetime(2026, 10, 6, tzinfo=timezone.utc)),
        ]})
        records, report = await aggregators.fetch_jobspy("indeed", ["software"], scrape=scrape)
        by_title = {r["title"]: r for r in records}
        assert set(by_title) == {"Backend Engineer", "Data Engineer"} and report["jobs"] == 2
        assert by_title["Backend Engineer"]["url"] == "https://job-boards.greenhouse.io/newco/jobs/123"
        assert by_title["Data Engineer"]["url"] == "https://www.linkedin.com/jobs/view/3"
        assert by_title["Data Engineer"]["published_at"] == datetime(2026, 10, 6, tzinfo=timezone.utc)
        call = scrape.calls[0]
        assert call["location"] == "Israel" and call["hours_old"] == aggregators.HOURS_OLD
        assert call["country_indeed"] == "israel" and report["searches"] == [{"query": "software", "rows": 3}]

    async def test_a_listing_without_its_description_is_dropped(self):
        scrape = FakeScrape({"indeed": [_li("5", "Backend Engineer", "NoText", description="Backend Engineer"),
                                        _li("6", "Backend Engineer", "WithText")]})
        records, _ = await aggregators.fetch_jobspy("indeed", ["software"], scrape=scrape)
        assert [r["company"] for r in records] == ["WithText"]

    async def test_a_blocked_search_leaves_the_others(self):
        scrape = FakeScrape({"indeed": [_li("9", "Python Developer", "Gamma")]}, fail_terms={"developer"})
        pauses = []

        async def sleep(seconds):
            pauses.append(seconds)
        records, report = await aggregators.fetch_jobspy("indeed", ["developer", "software engineer"],
                                                         scrape=scrape, sleep=sleep)
        assert len(records) == 1 and "HTTP 429" in report["errors"][0]
        assert scrape.calls[1]["country_indeed"] == "israel" and pauses == [aggregators.SEARCH_PAUSE]

    async def test_without_the_package_it_is_skipped(self, monkeypatch):
        import builtins
        real_import = builtins.__import__

        def no_jobspy(name, *args, **kwargs):
            if name == "jobspy":
                raise ImportError("no jobspy")
            return real_import(name, *args, **kwargs)
        monkeypatch.setattr(builtins, "__import__", no_jobspy)
        records, report = await aggregators.fetch_jobspy("indeed", ["software"])
        assert records == [] and "not installed" in report["skipped"]


def _card(job: dict) -> str:
    return (f'<li><div class="base-card base-search-card" data-entity-urn="urn:li:jobPosting:{job["id"]}">'
            f'<a class="base-card__full-link" href="https://il.linkedin.com/jobs/view/x-{job["id"]}?position=1">'
            f'<span class="sr-only"> {job["title"]} </span></a><div class="base-search-card__info">'
            f'<h3 class="base-search-card__title"> {job["title"]} </h3>'
            f'<h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="x"> {job["company"]} </a></h4>'
            f'<div class="base-search-card__metadata"><span class="job-search-card__location"> Tel Aviv, Israel </span>'
            f'<time class="job-search-card__listdate--new" datetime="{job.get("date", "2026-10-07")}"> 1 day ago </time>'
            f'</div></div></div></li>')


def _detail(job: dict) -> str:
    apply = f'<code id="applyUrl" style="display: none"><!--"{job["apply"]}"--></code>' if job.get("apply") else ""
    return (f'<section><div class="decorated-job-posting__details"><div class="show-more-less-html__markup relative">'
            f'<p>{job.get("description", LONG_DESCRIPTION)}</p><div><ul><li>Python &amp; Kafka</li></ul></div>'
            f'</div><div class="other">not part of it</div></div>{apply}</section>')


class FakeLinkedIn:
    """LinkedIn's guest endpoints. Only the first search finds anything."""

    def __init__(self, jobs: list[dict], blocks: int = 0):
        self.jobs, self.blocks, self.searches, self.details = jobs, blocks, [], []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.blocks:
            self.blocks -= 1
            return httpx.Response(429)
        if "seeMoreJobPostings" in request.url.path:
            params = dict(request.url.params)
            self.searches.append(params)
            start = int(params["start"])
            page = self.jobs[start:start + 10] if params["keywords"] == linkedin.SEARCHES[0] else []
            return httpx.Response(200, text="".join(_card(j) for j in page))
        job_id = request.url.path.rsplit("/", 1)[-1]
        self.details.append(job_id)
        return httpx.Response(200, text=_detail(next(j for j in self.jobs if j["id"] == job_id)))

    @property
    def transport(self):
        return httpx.MockTransport(self)


def _lj(job_id, title, company, **extra):
    return {"id": job_id, "title": title, "company": company, **extra}


class TestLinkedIn:
    def test_parses_cards_and_the_description(self):
        cards = linkedin.parse_cards(_card(_lj("41", "Backend Developer", "R&amp;D Labs")))
        assert cards == [{"id": "41", "title": "Backend Developer", "company": "R&D Labs",
                          "location": "Tel Aviv, Israel", "date": "2026-10-07"}]
        text, apply = linkedin.parse_detail(_detail(_lj("41", "x", "y", apply="https://jobs.lever.co/rd/1")))
        assert "Python & Kafka" in text and "not part of it" not in text  # the nested div stays, the sibling goes
        assert apply == "https://jobs.lever.co/rd/1"

    async def test_details_only_for_new_technical_jobs(self):
        known = agg.hash_url("https://www.linkedin.com/jobs/view/2")
        fake = FakeLinkedIn([_lj("1", "Backend Developer", "Alpha", date="2026-10-06"),
                             _lj("2", "Data Engineer", "Beta"),        # in the pool already
                             _lj("3", "Account Executive", "Gamma"),   # not a tech role
                             _lj("4", "DevOps Engineer", "Delta", apply="https://job-boards.greenhouse.io/delta/jobs/9")])
        records, report = await linkedin.fetch_linkedin({known}, transport=fake.transport, sleep=_no_sleep)
        assert sorted(fake.details) == ["1", "4"]
        assert report["already_in_pool"] == 1 and report["not_tech"] == 1 and report["details_ok"] == 2
        by_title = {r["title"]: r for r in records}
        assert by_title["Backend Developer"]["url"] == "https://www.linkedin.com/jobs/view/1"
        assert by_title["Backend Developer"]["published_at"] == datetime(2026, 10, 6, tzinfo=timezone.utc)
        assert by_title["DevOps Engineer"]["url"] == "https://job-boards.greenhouse.io/delta/jobs/9"
        assert report["searches"][0] == {"query": linkedin.SEARCHES[0], "cards": 4, "capped": False}
        params = fake.searches[0]
        assert params["location"] == "Israel" and params["f_TPR"] == f"r{linkedin.HOURS * 3600}"

    async def test_pages_until_a_query_runs_dry(self):
        fake = FakeLinkedIn([_lj(str(i), f"Backend Developer {i}", "Alpha") for i in range(25)])
        _, report = await linkedin.fetch_linkedin(transport=fake.transport, sleep=_no_sleep)
        first = [p["start"] for p in fake.searches if p["keywords"] == linkedin.SEARCHES[0]]
        assert first == ["0", "10", "20"] and report["cards"] == 25

    async def test_the_searches_that_fill_their_pages_get_twice_as_many(self, monkeypatch):
        monkeypatch.setattr(linkedin, "SEARCHES", ["backend", "frontend"])  # the fake answers only the first
        monkeypatch.setattr(linkedin, "MAX_PAGES", 2)
        monkeypatch.setattr(linkedin, "WIDE_PAGES", 4)
        fake = FakeLinkedIn([_lj(str(i), f"Backend Developer {i}", "Alpha") for i in range(60)])
        _, report = await linkedin.fetch_linkedin(transport=fake.transport, sleep=_no_sleep)
        backend = [p["start"] for p in fake.searches if p["keywords"] == "backend"]
        assert backend == ["0", "10", "20", "30"]  # four pages, not two
        assert report["searches"][0] == {"query": "backend", "cards": 40, "capped": True}
        assert report["searches"][1] == {"query": "frontend", "cards": 0, "capped": False}

    async def test_a_429_is_waited_out(self):
        pauses = []

        async def sleep(seconds):
            pauses.append(seconds)
        fake = FakeLinkedIn([_lj("1", "Backend Developer", "Alpha")], blocks=2)
        records, report = await linkedin.fetch_linkedin(transport=fake.transport, sleep=sleep)
        assert pauses.count(linkedin.BLOCK_PAUSE) == 2 and len(records) == 1 and report["blocked"] is None

    async def test_persistent_blocking_keeps_what_it_has(self):
        fake = FakeLinkedIn([_lj("1", "Backend Developer", "Alpha")], blocks=10 ** 6)
        records, report = await linkedin.fetch_linkedin(transport=fake.transport, sleep=_no_sleep)
        assert records == [] and report["blocked"] == "search" and report["cooldowns"] == linkedin.MAX_COOLDOWNS

    def test_the_proxy_comes_from_its_login_and_password(self, monkeypatch):
        for k in ("DM_LINKEDIN_PROXY", "DM_LINKEDIN_PROXY_LOGIN", "DM_LINKEDIN_PROXY_PASSWORD", "DM_LINKEDIN_PROXY_HOST"):
            monkeypatch.delenv(k, raising=False)
        assert linkedin.proxy_url() is None
        monkeypatch.setenv("DM_LINKEDIN_PROXY_LOGIN", "abc123")
        assert linkedin.proxy_url() is None  # no password: no proxy
        monkeypatch.setenv("DM_LINKEDIN_PROXY_PASSWORD", " p@ss:w/rd ")
        assert linkedin.proxy_url() == "http://abc123:p%40ss%3Aw%2Frd@gw.dataimpulse.com:823"
        monkeypatch.setenv("DM_LINKEDIN_PROXY_HOST", "proxy.example:9000")
        assert linkedin.proxy_url().endswith("@proxy.example:9000")
        monkeypatch.setenv("DM_LINKEDIN_PROXY", "http://u:v@other:1")
        assert linkedin.proxy_url() == "http://u:v@other:1"
        assert linkedin._scrub("ProxyError for http://u:v@other:1") == "ProxyError for ***"

    async def test_through_the_proxy_a_refusal_is_retried_at_once(self, monkeypatch):
        monkeypatch.setenv("DM_LINKEDIN_PROXY_LOGIN", "abc123")
        monkeypatch.setenv("DM_LINKEDIN_PROXY_PASSWORD", "secret")
        pauses = []

        async def sleep(seconds):
            pauses.append(seconds)
        fake = FakeLinkedIn([_lj("1", "Backend Developer", "Alpha")], blocks=4)  # more than MAX_BLOCKS
        records, report = await linkedin.fetch_linkedin(transport=fake.transport, sleep=sleep)
        assert report["via_proxy"] and report["blocked"] is None and len(records) == 1
        assert pauses.count(linkedin.PROXY_BLOCK_PAUSE) == 4 and linkedin.BLOCK_PAUSE not in pauses
        assert report["mb"] >= 0 and report["markup_suspect"] is None

    async def test_a_page_that_no_longer_parses_is_flagged(self, monkeypatch):
        monkeypatch.setattr(linkedin, "SEARCHES", ["backend"])

        def handler(request):  # a full page, in a markup the parser doesn't know
            return httpx.Response(200, text="<li class='job-card-v2'>" + "x" * 5000 + "</li>")
        records, report = await linkedin.fetch_linkedin(transport=httpx.MockTransport(handler), sleep=_no_sleep)
        assert records == [] and report["markup_suspect"] == "search" and report["blocked"] is None

    async def test_every_field_gets_its_first_page_before_any_its_second(self, monkeypatch):
        monkeypatch.setattr(linkedin, "SEARCHES", ["backend", "frontend", "devops"])
        monkeypatch.setattr(linkedin, "WIDE_SEARCHES", ())
        monkeypatch.setattr(linkedin, "MAX_PAGES", 3)
        fake = FakeLinkedIn([_lj(str(i), f"Backend Developer {i}", "Alpha") for i in range(30)])
        await linkedin.fetch_linkedin(transport=fake.transport, sleep=_no_sleep)
        assert [(p["keywords"], p["start"]) for p in fake.searches] == [
            ("backend", "0"), ("frontend", "0"), ("devops", "0"), ("backend", "10"), ("backend", "20")]

    async def test_a_blocked_search_cools_off_and_goes_on(self, monkeypatch):
        monkeypatch.setattr(linkedin, "SEARCHES", ["backend", "frontend"])
        monkeypatch.setattr(linkedin, "WIDE_SEARCHES", ())
        fake = FakeLinkedIn([_lj(str(i), f"Backend Developer {i}", "Alpha") for i in range(15)])
        real = fake.__call__
        refused = {"left": linkedin.MAX_BLOCKS}

        def handler(request):  # LinkedIn refuses the second page until the cool-off
            if request.url.params.get("start") == "10" and refused["left"]:
                refused["left"] -= 1
                return httpx.Response(429)
            return real(request)
        pauses = []

        async def sleep(seconds):
            pauses.append(seconds)
        records, report = await linkedin.fetch_linkedin(transport=httpx.MockTransport(handler), sleep=sleep)
        assert pauses.count(linkedin.COOLDOWN) == 1 and report["cooldowns"] == 1 and report["blocked"] is None
        assert report["cards"] == 15 and len(records) == 15


class FakeApify:
    """Apify's API: the account's limits, Actor runs, their datasets."""

    def __init__(self, jobs: dict, used=1.0, cap=5.0, cycle_end="2026-11-10T00:00:00.000Z", start_status=201):
        self.jobs, self.used, self.cap, self.cycle_end, self.start_status = jobs, used, cap, cycle_end, start_status
        self.runs, self.auth = [], set()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.auth.add(request.headers.get("Authorization"))
        path = request.url.path
        if path == "/v2/users/me/limits":
            return httpx.Response(200, json={"data": {
                "monthlyUsageCycle": {"startAt": "2026-10-10T00:00:00.000Z", "endAt": self.cycle_end},
                "limits": {"maxMonthlyUsageUsd": self.cap}, "current": {"monthlyUsageUsd": self.used}}})
        if path.endswith("/runs") and request.method == "POST":
            if self.start_status >= 400:
                return httpx.Response(self.start_status, json={"error": {
                    "type": "not-enough-usage-to-run-paid-actor", "message": "monthly usage limit"}})
            body = json.loads(request.content)
            self.runs.append({"body": body, "params": dict(request.url.params)})
            n = len(self.runs)
            return httpx.Response(201, json={"data": {"id": f"r{n}", "status": "RUNNING", "defaultDatasetId": f"d{n}"}})
        if path.startswith("/v2/actor-runs/"):
            n = path.rsplit("r", 1)[-1]
            return httpx.Response(200, json={"data": {"id": f"r{n}", "status": "SUCCEEDED", "defaultDatasetId": f"d{n}"}})
        if path.startswith("/v2/datasets/"):
            run = self.runs[int(path.split("/")[3][1:]) - 1]
            skip = set(run["body"]["skipJobId"])
            items = [j for j in self.jobs.get(run["body"]["keywords"], []) if j["id"] not in skip]
            return httpx.Response(200, json=items[:run["body"]["limit"]])
        return httpx.Response(404)

    @property
    def transport(self):
        return httpx.MockTransport(self)


def _aj(job_id, title, company="Alpha", description=LONG_DESCRIPTION):
    return {"id": job_id, "title": title, "companyName": company, "description": description,
            "postedDate": "2026-10-14T08:00:00.000Z", "url": f"https://www.linkedin.com/jobs/view/{job_id}"}


TUESDAY_IL = datetime(2026, 10, 13, 3, 30, tzinfo=timezone.utc)  # 06:30 in Israel


CP_LIST = """<html><div class="position"><span><button class="iconA save-job-btn" data-id="8032809"
 data-title="Backend Engineer" data-link="x"></button></span><a href="x"> Backend Engineer </a>
 <div class="posInfo"><p><img src="l.svg" class="place"> Israel: Tel Aviv-Yafo </p></div></div>
<div class="position"><button class="iconA save-job-btn" data-id="3463631" data-title="Order Management Specialist"
 data-link="x"></button><p><img class="place"> Israel: Tel Aviv-Yafo </p></div></html>"""
CP_JOB = """<div id="pageBody"><div id="jobOrderInfo"><div class="info"><h3>Key Responsibilities</h3>
<ul><li>Build cloud security services in Python and Go.</li></ul></div><div class="info"><h3>Requirements</h3>
<ul><li>4+ years of backend development</li></ul></div></div><div id="shareSection">Share</div></div>"""


class TestCheckPoint:
    def test_the_list_and_a_jobs_description(self):
        from daily_matches.sources import checkpoint
        assert checkpoint.parse_list(CP_LIST) == [
            {"id": "8032809", "title": "Backend Engineer", "location": "Israel: Tel Aviv-Yafo"},
            {"id": "3463631", "title": "Order Management Specialist", "location": "Israel: Tel Aviv-Yafo"}]
        text = checkpoint.parse_job(CP_JOB)
        assert "Python and Go" in text and "4+ years" in text and "Share" not in text

    async def test_israels_tech_jobs_one_page_each(self, monkeypatch):
        from daily_matches.sources import checkpoint

        async def no_sleep(_):
            return None
        monkeypatch.setattr(checkpoint, "_sleep", no_sleep)
        asked = []

        def handler(request):
            asked.append(str(request.url))
            if "a=search" in str(request.url):
                return httpx.Response(200, text=CP_LIST)
            return httpx.Response(200, text=CP_JOB)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            jobs = await checkpoint.fetch_checkpoint(client, "Check Point", {"slug": "israel", "country": "Israel"})
        assert "country_s%3AIsrael" in asked[0] or "country_s:Israel" in asked[0]
        assert len(asked) == 2  # the list, then a page for the one title that may be tech
        assert [j["title"] for j in jobs] == ["Backend Engineer"] and "4+ years" in jobs[0]["description"]
        assert jobs[0]["url"].endswith("joborderid=8032809") and jobs[0]["external_job_id"] == "8032809"
        assert registry.OWN_FETCHERS["checkpoint"] is checkpoint.fetch_checkpoint


class TestHiBob:
    async def test_a_sites_israeli_tech_jobs(self):
        from daily_matches.sources import hibob
        host = "acme-1a2b.careers.hibob.com"
        seen = []

        def handler(request):
            seen.append(request.headers.get("Referer"))
            if request.headers.get("Referer") != f"https://{host}/jobs":
                return httpx.Response(401)  # what HiBob answers a request not from its page
            return httpx.Response(200, json={"filterGroups": [], "jobAdDetails": [
                {"id": "u1", "title": "Senior Backend Engineer", "country": "Israel", "site": "IL",
                 "description": "<p>We build HR software.</p>", "requirements": "<ul><li>5 years of Java</li></ul>",
                 "publishedAt": "2026-10-12T08:14:08.371793876Z"},
                {"id": "u2", "title": "Backend Engineer", "country": "United Kingdom", "site": "London"},
                {"id": "u3", "title": "Account Executive", "country": "Israel", "site": "IL"},
            ]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            jobs = await hibob.fetch_hibob(client, "Acme", {"host": host})
        assert [j["title"] for j in jobs] == ["Senior Backend Engineer"]
        assert jobs[0]["url"] == f"https://{host}/jobs/u1" and "5 years of Java" in jobs[0]["description"]
        assert jobs[0]["published_at"] == datetime(2026, 10, 12, 8, 14, 8, 371793, tzinfo=timezone.utc)
        assert registry.OWN_FETCHERS["hibob"] is hibob.fetch_hibob and "hibob" in registry.FETCHABLE


class TestLinkedInApify:
    async def test_each_job_is_paid_once_and_the_pool_is_never_paid_for_again(self, monkeypatch):
        monkeypatch.setenv("DM_APIFY_TOKEN", "tok")
        from daily_matches.sources import linkedin_apify
        q1, q2 = linkedin_apify.SEARCHES[0], linkedin_apify.SEARCHES[1]
        fake = FakeApify({q1: [_aj("1", "Backend Developer"), _aj("2", "Data Engineer"), _aj("9", "Backend Engineer")],
                          q2: [_aj("2", "Data Engineer"), _aj("3", "Account Executive")]})
        records, report = await linkedin_apify.fetch_linkedin_apify(["9"], now=TUESDAY_IL, transport=fake.transport,
                                                                    sleep=_no_sleep)
        assert fake.auth == {"Bearer tok"}  # the token travels in a header, never in a logged URL
        assert fake.runs[0]["body"]["skipJobId"] == ["9"] and fake.runs[1]["body"]["skipJobId"] == ["9", "1", "2"]
        assert fake.runs[0]["body"]["location"] == "Israel" and "datePosted" not in fake.runs[0]["body"] and fake.runs[0]["body"]["urlParam"] == [{"key": "f_TPR", "value": "r93600"}]
        assert report["cards"] == 3 and report["jobs"] == 2 and report["not_tech"] == 1 and report["short_description"] == 0
        assert sorted(r["external_job_id"] for r in records) == ["1", "2"]
        assert records[0]["url"].startswith("https://www.linkedin.com/jobs/view/")
        assert report["cost_usd"] == round(3 * linkedin_apify.PRICE_PER_1K / 1000, 3)
        # Titles the pool would drop are left out by the Actor, so they aren't paid for.
        assert {"sales", "business developer", "product manager"} <= set(fake.runs[0]["body"]["titleExclude"])
        # The hardware and algorithms search runs too, then the searches by company.
        assert len(fake.runs) == len(linkedin_apify.SEARCHES) + len(linkedin_apify.COMPANY_SEARCHES)
        assert all("companyName" not in r["body"] for r in fake.runs[:len(linkedin_apify.SEARCHES)])

    async def test_large_employers_are_searched_by_name_and_kept_to_their_jobs(self, monkeypatch):
        monkeypatch.setenv("DM_APIFY_TOKEN", "tok")
        from daily_matches.sources import linkedin_apify
        defense, names = linkedin_apify.COMPANY_SEARCHES[0]
        assert "IAI - Israel Aerospace Industries" in names and "Elbit Systems" in names
        assert any("Rafael" in n for n in names) and "התעשייה האווירית" in defense
        fake = FakeApify({defense: [_aj("71", "Embedded Software Engineer", "IAI - Israel Aerospace Industries"),
                                    _aj("72", "מהנדס/ת תוכנה", "Elbit Systems")]})
        records, report = await linkedin_apify.fetch_linkedin_apify([], now=TUESDAY_IL, transport=fake.transport,
                                                                    sleep=_no_sleep)
        run = next(r for r in fake.runs if r["body"]["keywords"] == defense)
        assert run["body"]["companyName"] == names and int(run["body"]["limit"]) <= linkedin_apify.COMPANY_RUN_MAX
        entry = next(s for s in report["searches"] if s["query"] == defense)
        assert entry["by_company"] == {"IAI - Israel Aerospace Industries": 1, "Elbit Systems": 1}
        assert {r["company"] for r in records} == {"IAI - Israel Aerospace Industries", "Elbit Systems"}

    def test_excluded_titles_are_ones_the_pool_drops_anyway(self):
        from app.services import job_aggregator as agg
        from daily_matches.sources import linkedin_apify
        # Every excluded phrase, as a title, is non-tech to the pool, except the
        # few the searches' words catch that the pool would read as tech.
        kept_by_pool = {p for p in linkedin_apify.TITLE_EXCLUDE if agg.classify_category(p) is not None}
        assert kept_by_pool <= {"interior", "landscape", "real estate", "security guard", "security officer",
                                "business developer"}
        for title in ("Senior Backend Engineer", "Hardware Engineer", "Algorithm Developer", "Data Analyst"):
            words = set(title.lower().split())
            assert not any(set(p.split()) <= words for p in linkedin_apify.TITLE_EXCLUDE), title

    async def test_the_months_credit_is_spread_over_its_working_days(self, monkeypatch):
        monkeypatch.setenv("DM_APIFY_TOKEN", "tok")
        from daily_matches.sources import linkedin_apify
        fake = FakeApify({}, used=1.0, cap=5.0, cycle_end="2026-10-27T00:00:00.000Z")
        _, report = await linkedin_apify.fetch_linkedin_apify([], now=TUESDAY_IL, transport=fake.transport,
                                                              sleep=_no_sleep)
        credit = report["credit"]
        # 13–27 October (Israel): 15 days, of which 4 are Fridays or Saturdays.
        assert credit["working_days_left"] == 11 and credit["left_usd"] == 4.0
        assert credit["today_jobs"] == int(4.0 / 11 / linkedin_apify.PRICE_PER_1K * 1000)
        cap = float(fake.runs[0]["params"]["maxTotalChargeUsd"])
        assert cap <= credit["today_usd"] * 1.2  # Apify itself stops a run that would overspend

    async def test_friday_is_skipped_and_sunday_reaches_back(self, monkeypatch):
        monkeypatch.setenv("DM_APIFY_TOKEN", "tok")
        from daily_matches.sources import linkedin_apify
        fake = FakeApify({})
        friday = datetime(2026, 10, 16, 3, 30, tzinfo=timezone.utc)
        records, report = await linkedin_apify.fetch_linkedin_apify([], now=friday, transport=fake.transport)
        assert records == [] and "weekend" in report["skipped"] and fake.runs == []
        sunday = datetime(2026, 10, 18, 3, 30, tzinfo=timezone.utc)
        await linkedin_apify.fetch_linkedin_apify([], now=sunday, transport=fake.transport, sleep=_no_sleep)
        assert fake.runs[0]["body"]["urlParam"] == [{"key": "f_TPR", "value": f"r{74 * 3600}"}]

    async def test_a_spent_credit_is_reported_and_fails_the_run(self, monkeypatch):
        monkeypatch.setenv("DM_APIFY_TOKEN", "tok")
        from daily_matches.daily_pipeline import linkedin_alert
        from daily_matches.sources import linkedin_apify
        fake = FakeApify({}, start_status=402)
        records, report = await linkedin_apify.fetch_linkedin_apify([], now=TUESDAY_IL, transport=fake.transport,
                                                                    sleep=_no_sleep)
        assert records == [] and "not-enough-usage" in report["blocked"]
        assert "billing" in linkedin_alert({"extra": {"linkedin": report}})
        _, spent = await linkedin_apify.fetch_linkedin_apify([], now=TUESDAY_IL, sleep=_no_sleep,
                                                             transport=FakeApify({}, used=5.0).transport)
        assert spent["credit"]["today_jobs"] == 0 and "spent" in linkedin_alert({"extra": {"linkedin": spent}})


class TestHebrewTitles:
    @pytest.mark.parametrize("title, category, seniority", [
        ("מפתח/ת Backend בכיר/ה", "Backend", "Senior"),
        ("מפתח/ת פולסטאק ג'וניור", "Full Stack", "Junior"),
        ("בודק/ת תוכנה - אוטומציה", "QA", "Unknown"),
        ("מהנדס/ת דאטה", "Data", "Unknown"),
        ("ראש צוות פיתוח צד שרת", "Backend", "Senior"),
        # Missed until 2026-10-15
        ("מהנדס/ת אלגוריתמים", "AI / ML", "Unknown"),
        ("מדען/ית נתונים", "AI / ML", "Unknown"),  # a Data Scientist, as the pool sorts it
        ("אנליסט/ית נתונים", "Data", "Unknown"),
        ("מהנדס/ת חומרה", "Hardware", "Unknown"),
        ("מהנדס/ת אימות שבבים", "Hardware", "Unknown"),
        ("מהנדס/ת קושחה", "Embedded", "Unknown"),
        ("מהנדס/ת ענן", "DevOps", "Unknown"),
        ("מהנדס/ת בדיקות", "QA", "Unknown"),
        ("תכניתן/ית", "Backend", "Unknown"),
        ("מנהל/ת פיתוח", "Backend", "Senior"),
    ])
    async def test_hebrew_titles_are_classified_and_kept_as_posted(self, title, category, seniority):
        records, _ = await aggregators.fetch_jobspy("indeed", ["x"], scrape=FakeScrape({"indeed": [_li("h1", title, "Acme")]}))
        assert len(records) == 1
        rec = records[0]
        assert (rec["category"], rec["seniority"], rec["title"]) == (category, seniority, title)

    @pytest.mark.parametrize("title", ["מנהל/ת מוצר", "נציג/ת מכירות", "רכז/ת גיוס"])
    async def test_hebrew_non_tech_titles_are_dropped(self, title):
        records, _ = await aggregators.fetch_jobspy("indeed", ["x"], scrape=FakeScrape({"indeed": [_li("h2", title, "Acme")]}))
        assert records == []


class TestJSearch:
    async def test_no_key_is_skipped(self):
        assert (await aggregators.fetch_jsearch(key=""))[1]["skipped"] == "DM_JSEARCH_KEY not set"

    async def test_today_in_israel_and_quota_accounting(self):
        seen = []

        def handler(request: httpx.Request):
            seen.append(dict(request.url.params))
            assert request.headers["X-RapidAPI-Key"] == "k"
            assert request.url.path == "/search-v2"  # /search answers 404 since JSearch v2
            return httpx.Response(200, json={"data": {"cursor": "c1", "jobs": [{
                "job_id": "j1", "job_title": "Backend Developer", "employer_name": "Delta",
                "job_apply_link": "https://jobs.lever.co/delta/abc", "job_description": LONG_DESCRIPTION,
                "job_posted_at_datetime_utc": "2026-10-07T08:00:00.000Z"}]}})
        records, report = await aggregators.fetch_jsearch(key="k", transport=httpx.MockTransport(handler))
        assert seen[0]["country"] == "il" and seen[0]["date_posted"] == "today"
        assert len(records) == 1 and records[0]["url"] == "https://jobs.lever.co/delta/abc"
        assert report["requests_charged"] == aggregators.JSEARCH_PAGES * len(aggregators.JSEARCH_QUERIES)
        assert "page" not in seen[0] and seen[0]["num_pages"] == str(aggregators.JSEARCH_PAGES)

    async def test_quota_exhausted_stops_asking(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(429, json={"message": "quota"})
        _, report = await aggregators.fetch_jsearch(key="k", transport=httpx.MockTransport(handler))
        assert len(calls) == 1 and "429" in report["errors"][0]


def _fake_fetchers(monkeypatch, boards: dict):
    """boards: {(ats, slug): [titles]}; anything else answers like a missing board."""
    calls = []

    def make(ats):
        async def fetch(client, company, params):
            slug = params.get("board") or params.get("site") or params.get("slug")
            calls.append((ats, slug))
            if (ats, slug) not in boards:
                raise httpx.HTTPStatusError("404", request=httpx.Request("GET", "https://x"),
                                            response=httpx.Response(404))
            return [agg.build_record(company=company, title=t, url=f"https://{ats}.example/{slug}/{i}",
                                     description=LONG_DESCRIPTION, published_at=datetime.now(timezone.utc),
                                     external_id=str(i)) for i, t in enumerate(boards[(ats, slug)])]
        return fetch
    for ats in ("greenhouse", "lever", "ashby", "workday"):
        monkeypatch.setitem(agg.FETCHERS, ats, make(ats))
    monkeypatch.setitem(registry.OWN_FETCHERS, "comeet", make("comeet"))
    return calls


def _rec(company, title):
    return agg.build_record(company=company, title=title, url=f"https://www.linkedin.com/jobs/view/{company}-{title}",
                            description=LONG_DESCRIPTION, published_at=None, external_id=None)


class TestProbe:
    def test_board_names_from_a_company_name(self):
        assert probe.slug_candidates("Acme Labs Ltd.") == ["acme", "acmelabsltd"]
        assert probe.slug_candidates("Check Point") == ["checkpoint", "check-point"]
        assert probe.slug_candidates("חברה בע\"מ") == []

    async def test_a_board_is_trusted_only_when_it_lists_the_same_job(self, db, monkeypatch):
        calls = _fake_fetchers(monkeypatch, {
            ("greenhouse", "newco"): ["Backend Engineer", "Data Engineer"],
            ("lever", "acme"): ["Senior Accountant", "Chip Designer"],  # someone else's "acme"
        })
        rows, records, report = await probe.probe_companies(db, [_rec("NewCo", "Backend Engineer"),
                                                                 _rec("Acme", "Backend Developer")])
        await db.commit()
        assert [(r.ats, r.slug) for r in rows] == [("greenhouse", "newco")]
        assert {r["title"] for r in records} == {"Backend Engineer", "Data Engineer"}  # the whole board
        assert report == {"companies": 2, "verified": 1, "missed": 1, "skipped_known": 0,
                          "found_by": {"name": 1, "careers_page": 0, "workday": 0}}
        stored = {(s.ats, s.slug) for s in (await db.execute(select(DmSource))).scalars()}
        assert ("probe_miss", "acme") in stored and ("lever", "acme") not in stored
        assert ("lever", "acme") in calls  # it was found, and rejected

    async def test_known_companies_and_recent_misses_are_not_probed(self, db, monkeypatch):
        calls = _fake_fetchers(monkeypatch, {})
        await probe.probe_companies(db, [_rec("Gamma", "Backend Developer"), _rec("Wiz", "Backend Engineer")])
        await db.commit()
        assert {slug for _, slug in calls} == {"gamma"}  # Wiz is on V1's list
        calls.clear()
        _, _, report = await probe.probe_companies(db, [_rec("Gamma", "Backend Developer")])
        assert calls == [] and report["skipped_known"] == 1
        miss = (await db.execute(select(DmSource).where(DmSource.ats == "probe_miss"))).scalar_one()
        miss.first_seen_at = datetime.now(timezone.utc) - probe.PROBE_RETRY_AFTER * 2
        await db.commit()
        await probe.probe_companies(db, [_rec("Gamma", "Backend Developer")])
        await db.commit()
        assert calls and (await db.execute(select(func.count()).select_from(DmSource))).scalar() == 1  # replaced

    async def test_a_miss_from_the_older_probe_is_tried_again(self, db, monkeypatch):
        calls = _fake_fetchers(monkeypatch, {})
        db.add(DmSource(ats="probe_miss", slug="gamma", company="Gamma", params={}, found_via="probe",
                        first_seen_at=datetime.now(timezone.utc), failures=0))
        await db.commit()
        _, _, report = await probe.probe_companies(db, [_rec("Gamma", "Backend Developer")])
        await db.commit()
        assert report["companies"] == 1 and calls
        miss = (await db.execute(select(DmSource).where(DmSource.ats == "probe_miss"))).scalar_one()
        assert miss.params == {"v": probe.PROBE_VERSION}

    async def test_boards_a_name_does_not_spell_are_verified_the_same_way(self, db, monkeypatch):
        _fake_fetchers(monkeypatch, {
            ("comeet", "papaya"): ["Backend Engineer"],
            ("workday", "External"): ["Data Engineer"],
            ("workday", "Careers"): ["Chip Designer"],  # someone else's "gammaco" tenant
        })
        seen_sites = {}

        async def site_boards(client, sem, site, names):
            seen_sites[names[0]] = site
            if names[0] == "papaya":
                return [("comeet", "papaya/b2.00b", {"slug": "papaya", "uid": "B2.00B"})]
            return []

        async def workday_boards(client, sem, names):
            host = f"{names[0]}.wd5.myworkdayjobs.com"
            return [("workday", f"{host}/{s}".lower(), {"host": host, "site": s})
                    for s in {"intelligo": ["External"], "gammaco": ["Careers"]}.get(names[0], [])]
        monkeypatch.setattr(careers_site, "site_boards", site_boards)
        monkeypatch.setattr(careers_site, "workday_boards", workday_boards)
        papaya = {**_rec("Papaya", "Backend Engineer"), "_site": "https://papaya.example"}
        rows, records, report = await probe.probe_companies(db, [papaya, _rec("Intelligo", "Data Engineer"),
                                                                 _rec("GammaCo", "Backend Developer")])
        await db.commit()
        assert seen_sites["papaya"] == "https://papaya.example"  # the listing's own website
        assert sorted((r.ats, r.slug) for r in rows) == [
            ("comeet", "papaya/b2.00b"), ("workday", "intelligo.wd5.myworkdayjobs.com/external")]
        assert report["found_by"] == {"name": 0, "careers_page": 1, "workday": 1} and report["missed"] == 1
        assert {r["title"] for r in records} == {"Backend Engineer", "Data Engineer"}


class TestCareersSite:
    def test_workday_sites_from_robots(self):
        assert careers_site.workday_sites(
            "Sitemap: https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/siteMap.xml\n\nUser-agent: *\n"
            "Allow: /NVIDIAExternalCareerSite/\nDisallow: /NVIDIAExternalCareerSiteResearch/\n"
            "Disallow: /refreshFacet/\n") == ["NVIDIAExternalCareerSite", "NVIDIAExternalCareerSiteResearch"]
        # Palo Alto's main board is a Disallowed one; its hidden gateway isn't a board.
        assert careers_site.workday_sites("User-agent: *\nDisallow: /panwexternalcareers/\n"
                                          "Disallow: /hidden-private-pawn-temp-gateway-147258369/\n"
                                          "Disallow: /refreshFacet/\n") == ["panwexternalcareers"]

    async def test_a_workday_tenant_is_found_in_its_data_center(self):
        asked = []

        def handler(request):
            asked.append(request.url.host)
            if request.url.host == "intel.wd1.myworkdayjobs.com":
                return httpx.Response(200, text="Sitemap: https://intel.wd1.myworkdayjobs.com/External/siteMap.xml\n"
                                                "User-agent: *\nAllow: /External/\nDisallow: /refreshFacet/")
            return httpx.Response(422, json={"errorCode": "HTTP_422"})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            found = await REAL_WORKDAY_BOARDS(client, asyncio.Semaphore(2), ["intel", "intel-corp", "nosuch"])
        assert found == [("workday", "intel.wd1.myworkdayjobs.com/external",
                          {"host": "intel.wd1.myworkdayjobs.com", "site": "External"})]
        assert "intel.wd3.myworkdayjobs.com" not in asked  # found in wd1, no more asking
        assert not any(h.startswith("intel-corp.") for h in asked)  # not a tenant name
        assert sum(h.startswith("nosuch.") for h in asked) == len(careers_site.WORKDAY_DCS)

    def test_boards_a_careers_page_links_to(self):
        html = ('<a href="https://www.comeet.com/jobs/cyera/17.008/careers/8B.37F">x</a>'
                '<iframe src="https://boards.greenhouse.io/embed/job_board?for=deltaai"></iframe>'
                '<script>var u = "https:\\/\\/jobs.lever.co\\/acme\\/123";</script>'
                '<a href="https://www.comeet.com/jobs/cyera/17.008/careers/AA.371">y</a>')
        assert [b[:2] for b in careers_site.boards_in_html(html)] == [
            ("comeet", "cyera/17.008"), ("greenhouse", "deltaai"), ("lever", "acme")]

    def test_a_company_uid_is_tried_before_its_positions_uids(self):
        # 4M Analytics' page: its uid in a config object, after dozens of positions' uids.
        page = "comeet " + " ".join(f'"{i:02d}.{i:03d}"' for i in range(10, 40)) + (
            " apiConfig: { name: '4Manalytics', uid: 'B6.00F', token: '6BF287AD7E1AFCD7E2F39D7E287A21BB1AFC' }")
        token, uids = careers_site.comeet_widget(page)
        assert token == "6BF287AD7E1AFCD7E2F39D7E287A21BB1AFC" and uids[0] == "B6.00F"

    async def test_comeet_widget_leads_to_its_board(self):
        html = ('<div class="comeet-outer-wrapper"></div><script>COMEET.init({\\"token\\":\\"9103660519012202D5\\",'
                '\\"company-uid\\":\\"19.000\\", \\"positions\\": [\\"73.407\\"]});</script>')
        token, uids = careers_site.comeet_widget(html)
        assert token == "9103660519012202D5" and uids[:2] == ["19.000", "73.407"]
        assert careers_site.comeet_widget("<p>token: 9103660519012202D5</p>") == (None, [])  # not Comeet's
        # The WordPress plugin names the company's uid, after a page of its positions' uids.
        plugin = ' '.join(f'"{i:02d}.123"' for i in range(20)) + (
            '<script id="comeet_script-js-extra">var comeetvar = {"comeet_token":"94440DC0944094401BCC12882510",'
            '"comeet_uid":"49.004"};</script>')
        assert careers_site.comeet_widget(plugin)[1][0] == "49.004"

        def handler(request):
            if request.url.path.endswith("/company/19.000/positions") and request.url.params["token"] == token:
                return httpx.Response(200, json=[{"uid": "73.407", "url_comeet_hosted_page":
                                                  "https://www.comeet.com/jobs/zenity/19.000/backend/73.407"}])
            if "/careers-api/" in request.url.path:
                return httpx.Response(400, json={"message": "Account uid or token are not valid"})
            return httpx.Response(200, text=html) if request.url.path == "/careers" else httpx.Response(404)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            found = await REAL_SITE_BOARDS(client, asyncio.Semaphore(2), "https://www.zenity.io/about", ["zenity"])
        assert found == [("comeet", "zenity/19.000", {"slug": "zenity", "uid": "19.000"})]

    def test_which_pages_are_read(self):
        assert careers_site.careers_pages("http://Papaya.example/en", ["papaya"]) == [
            "https://papaya.example/careers", "https://papaya.example"]
        assert careers_site.careers_pages(None, ["check-point", "checkpoint"]) == [
            f"https://www.checkpoint.{tld}/careers" for tld in careers_site.GUESSED_TLDS]
        assert careers_site.careers_pages("", ["חברה"]) == []


COMEET_PAGE = """<html><script>
COMPANY_DATA = {"name": "Upwind Security", "company_uid": "49.004", "token": "94440DC0944094401BCC12882510", "slug": "upwind"};
COMPANY_POSITIONS_DATA = [];
</script></html>"""


def _position(uid, name, country="IL", city="Tel Aviv"):
    return {"uid": uid, "name": name, "time_updated": "2026-10-12T06:45:26Z",
            "location": {"name": city, "country": country, "city": city},
            "url_comeet_hosted_page": f"https://www.comeet.com/jobs/upwind/49.004/x/{uid}",
            "details": [{"name": "Description", "value": "<p>We build cloud security with Python and Go.</p>"},
                        {"name": "Requirements", "value": "<ul><li>3+ years of backend development</li></ul>"}]}


class TestComeet:
    def _transport(self, positions, seen, page=COMEET_PAGE):
        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            if request.url.host == "www.comeet.com":
                return httpx.Response(200, text=page)
            assert request.url.params["token"] == "94440DC0944094401BCC12882510"
            assert request.url.params["details"] == "true"
            return httpx.Response(200, json=positions)
        return httpx.MockTransport(handler)

    async def test_a_board_is_read_with_the_token_its_page_carries(self):
        seen = []
        positions = [_position("5C.375", "Backend Engineer"), _position("B0.D6A", "Backend Engineer", "BE", "Benelux"),
                     _position("11.111", "Account Executive")]
        async with httpx.AsyncClient(transport=self._transport(positions, seen)) as client:
            recs = await comeet.fetch_comeet(client, "upwind", {"slug": "upwind", "uid": "49.004"})
        assert seen[0] == "https://www.comeet.com/jobs/upwind/49.004" and "/company/49.004/positions" in seen[1]
        assert [r["title"] for r in recs] == ["Backend Engineer"]  # Israel only, tech only
        rec = recs[0]
        assert rec["company"] == "Upwind Security" and rec["url"].endswith("/5C.375") and rec["external_job_id"] == "5C.375"
        assert "Description" in rec["description"] and "3+ years of backend development" in rec["description"]
        assert rec["published_at"].isoformat().startswith("2026-10-12T06:45")

    async def test_a_page_without_a_token_is_a_failed_board(self):
        async with httpx.AsyncClient(transport=self._transport([], [], page="<html>no data</html>")) as client:
            with pytest.raises(ValueError):
                await comeet.fetch_comeet(client, "x", {"slug": "x", "uid": "1A.001"})

    async def test_the_verified_boards_seed_the_registry_once(self, db):
        seeds = (("vastdata", "43.001", "VAST Data"), ("cognyte", "F2.009", "Cognyte"))
        assert await registry.seed_boards(db, seeds) == 2
        await db.commit()
        assert await registry.seed_boards(db, seeds) == 0  # already there
        rows = (await db.execute(select(DmSource))).scalars().all()
        assert {(r.ats, r.slug, r.found_via) for r in rows} == {("comeet", "vastdata/43.001", "seed"),
                                                                 ("comeet", "cognyte/f2.009", "seed")}

    async def test_one_company_under_two_slugs_is_read_once(self, db):
        await registry.seed_boards(db, (("cognyte", "F2.009", "Cognyte"),))
        await db.commit()
        added = await registry.record_boards(db, [{"url": "https://www.comeet.com/jobs/verint/F2.009/x/1A.111",
                                                   "company": "Verint"}], "linkedin")
        assert added == []

    def test_the_seed_list_is_clean(self):
        uids = [uid.lower() for _, uid, _ in REAL_SEEDS]
        assert len(REAL_SEEDS) >= 40 and len(uids) == len(set(uids))
        assert all(registry.board_from_url(f"https://www.comeet.com/jobs/{slug}/{uid}") for slug, uid, _ in REAL_SEEDS)


class TestEmployers:
    async def test_the_mapped_employers_seed_the_registry_once(self, db):
        seeds = (("workday", {"host": "paloaltonetworks.wd5.myworkdayjobs.com", "site": "panwexternalcareers"}, "PANW"),
                 ("greenhouse", {"board": "aidocmedical"}, "Aidoc"),
                 ("lever", {"site": "mobileye", "region": "eu"}, "Mobileye"))  # already in V1's list
        assert await registry.seed_employers(db, seeds) == 2
        await db.commit()
        assert await registry.seed_employers(db, seeds) == 0
        slugs = {r.slug for r in (await db.execute(select(DmSource))).scalars()}
        assert slugs == {"paloaltonetworks.wd5.myworkdayjobs.com/panwexternalcareers", "aidocmedical"}

    def test_the_list_is_readable_and_new(self):
        known = {(c["ats"], registry._slug_of(c["ats"], c["params"])) for c in registry.COMPANIES}
        keys = [(ats, registry._slug_of(ats, params)) for ats, params, _ in REAL_EMPLOYERS]
        assert len(keys) == len(set(keys)) and not set(keys) & known
        assert all(ats in registry.FETCHABLE for ats, _ in keys)


class TestBigTech:
    async def test_amazon_pages_through_israel_and_keeps_tech_with_its_qualifications(self, monkeypatch):
        monkeypatch.setattr(bigtech, "AMAZON_PAGE", 2)
        jobs = [{"country_code": "ISR", "title": "Software Development Engineer", "job_path": "/en/jobs/1/sde",
                 "company_name": "Amazon Development Center (Israel)", "posted_date": "October  7, 2026", "id_icims": "1",
                 "description": "Build services.", "basic_qualifications": "- 3+ years of Java<br/>",
                 "preferred_qualifications": "- AWS"},
                {"country_code": "ISR", "title": "Warehouse Associate", "job_path": "/en/jobs/2/wa", "id_icims": "2"},
                {"country_code": "USA", "title": "Software Development Engineer", "job_path": "/en/jobs/3/x", "id_icims": "3"}]
        offsets = []

        def handler(request):
            offset = int(request.url.params["offset"])
            offsets.append(offset)
            return httpx.Response(200, json={"hits": 3, "jobs": jobs[offset:offset + 2]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            recs = await bigtech.fetch_amazon(client, "Amazon", {"country": "ISR"})
        assert offsets == [0, 2] and [r["title"] for r in recs] == ["Software Development Engineer"]
        rec = recs[0]
        assert rec["url"] == "https://www.amazon.jobs/en/jobs/1/sde" and rec["company"] == "Amazon Development Center (Israel)"
        assert "3+ years of Java" in rec["description"] and rec["published_at"].date() == date(2026, 10, 7)

    async def test_microsoft_is_paced_waits_out_a_429_and_reads_details_only_for_tech(self, monkeypatch):
        waits = []

        async def sleep(seconds):
            waits.append(seconds)
        monkeypatch.setattr(bigtech, "_sleep", sleep)
        positions = [{"id": 11, "displayJobId": "200", "name": "Software Engineer II", "postedTs": 1791700000,
                      "standardizedLocations": ["Herzliya, Tel Aviv District, IL"]},
                     {"id": 12, "name": "Account Executive", "standardizedLocations": ["Tel Aviv-Yafo, Tel Aviv District, IL"]},
                     {"id": 13, "name": "Software Engineer", "standardizedLocations": ["Redmond, WA, US"]}]
        calls = {"search": 0, "details": []}

        def handler(request):
            if request.url.path.endswith("/search"):
                calls["search"] += 1
                if calls["search"] == 1:
                    return httpx.Response(429)
                return httpx.Response(200, json={"data": {"positions": positions, "count": 3}})
            calls["details"].append(request.url.params["position_id"])
            return httpx.Response(200, json={"data": {"jobDescription": "<p>Build Fabric in C#.</p>",
                                                      "publicUrl": "https://apply.careers.microsoft.com/careers/job/11"}})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            recs = await bigtech.fetch_microsoft(client, "Microsoft", {"location": "Israel"})
        assert [r["title"] for r in recs] == ["Software Engineer II"] and calls["details"] == ["11"]
        assert recs[0]["url"].endswith("/careers/job/11") and "Fabric" in recs[0]["description"]
        assert bigtech.MS_RATE_WAIT_S in waits and waits.count(bigtech.MS_PAUSE_S) == 3  # 2 searches + 1 details

    def test_they_are_registry_boards(self):
        assert {"amazon", "microsoft"} <= set(registry.FETCHABLE) <= set(registry.OWN_FETCHERS) | set(agg.FETCHERS)
        assert {ats for ats, _, _ in REAL_EMPLOYERS} >= {"amazon", "microsoft"}


class TestCollectExtra:
    async def test_with_an_apify_token_linkedin_comes_through_apify(self, db, monkeypatch):
        from daily_matches import config
        from daily_matches.sources import linkedin_apify
        _fake_fetchers(monkeypatch, {})
        monkeypatch.setenv("DM_JSEARCH_KEY", "")
        monkeypatch.setenv("DM_APIFY_TOKEN", "tok")
        monkeypatch.setattr(config, "utcnow", lambda: TUESDAY_IL)
        now = datetime.now(timezone.utc)
        db.add(DailyJobPool(id="li-old", external_job_id="555", title="Backend Developer", company="Beta",
                            category="Backend", seniority="Unknown", url="https://www.linkedin.com/jobs/view/555",
                            description="x", published_at=now, scraped_at=TUESDAY_IL))
        await db.commit()
        apify = FakeApify({linkedin_apify.SEARCHES[0]: [_aj("556", "Backend Developer", "Gamma")]})
        report = await collect_extra(db, scrape=FakeScrape(), apify_transport=apify.transport, sleep=_no_sleep)
        assert report["linkedin"]["via_apify"] and report["linkedin"]["jobs"] == 1
        assert apify.runs[0]["body"]["skipJobId"] == ["555"]  # what the pool holds isn't paid for again
        assert report["new_by_source"] == {"linkedin": 1}
        # Paid for once, never again: a non-tech job the pool dropped is skipped the next time too.
        again = FakeApify({linkedin_apify.SEARCHES[0]: [_aj("557", "Account Executive", "Gamma")]})
        await collect_extra(db, scrape=FakeScrape(), apify_transport=again.transport, sleep=_no_sleep)
        third = FakeApify({})
        await collect_extra(db, scrape=FakeScrape(), apify_transport=third.transport, sleep=_no_sleep)
        assert {"555", "556", "557"} <= set(third.runs[0]["body"]["skipJobId"])

    async def test_a_verified_board_replaces_the_linkedin_copy(self, db, monkeypatch):
        _fake_fetchers(monkeypatch, {("ashby", "deltaai"): ["ML Engineer"]})
        monkeypatch.setenv("DM_JSEARCH_KEY", "")
        fake = FakeLinkedIn([_lj("7", "ML Engineer", "Delta AI")])
        report = await collect_extra(db, scrape=FakeScrape(), linkedin_transport=fake.transport, sleep=_no_sleep)
        urls = [r.url for r in (await db.execute(select(DailyJobPool))).scalars()]
        assert urls == ["https://ashby.example/deltaai/0"] and report["probe"]["verified"] == 1
        assert report["copies_dropped"] == 1

    async def test_end_to_end(self, db, monkeypatch):
        now = datetime.now(timezone.utc)
        db.add(DailyJobPool(id="ats-1", title="Backend Engineer", company="Acme", category="Backend",
                            seniority="Unknown", url="https://jobs.lever.co/acme/1", description="x",
                            published_at=now, scraped_at=now))
        db.add(DmSource(ats="greenhouse", slug="oldco", company="OldCo", params={"board": "oldco"},
                        found_via="linkedin", first_seen_at=now, failures=0))
        db.add(DmSource(ats="greenhouse", slug="deadco", company="DeadCo", params={"board": "deadco"},
                        found_via="linkedin", first_seen_at=now, failures=registry.MAX_FAILURES))
        await db.commit()

        fetched = []

        async def fake_greenhouse(client, company, params):
            fetched.append(params["board"])
            if params["board"] == "oldco":
                raise httpx.ConnectError("down")
            if params["board"] != "newco":  # the name probe finds no other board
                raise httpx.HTTPStatusError("404", request=httpx.Request("GET", "https://x"),
                                            response=httpx.Response(404))
            return [agg.build_record(company=company, title="Backend Engineer",
                                     url=f"https://job-boards.greenhouse.io/{params['board']}/jobs/1",
                                     description="Python", published_at=now, external_id="1")]
        _fake_fetchers(monkeypatch, {})  # lever and ashby: no boards
        monkeypatch.setitem(agg.FETCHERS, "greenhouse", fake_greenhouse)
        monkeypatch.setenv("DM_JSEARCH_KEY", "")
        fake = FakeLinkedIn([
            _lj("1", "Backend Engineer", "Acme Ltd"),  # the ATS job already in the pool
            _lj("2", "Backend Engineer", "NewCo", apply="https://job-boards.greenhouse.io/newco/jobs/1"),
            _lj("3", "Frontend Developer", "Papaya", apply="https://www.comeet.com/jobs/papaya/B2.00B/fe/9A.1F3"),
        ])

        report = await collect_extra(db, scrape=FakeScrape(), linkedin_transport=fake.transport, sleep=_no_sleep)

        assert fetched.count("oldco") == 1 and "deadco" not in fetched  # unhealthy boards are skipped
        assert report["registry"] == {"boards": 1, "ok": 0, "failed": 1, "jobs": 0}
        assert report["new_boards"]["discovered"] == {"comeet": 1, "greenhouse": 1}
        # Both are read on the day they're found: newco's board answers, papaya's (faked) doesn't.
        assert report["new_boards"]["ok"] == 1 and report["new_boards"]["failed"] == 1
        # Acme's LinkedIn copy is dropped. NewCo's links to the very page its own
        # board returned, so the two are one row, stored once.
        assert report["copies_dropped"] == 1 and report["stored"] == 2
        rows = {r.id: r for r in (await db.execute(select(DailyJobPool))).scalars()}
        urls = sorted(r.url for r in rows.values())
        assert urls == ["https://job-boards.greenhouse.io/newco/jobs/1", "https://jobs.lever.co/acme/1",
                        "https://www.comeet.com/jobs/papaya/B2.00B/fe/9A.1F3"]
        sources = {s.slug: s for s in (await db.execute(select(DmSource))).scalars()}
        assert sources["oldco"].failures == 1 and sources["newco"].last_count == 1
        assert sources["papaya/b2.00b"].ats == "comeet" and sources["papaya/b2.00b"].failures == 1
        json.dumps(report, default=str)  # the pipeline prints it
