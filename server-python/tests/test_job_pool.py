from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

import app.models.job_pool  # noqa: F401  (registers daily_job_pool before conftest's create_all)
from app.models.job_pool import DailyJobPool
from app.routes import jobs as jobs_route
from app.services import job_aggregator as agg

GREENHOUSE = {"jobs": [
    {"id": 1, "title": "Senior Backend Engineer", "absolute_url": "https://gh.example/1",
     "location": {"name": "Tel Aviv, Israel"}, "first_published": "2026-09-01T08:00:00-04:00",
     "content": "&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;"},
    {"id": 2, "title": "Backend Engineer", "absolute_url": "https://gh.example/2",
     "location": {"name": "New York, NY"}, "content": ""},                    # not Israel
    {"id": 3, "title": "Account Executive", "absolute_url": "https://gh.example/3",
     "location": {"name": "Tel Aviv"}, "content": ""},                        # not tech
]}
LEVER = [
    {"id": "a", "text": "Full-Stack Developer", "hostedUrl": "https://lever.example/a",
     "categories": {"location": "Herzliya"}, "createdAt": 1756800000000,
     "description": "<p>Build things</p>", "lists": [{"text": "Requirements", "content": "<li>React</li>"}]},
    {"id": "b", "text": "Frontend Engineer", "hostedUrl": "https://lever.example/b",
     "categories": {"location": "Chicago, IL"}},                             # Illinois, not Israel
]
WORKDAY_LIST = {"total": 2, "jobPostings": [
    {"title": "Software Engineer", "externalPath": "/job/Israel-Haifa/SE_1", "locationsText": "Israel, Haifa"},
    {"title": "Physical Design Engineer", "externalPath": "/job/x/PD_2", "locationsText": "2 Locations"},
]}
WORKDAY_DETAIL = {
    "/job/Israel-Haifa/SE_1": {"jobPostingInfo": {
        "title": "Software Engineer", "startDate": "2026-09-20", "location": "Israel, Haifa",
        "externalUrl": "https://wd.example/SE_1",
        "jobDescription": "<p>Java, Spring, Kafka microservices and SQL</p>"}},
    "/job/x/PD_2": {"jobPostingInfo": {
        "title": "Physical Design Engineer", "location": "US, Santa Clara",
        "additionalLocations": ["Israel, Yokneam"], "externalUrl": "https://wd.example/PD_2",
        "jobDescription": "<p>Place and route</p>"}},
}

COMPANIES = [
    {"name": "GH Co", "ats": "greenhouse", "params": {"board": "ghco"}},
    {"name": "Lever Co", "ats": "lever", "params": {"site": "leverco"}},
    {"name": "WD Co", "ats": "workday", "params": {"host": "wdco.wd1.myworkdayjobs.com", "site": "Ext"}},
    {"name": "Broken Co", "ats": "greenhouse", "params": {"board": "broken"}},
]


def _handler(request: httpx.Request) -> httpx.Response:
    url = str(request.url)
    if "boards/ghco" in url:
        return httpx.Response(200, json=GREENHOUSE)
    if "boards/broken" in url:
        return httpx.Response(404, json={"error": "not found"})
    if "postings/leverco" in url:
        return httpx.Response(200, json=LEVER)
    if url.endswith("/wday/cxs/wdco/Ext/jobs"):
        return httpx.Response(200, json=WORKDAY_LIST)
    for path, body in WORKDAY_DETAIL.items():
        if url.endswith(path):
            return httpx.Response(200, json=body)
    return httpx.Response(500)


@pytest.fixture
def mock_http(monkeypatch):
    real_client = httpx.AsyncClient
    monkeypatch.setattr(agg.httpx, "AsyncClient",
                        lambda *a, **kw: real_client(transport=httpx.MockTransport(_handler), **kw))
    monkeypatch.setattr(agg, "COMPANIES", COMPANIES)
    monkeypatch.setattr(agg, "RAPIDAPI_KEY", "")


@pytest.mark.parametrize("title,expected", [
    ("Senior Backend Engineer", ("Backend", "Senior")),
    ("Python Developer", ("Backend", "Unknown")),
    ("Java Developer", ("Backend", "Unknown")),
    ("Fullstack Developer", ("Full Stack", "Unknown")),
    ("Junior Frontend Developer", ("Frontend", "Junior")),
    ("DevOps Engineer", ("DevOps", "Unknown")),
    ("Physical Design Backend Engineer", ("Hardware", "Unknown")),
    ("AI QA Automation Lead", ("QA", "Senior")),
    ("Lead Security Researcher - AI Threat Intelligence", ("Security", "Senior")),
    ("Data Scientist", ("AI / ML", "Unknown")),
    ("AI Product Manager", (None, "Senior")),
    ("Solutions Engineer", (None, "Unknown")),
])
def test_classify_job_title(title, expected):
    assert agg.classify_job_title(title) == expected


