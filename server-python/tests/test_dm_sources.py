"""Daily Matches' extra job sources: board discovery, deduplication, the
JobSpy and JSearch adapters, and the orchestration that stores them. No
network: JobSpy, JSearch and the ATS fetchers are all faked."""
import json
import math
from datetime import date, datetime, timezone

import httpx
import pytest
from sqlalchemy import select

import daily_matches.models  # noqa: F401  (registers dm_* tables before conftest's create_all)
from app.models.job_pool import DailyJobPool
from app.services import job_aggregator as agg
from daily_matches.models import DmSource
from daily_matches.sources import aggregators, collect_extra, registry
from daily_matches.sources.dedupe import drop_copies, job_key


class _Frame:
    """What JobSpy returns, as far as the adapter uses it."""

    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orient):
        assert orient == "records"
        return [dict(r) for r in self.rows]


def _li(job_id, title, company, direct="", description="Requirements:\n• Python, AWS", posted=None):
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


class TestJobSpy:
    async def test_linkedin_rows_become_pool_records(self):
        scrape = FakeScrape({"linkedin": [
            _li("1", "Backend Engineer", "NewCo", direct="https://job-boards.greenhouse.io/newco/jobs/123"),
            _li("2", "Account Executive", "NewCo"),  # not a tech role
            _li("3", "Data Engineer", "Beta", posted=datetime(2026, 10, 6, tzinfo=timezone.utc)),
        ]})
        records, report = await aggregators.fetch_jobspy("linkedin", ["software"], scrape=scrape)
        by_title = {r["title"]: r for r in records}
        assert set(by_title) == {"Backend Engineer", "Data Engineer"} and report["jobs"] == 2
        assert by_title["Backend Engineer"]["url"] == "https://job-boards.greenhouse.io/newco/jobs/123"
        assert by_title["Data Engineer"]["url"] == "https://www.linkedin.com/jobs/view/3"
        assert by_title["Data Engineer"]["published_at"] == datetime(2026, 10, 6, tzinfo=timezone.utc)
        call = scrape.calls[0]
        assert call["location"] == "Israel" and call["hours_old"] == aggregators.HOURS_OLD and call["fetch_description"]

    async def test_a_blocked_search_leaves_the_others(self):
        scrape = FakeScrape({"indeed": [_li("9", "Python Developer", "Gamma")]}, fail_terms={"developer"})
        records, report = await aggregators.fetch_jobspy("indeed", ["developer", "software engineer"], scrape=scrape)
        assert len(records) == 1 and "HTTP 429" in report["errors"][0]
        assert scrape.calls[1]["country_indeed"] == "israel"

    async def test_without_the_package_it_is_skipped(self, monkeypatch):
        import builtins
        real_import = builtins.__import__

        def no_jobspy(name, *args, **kwargs):
            if name == "jobspy":
                raise ImportError("no jobspy")
            return real_import(name, *args, **kwargs)
        monkeypatch.setattr(builtins, "__import__", no_jobspy)
        records, report = await aggregators.fetch_jobspy("linkedin", ["software"])
        assert records == [] and "not installed" in report["skipped"]


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
            return httpx.Response(200, json={"data": [{
                "job_id": "j1", "job_title": "Backend Developer", "employer_name": "Delta",
                "job_apply_link": "https://jobs.lever.co/delta/abc", "job_description": "Python",
                "job_posted_at_datetime_utc": "2026-10-07T08:00:00.000Z"}]})
        records, report = await aggregators.fetch_jsearch(key="k", transport=httpx.MockTransport(handler))
        assert seen[0]["country"] == "il" and seen[0]["date_posted"] == "today"
        assert len(records) == 1 and records[0]["url"] == "https://jobs.lever.co/delta/abc"
        assert report["requests_charged"] == 2 * len(aggregators.JSEARCH_QUERIES)  # 10 pages count twice

    async def test_quota_exhausted_stops_asking(self):
        calls = []

        def handler(request):
            calls.append(1)
            return httpx.Response(429, json={"message": "quota"})
        _, report = await aggregators.fetch_jsearch(key="k", transport=httpx.MockTransport(handler))
        assert len(calls) == 1 and "429" in report["errors"][0]


class TestCollectExtra:
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
            return [agg.build_record(company=company, title="Backend Engineer",
                                     url=f"https://job-boards.greenhouse.io/{params['board']}/jobs/1",
                                     description="Python", published_at=now, external_id="1")]
        monkeypatch.setitem(agg.FETCHERS, "greenhouse", fake_greenhouse)
        monkeypatch.setenv("DM_JSEARCH_KEY", "")
        scrape = FakeScrape({"linkedin": [
            _li("1", "Backend Engineer", "Acme Ltd"),  # the ATS job already in the pool
            _li("2", "Backend Engineer", "NewCo", direct="https://job-boards.greenhouse.io/newco/jobs/1"),
            _li("3", "Frontend Developer", "Papaya", direct="https://www.comeet.com/jobs/papaya/B2.00B/fe/9A.1F3"),
        ]})

        report = await collect_extra(db, scrape=scrape)

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
