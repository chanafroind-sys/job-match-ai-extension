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
    assert body["pool"] == {"active": 5, "embedded": 5}
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