def test_generic_software_title_resolved_from_description():
    assert agg.classify_category("Software Engineer", "React, TypeScript, CSS and Redux UI work") == "Frontend"
    assert agg.classify_category("Software Engineer", "Java, Spring, Kafka, SQL") == "Backend"
    assert agg.classify_category("Software Engineer",
                                 "React and Redux UI, Node.js microservices, SQL, TypeScript") == "Full Stack"


def test_israel_location_filter_ignores_illinois():
    assert agg.is_israel_location("Tel-Aviv")
    assert agg.is_israel_location("Petah Tikva, Israel")
    assert not agg.is_israel_location("Chicago, IL")


def test_normalize_category_aliases():
    assert agg.normalize_category("backend") == "Backend"
    assert agg.normalize_category("FULLSTACK") == "Full Stack"
    assert agg.normalize_category("ml") == "AI / ML"
    assert agg.normalize_category("underwater basket weaving") is None


def test_html_to_text_keeps_lines_and_decodes_entities():
    text = agg.html_to_text("&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Python&lt;/li&gt;&lt;/ul&gt;")
    assert text.splitlines() == ["Requirements", "", "• Python"]


async def test_collect_jobs_filters_and_reports_failures(mock_http):
    records, report = await agg.collect_jobs()
    by_url = {r["url"]: r for r in records}

    assert set(by_url) == {"https://gh.example/1", "https://lever.example/a",
                           "https://wd.example/SE_1", "https://wd.example/PD_2"}
    assert by_url["https://gh.example/1"]["category"] == "Backend"
    assert by_url["https://gh.example/1"]["published_at"] == datetime(2026, 9, 1, 12, tzinfo=timezone.utc)
    assert by_url["https://lever.example/a"]["category"] == "Full Stack"
    assert "Requirements" in by_url["https://lever.example/a"]["description"]
    assert by_url["https://wd.example/SE_1"]["category"] == "Backend"      # generic title → description
    assert by_url["https://wd.example/PD_2"]["category"] == "Hardware"     # Israel via additionalLocations
    assert "greenhouse:Broken Co" in report["errors"]                     # failure surfaced, not swallowed
    assert report["sources"]["greenhouse:GH Co"] == 1


async def test_sync_upserts_then_refreshes(db, mock_http):
    report = await agg.run_daily_aggregation(db)
    assert report["upserted"] == 4
    assert await db.scalar(select(func.count()).select_from(DailyJobPool)) == 4

    # Second run: no duplicates; an aged row's scraped_at is refreshed.
    row = await db.get(DailyJobPool, agg.hash_url("https://gh.example/1"))
    row.scraped_at = datetime.now(timezone.utc) - timedelta(days=3)
    await db.commit()
    await agg.run_daily_aggregation(db)
    db.expire_all()
    assert await db.scalar(select(func.count()).select_from(DailyJobPool)) == 4
    row = await db.get(DailyJobPool, agg.hash_url("https://gh.example/1"))
    assert row.scraped_at.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc) - timedelta(hours=1)


async def test_sync_purges_jobs_not_seen_for_a_week(db, mock_http):
    db.add(DailyJobPool(id="old", title="Backend Engineer", company="Gone", category="Backend",
                        seniority="Unknown", url="https://gone.example", description="",
                        published_at=datetime.now(timezone.utc) - timedelta(days=40),
                        scraped_at=datetime.now(timezone.utc) - timedelta(days=8)))
    await db.commit()
    report = await agg.run_daily_aggregation(db)
    assert report["purged_stale"] == 1
    assert await db.get(DailyJobPool, "old") is None


async def test_matched_pool_returns_old_but_still_open_jobs(db, mock_http):
    await agg.run_daily_aggregation(db)
    # published 3 weeks ago but seen by today's sync → must be returned
    jobs = await jobs_route.get_matched_jobs(category="backend", seniority=None, limit=30, session=db)
    assert {j.url for j in jobs} == {"https://gh.example/1", "https://wd.example/SE_1"}

    senior = await jobs_route.get_matched_jobs(category="Backend", seniority="senior", limit=30, session=db)
    assert {j.seniority for j in senior} <= {"Senior", "Unknown"}

    with pytest.raises(HTTPException) as exc:
        await jobs_route.get_matched_jobs(category="nope", seniority=None, limit=30, session=db)
    assert exc.value.status_code == 400
