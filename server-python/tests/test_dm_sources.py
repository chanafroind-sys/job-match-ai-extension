"""Daily Matches' extra job sources: board discovery, deduplication, the
JobSpy and JSearch adapters, and the orchestration that stores them. No
network: JobSpy, JSearch and the ATS fetchers are all faked."""
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
from daily_matches.sources import aggregators, collect_extra, linkedin, probe, registry
from daily_matches.sources.dedupe import drop_copies, job_key


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
        ("https://jobs.ashbyhq.com/finout/4104-c2", ("ashby", "finout", {"board": "finout"})),
        ("https://jobs.smartrecruiters.com/ServiceNow/7440-staff", ("smartrecruiters", "servicenow", {"company": "ServiceNow"})),
        ("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Tel-Aviv/Eng_R1",
         ("workday", "acme.wd5.myworkdayjobs.com/external", {"host": "acme.wd5.myworkdayjobs.com", "site": "External"})),
        ("https://www.comeet.com/jobs/papaya/B2.00B/backend-developer/9A.1F3",
         ("comeet", "papaya/b2.00b", {"slug": "papaya", "uid": "B2.00B"})),
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
        assert report["searches"][0] == {"query": linkedin.SEARCHES[0], "cards": 4}
        params = fake.searches[0]
        assert params["location"] == "Israel" and params["f_TPR"] == f"r{linkedin.HOURS * 3600}"

    async def test_pages_until_a_query_runs_dry(self):
        fake = FakeLinkedIn([_lj(str(i), f"Backend Developer {i}", "Alpha") for i in range(25)])
        _, report = await linkedin.fetch_linkedin(transport=fake.transport, sleep=_no_sleep)
        first = [p["start"] for p in fake.searches if p["keywords"] == linkedin.SEARCHES[0]]
        assert first == ["0", "10", "20"] and report["cards"] == 25

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
        assert records == [] and report["blocked"] == "search"


class TestHebrewTitles:
    @pytest.mark.parametrize("title, category, seniority", [
        ("מפתח/ת Backend בכיר/ה", "Backend", "Senior"),
        ("מפתח/ת פולסטאק ג'וניור", "Full Stack", "Junior"),
        ("בודק/ת תוכנה - אוטומציה", "QA", "Unknown"),
        ("מהנדס/ת דאטה", "Data", "Unknown"),
        ("ראש צוות פיתוח צד שרת", "Backend", "Senior"),
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
            slug = params.get("board") or params.get("site")
            calls.append((ats, slug))
            if (ats, slug) not in boards:
                raise httpx.HTTPStatusError("404", request=httpx.Request("GET", "https://x"),
                                            response=httpx.Response(404))
            return [agg.build_record(company=company, title=t, url=f"https://{ats}.example/{slug}/{i}",
                                     description=LONG_DESCRIPTION, published_at=datetime.now(timezone.utc),
                                     external_id=str(i)) for i, t in enumerate(boards[(ats, slug)])]
        return fetch
    for ats in ("greenhouse", "lever", "ashby"):
        monkeypatch.setitem(agg.FETCHERS, ats, make(ats))
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
        assert report == {"companies": 2, "verified": 1, "missed": 1, "skipped_known": 0}
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


class TestCollectExtra:
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
        assert report["new_boards"]["ok"] == 1  # newco read on the day it was found
        # Acme's LinkedIn copy is dropped. NewCo's links to the very page its own
        # board returned, so the two are one row, stored once.
        assert report["copies_dropped"] == 1 and report["stored"] == 2
        rows = {r.id: r for r in (await db.execute(select(DailyJobPool))).scalars()}
        urls = sorted(r.url for r in rows.values())
        assert urls == ["https://job-boards.greenhouse.io/newco/jobs/1", "https://jobs.lever.co/acme/1",
                        "https://www.comeet.com/jobs/papaya/B2.00B/fe/9A.1F3"]
        sources = {s.slug: s for s in (await db.execute(select(DmSource))).scalars()}
        assert sources["oldco"].failures == 1 and sources["newco"].last_count == 1
        assert sources["papaya/b2.00b"].ats == "comeet" and sources["papaya/b2.00b"].last_fetched_at is None
        json.dumps(report, default=str)  # the pipeline prints it
