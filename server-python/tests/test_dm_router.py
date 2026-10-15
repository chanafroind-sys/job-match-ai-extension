"""Daily Matches over HTTP: the router's contracts as the extension sees them."""
import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker

import main as main_module
import daily_matches.models  # noqa: F401  (registers dm_* tables before conftest's create_all)
from app.core.db import get_db
from app.core.deps import require_admin
from daily_matches import embeddings, pool_embedding, service, store
from daily_matches.router import router
from tests.dm_helpers import BACKEND_CV, FakeClaude, FakeEmbedder, seed_jobs, standard_pool

SUB = {"X-License-Key": "GOOD-KEY", "X-JMA-Install-Id": "i" * 32}
TRIAL = {"X-JMA-Install-Id": "t" * 32}


@pytest.fixture
async def client(engine, db, monkeypatch):
    monkeypatch.setenv("DAILY_MATCHES_ENABLED", "on")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(service, "SESSION_FACTORY", factory)
    store._mode_cache.clear()
    monkeypatch.setattr(embeddings, "embed_texts", FakeEmbedder())
    monkeypatch.setattr(main_module, "_ac", lambda: FakeClaude())

    async def verify(key):
        if key == "GOOD-KEY":
            return {}
        raise HTTPException(status_code=403, detail="Invalid")
    monkeypatch.setattr(main_module, "verify_gumroad_license", verify)

    app = FastAPI()
    app.include_router(router)

    async def _db():
        async with factory() as session:
            yield session
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[require_admin] = lambda: SimpleNamespace(id=1)

    seed_jobs(db, standard_pool())
    await db.commit()
    await pool_embedding.embed_pool(db)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


def _events(resp) -> list[dict]:
    return [json.loads(line[len("data: "):]) for line in resp.text.splitlines() if line.startswith("data: {")]


def _run_body(text=BACKEND_CV):
    return {"cvs": [{"id": "main", "label": "Backend", "text": text}], "primaryCvId": "main"}


async def test_status_when_disabled(client, monkeypatch):
    monkeypatch.setenv("DAILY_MATCHES_ENABLED", "off")
    resp = await client.get("/api/daily-matches/status", headers=SUB)
    assert resp.json() == {"enabled": False, "reason": "off"}


async def test_status_for_a_new_trial_user(client):
    body = (await client.get("/api/daily-matches/status", headers=TRIAL)).json()
    assert body["enabled"] and body["entitlement"] == "trial" and body["today"] is None
    assert body["pool"] == {"active": 5, "embedded": 5, "fresh": 5}
    assert body["next_reset_at"].endswith(("+03:00", "+02:00"))


async def test_run_then_reopen_then_act(client):
    resp = await client.post("/api/daily-matches/run", headers=SUB, json=_run_body())
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _events(resp)
    assert events[-1]["type"] == "done" and resp.text.rstrip().endswith("data: [DONE]")

    status = (await client.get("/api/daily-matches/status", headers=SUB)).json()
    assert status["today"]["status"] == "done" and status["today"]["cards"] == events[-1]["count"]

    deck = (await client.get("/api/daily-matches/today", headers=SUB)).json()
    assert len(deck["cards"]) == events[-1]["count"]
    card = deck["cards"][0]
    assert card["analysis"]["requirements"] and card["job"]["apply_url"] and card["best_cv_id"] == "main"

    saved = await client.post(f"/api/daily-matches/results/{card['id']}/action", headers=SUB,
                              json={"action": "saved"})
    assert saved.json() == {"ok": True, "user_action": "saved"}
    viewed = await client.post(f"/api/daily-matches/results/{card['id']}/action", headers=SUB,
                               json={"action": "viewed"})
    assert viewed.json()["user_action"] == "saved"  # viewing never overwrites a real action
    listed = (await client.get("/api/daily-matches/saved", headers=SUB)).json()["cards"]
    assert [c["id"] for c in listed] == [card["id"]]

    again = _events(await client.post("/api/daily-matches/run", headers=SUB, json=_run_body()))
    assert again == [{"type": "already", "run_id": events[0]["run_id"], "status": "done"}]


async def test_deck_holds_only_shown_tiers(client):
    events = _events(await client.post("/api/daily-matches/run", headers=SUB, json=_run_body()))
    deck = (await client.get("/api/daily-matches/today", headers=SUB)).json()
    assert deck["run"]["candidates"] == 5 and deck["run"]["fresh"] == 5  # five analyzed...
    assert len(deck["cards"]) == events[-1]["count"] < 5  # ...but the weak ones aren't cards
    assert {c["tier"] for c in deck["cards"]} <= {"strong", "maybe"}
    scores = [c["match_score"] for c in deck["cards"]]
    assert scores == sorted(scores, reverse=True)


async def test_focus_and_level_reach_the_pipeline(client):
    body = {"cvs": [{"id": "main", "label": "Data", "text": BACKEND_CV, "focus": ["Data"]}],
            "primaryCvId": "main", "prefs": {"level": "mid"}}
    events = _events(await client.post("/api/daily-matches/run", headers=SUB, json=body))
    assert next(e for e in events if e["type"] == "candidates")["candidates"] == 1  # only de1 is Data
    bad_level = {**body, "prefs": {"level": "wizard"}}
    assert (await client.post("/api/daily-matches/run", headers=SUB, json=bad_level)).status_code == 422


async def test_the_run_says_what_the_persons_choices_left_aside(client):
    body = {"cvs": [{"id": "main", "label": "Backend", "text": BACKEND_CV, "focus": ["Backend"]}],
            "primaryCvId": "main", "prefs": {"level": "junior"}}
    events = _events(await client.post("/api/daily-matches/run", headers=SUB, json=body))
    cand = next(e for e in events if e["type"] == "candidates")
    # Other fields, at the person's level (Frontend and Hardware are Senior here); both Backend
    # jobs are Senior too, which junior leaves out.
    assert cand["other_fields"] == {"Data": 1}
    assert cand["excluded_by_level"] == 2 and cand["candidates"] == 0


async def test_how_far_back_is_the_persons_choice_up_to_six_days(client, db):
    from datetime import datetime, timedelta, timezone
    from types import SimpleNamespace as NS

    from app.models.job_pool import DailyJobPool
    from daily_matches import service
    now = datetime.now(timezone.utc)
    window = lambda days: now - service.job_filters(NS(subject="s"), [], service.Prefs(days_back=days), now)[0].published_since  # noqa: E731
    assert window(None) == timedelta(days=3) and window(6) == timedelta(days=6) and window(9) == timedelta(days=6)
    body = {"cvs": [{"id": "main", "label": "Data", "text": BACKEND_CV, "focus": ["Data"]}], "primaryCvId": "main"}
    assert (await client.post("/api/daily-matches/run", headers=SUB,
                              json={**body, "prefs": {"days_back": 7}})).status_code == 422
    job = await db.get(DailyJobPool, "de1")
    job.published_at = now - timedelta(days=5)  # still listed, posted 5 days ago
    await db.commit()
    six = _events(await client.post("/api/daily-matches/run", headers=SUB, json={**body, "prefs": {"days_back": 6}}))
    assert next(e for e in six if e["type"] == "candidates")["candidates"] == 1


async def test_a_version_named_after_a_long_file_name_still_builds(client):
    body = {"cvs": [{"id": "main", "label": "Backend", "text": BACKEND_CV},
                    {"id": "v1", "label": "קורות חיים מעודכנים אוקטובר 2026 גרסה לתפקידי דאטה ובינה מלאכותית סופי",
                     "text": BACKEND_CV}], "primaryCvId": "main"}
    resp = await client.post("/api/daily-matches/run", headers=SUB, json=body)
    assert resp.status_code == 200 and _events(resp)[-1]["type"] == "done"


async def test_cards_belong_to_their_owner(client):
    events = _events(await client.post("/api/daily-matches/run", headers=SUB, json=_run_body()))
    deck = (await client.get("/api/daily-matches/today", headers=SUB)).json()
    other = await client.post(f"/api/daily-matches/results/{deck['cards'][0]['id']}/action",
                              headers=TRIAL, json={"action": "skipped"})
    assert events[-1]["type"] == "done" and other.status_code == 404


async def test_trial_then_paywall_but_deck_stays(client):
    first = _events(await client.post("/api/daily-matches/run", headers=TRIAL, json=_run_body()))
    assert first[-1]["type"] == "done"
    # Same day: the finished trial deck comes back instead of a paywall.
    same_day = _events(await client.post("/api/daily-matches/run", headers=TRIAL, json=_run_body()))
    assert same_day[0]["type"] == "already"
    status = (await client.get("/api/daily-matches/status", headers=TRIAL)).json()
    assert status["entitlement"] == "locked" and status["reason"] == "trial_used"
    # A reinstall with the same CV is still the same trial.
    reinstall = {"X-JMA-Install-Id": "r" * 32}
    blocked = _events(await client.post("/api/daily-matches/run", headers=reinstall, json=_run_body()))
    assert blocked[0]["type"] == "error" and blocked[0]["code"] == "LICENSE_REQUIRED"
    assert "[jma:LICENSE_REQUIRED]" in blocked[0]["message"]


async def test_locked_user_can_reopen_last_deck(client):
    await client.post("/api/daily-matches/run", headers=TRIAL, json=_run_body())
    deck = (await client.get("/api/daily-matches/today?latest=1", headers=TRIAL)).json()
    assert deck["entitlement"] == "locked" and deck["cards"]


async def test_bad_input_is_rejected_before_any_work(client):
    resp = await client.post("/api/daily-matches/run", headers=SUB,
                             json={"cvs": [{"id": "bad id!", "label": "x", "text": "x"}]})
    assert resp.status_code == 422
    six = [{"id": f"cv{i}", "label": "x", "text": BACKEND_CV} for i in range(6)]
    assert (await client.post("/api/daily-matches/run", headers=SUB, json={"cvs": six})).status_code == 422


async def test_pdf_extract_is_paywalled_for_locked_users(client):
    await client.post("/api/daily-matches/run", headers=TRIAL, json=_run_body())
    resp = await client.post("/api/daily-matches/cv/extract", headers=TRIAL, json={"pdf": "JVBERi0xLjQKJ" * 3})
    assert resp.status_code == 402 and "[jma:LICENSE_REQUIRED]" in resp.json()["detail"]


async def test_pdf_extract_rejects_non_pdf(client):
    resp = await client.post("/api/daily-matches/cv/extract", headers=SUB, json={"pdf": "aGVsbG8gd29ybGQ="})
    assert resp.status_code == 422 and "[jma:DM_CV_UNREADABLE]" in resp.json()["detail"]


async def test_admin_metrics(client):
    await client.post("/api/daily-matches/run", headers=SUB, json=_run_body())
    body = (await client.get("/api/daily-matches/admin/metrics")).json()
    assert body["days"][0]["done"] == 1 and body["avg_cost_per_run_usd"] > 0
    assert sum(b["shown"] for b in body["actions_by_band"].values()) >= 1


async def test_admins_see_the_model_comparison_over_every_analyzed_job(client, monkeypatch):
    from daily_matches import config, reasoning
    from tests.dm_openrouter import FakeOpenRouter
    fake = FakeOpenRouter()
    monkeypatch.setattr(config, "COMPARE_MODEL", "openrouter:deepseek/deepseek-v4.1-flash")
    monkeypatch.setattr(config, "OPENROUTER_KEY", "or-test-key")
    monkeypatch.setattr(reasoning, "_openrouter_transport", fake.transport())
    monkeypatch.setattr(main_module, "STATIC_ADMIN_KEYS", {"GOOD-KEY"})
    _events(await client.post("/api/daily-matches/run", headers=SUB, json=_run_body()))
    deck = (await client.get("/api/daily-matches/today", headers=SUB)).json()
    summary = deck["compare"]
    assert summary["model"] == "openrouter:deepseek/deepseek-v4.1-flash"
    assert summary["jobs"] == 5 > len(deck["cards"])  # hidden jobs count too
    assert summary["cost_other_usd"] > 0 and summary["cost_main_usd"] > 0

    monkeypatch.setattr(main_module, "STATIC_ADMIN_KEYS", set())
    assert "compare" not in (await client.get("/api/daily-matches/today", headers=SUB)).json()


async def test_the_deck_says_how_many_analyses_actually_came_back(client, monkeypatch):
    from tests.dm_helpers import FakeClaude
    fake = FakeClaude()
    real = fake.messages.create
    unlucky = []

    async def create(**kwargs):
        message = await real(**kwargs)
        job = kwargs["messages"][0]["content"]
        if not unlucky:
            unlucky.append(job)
        if job == unlucky[0]:  # one job's answer is cut off, every time it's asked
            message.stop_reason = "max_tokens"
        return message
    monkeypatch.setattr(fake.messages, "create", create)
    monkeypatch.setattr(main_module, "_ac", lambda: fake)
    events = _events(await client.post("/api/daily-matches/run", headers=SUB, json=_run_body()))
    assert events[-1]["analyzed"] == 5 and events[-1]["analyzed_ok"] == 4
    deck = (await client.get("/api/daily-matches/today", headers=SUB)).json()
    assert deck["run"]["candidates"] == 5 and deck["run"]["analyzed_ok"] == 4


async def test_the_deck_lists_the_jobs_it_left_out_and_why(client):
    events = _events(await client.post("/api/daily-matches/run", headers=SUB, json=_run_body()))
    deck = (await client.get("/api/daily-matches/today", headers=SUB)).json()
    skipped = deck["skipped"]
    assert len(skipped) + len(deck["cards"]) == events[-1]["analyzed_ok"]
    assert all(s["score"] < 60 and s["title"] and s["reason"] for s in skipped)
    assert {s["reason"]["kind"] for s in skipped} <= {"cap", "years", "requirement"}
    # The whole calculation, to see why a job came out where it did.
    assert all(s["requirements"] and isinstance(s["breakdown"], list) and s["to_confirm"] == [] for s in skipped)
    assert all(s["user_action"] is None for s in skipped)


async def test_an_admin_judges_the_two_methods_job_by_job(client, monkeypatch):
    from daily_matches import config
    monkeypatch.setattr(config, "COMPARE_METHOD", "honest")
    monkeypatch.setattr(main_module, "STATIC_ADMIN_KEYS", {"GOOD-KEY"})
    _events(await client.post("/api/daily-matches/run", headers=SUB, json=_run_body()))
    deck = (await client.get("/api/daily-matches/today", headers=SUB)).json()
    assert deck["compare"]["method"] == "honest"
    assert all(s["compare"]["method"] == "honest" for s in deck["skipped"])  # left-out jobs carry it too
    card = deck["cards"][0]
    assert card["analysis"]["compare"]["answer_he"]
    judged = await client.post(f"/api/daily-matches/results/{card['id']}/judge", headers=SUB, json={"winner": "other"})
    assert judged.json() == {"ok": True, "judged": "other"}
    again = (await client.get("/api/daily-matches/today", headers=SUB)).json()
    assert again["compare"]["judged"]["other"] == 1 and again["cards"][0]["analysis"]["compare"]["judged"] == "other"
    cleared = await client.post(f"/api/daily-matches/results/{card['id']}/judge", headers=SUB, json={"winner": "clear"})
    assert cleared.json() == {"ok": True, "judged": None}
    bad = await client.post(f"/api/daily-matches/results/{card['id']}/judge", headers=SUB, json={"winner": "me"})
    assert bad.status_code == 422

    monkeypatch.setattr(main_module, "STATIC_ADMIN_KEYS", set())
    denied = await client.post(f"/api/daily-matches/results/{card['id']}/judge", headers=SUB, json={"winner": "main"})
    assert denied.status_code == 403
    assert all("compare" not in s for s in (await client.get("/api/daily-matches/today", headers=SUB)).json()["skipped"])


async def test_a_left_out_job_marked_as_fitting_is_kept_with_the_saved(client):
    _events(await client.post("/api/daily-matches/run", headers=SUB, json=_run_body()))
    left_out = (await client.get("/api/daily-matches/today", headers=SUB)).json()["skipped"][0]
    marked = await client.post(f"/api/daily-matches/results/{left_out['id']}/action", headers=SUB,
                               json={"action": "fits"})
    assert marked.json() == {"ok": True, "user_action": "fits"}
    assert [c["id"] for c in (await client.get("/api/daily-matches/saved", headers=SUB)).json()["cards"]] == [left_out["id"]]
    again = (await client.get("/api/daily-matches/today", headers=SUB)).json()["skipped"]
    assert next(s for s in again if s["id"] == left_out["id"])["user_action"] == "fits"


async def test_the_persons_own_answers_reach_the_analysis(client, monkeypatch):
    fake = FakeClaude()
    monkeypatch.setattr(main_module, "_ac", lambda: fake)
    body = {**_run_body(), "facts": {"degree": "bachelor", "degreeField": "Computer Science", "license": "yes",
                                     "english": "native", "psychometric": "", "clearance": "",
                                     "notes": "C# in a work project; call me at 050-1234567"}}
    events = _events(await client.post("/api/daily-matches/run", headers=SUB, json=body))
    assert events[-1]["type"] == "done"
    system = fake.calls[0]["system"][0]["text"]
    answers = system.split("THE CANDIDATE'S OWN ANSWERS", 1)[1]
    assert "Driver's license: yes" in answers and "Computer Science" in answers and "C# in a work project" in answers
    assert "050-1234567" not in system  # contact details are removed, as from the CVs


async def test_answers_a_server_doesnt_know_never_fail_a_run(client, monkeypatch):
    fake = FakeClaude()
    monkeypatch.setattr(main_module, "_ac", lambda: fake)
    body = {**_run_body(), "facts": {"degree": "wizard", "license": "sometimes", "newField": "x"}}
    events = _events(await client.post("/api/daily-matches/run", headers=SUB, json=body))
    assert events[-1]["type"] == "done"
    assert fake.calls[0]["system"][0]["text"].endswith("None given.")
    too_long = {**_run_body(), "facts": {"notes": "x" * 2001}}
    assert (await client.post("/api/daily-matches/run", headers=TRIAL, json=too_long)).status_code == 422


def test_the_main_reason_is_the_binding_cap_or_the_biggest_loss():
    from daily_matches import service
    assert service.main_reason({"cap": {"name": "level_unproven", "value": 65}, "breakdown": []}) ==         {"kind": "cap", "name": "level_unproven", "value": 65}
    worst = service.main_reason({"breakdown": [
        {"kind": "requirement", "text": "Kafka", "importance": "must", "status": "partial", "points": -8},
        {"kind": "years", "required": 5, "relevant": 2, "points": -18},
        {"kind": "offsets", "names": ["relevant_projects"], "points": 3}]})
    assert worst == {"kind": "years", "required": 5, "relevant": 2, "points": -18}
    assert service.main_reason({"breakdown": []}) is None
