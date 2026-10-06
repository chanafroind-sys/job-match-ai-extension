"""Daily Matches end to end on SQLite: job embeddings, the run pipeline, the
once-a-day lock, trial settlement, and retention. Fake embedder, fake Claude."""
import json
from datetime import date, timedelta

import httpx
import pytest
from anthropic import APIStatusError
from fastapi import HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

import main as main_module
import daily_matches.models  # noqa: F401  (registers dm_* tables before conftest's create_all)
from app.models.job_pool import DailyJobPool
from daily_matches import config, cv_text, embeddings, pool_embedding, service, store
from daily_matches.entitlement import Access, resolve_access
from daily_matches.models import DmCvEmbedding, DmJobEmbedding, DmRun, DmRunResult, DmTrial
from tests.dm_helpers import BACKEND_CV, DATA_CV, FakeClaude, FakeEmbedder, seed_jobs, standard_pool

SUBSCRIBER = Access("subscription", subject="lic:test-subscriber")


@pytest.fixture
def env(engine, monkeypatch):
    monkeypatch.setenv("DAILY_MATCHES_ENABLED", "on")
    monkeypatch.setattr(service, "SESSION_FACTORY", async_sessionmaker(engine, expire_on_commit=False))
    store._mode_cache.clear()
    embedder = FakeEmbedder()
    monkeypatch.setattr(embeddings, "embed_texts", embedder)
    claude = FakeClaude()
    monkeypatch.setattr(main_module, "_ac", lambda: claude)

    async def verify(key):
        if key == "GOOD-KEY":
            return {}
        raise HTTPException(status_code=403, detail="Invalid")
    monkeypatch.setattr(main_module, "verify_gumroad_license", verify)
    return {"embedder": embedder, "claude": claude, "monkeypatch": monkeypatch}


async def _seed_and_embed(db, jobs=None):
    seed_jobs(db, jobs or standard_pool())
    await db.commit()
    return await pool_embedding.embed_pool(db)


async def _collect(cvs, access, primary=None):
    events = []
    async for chunk in service.stream_run(cvs, primary, access):
        if chunk.startswith("data: {"):
            events.append(json.loads(chunk[len("data: "):]))
    return events


def _cvs(*texts):
    labels = ["Backend", "Data", "Other"]
    return [service.CvInput(id=f"cv-{i}", label=labels[i], text=t) for i, t in enumerate(texts)]


def _status_error(status):
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return APIStatusError("x", response=httpx.Response(status, request=request, json={}), body=None)


class TestJobEmbeddings:
    async def test_only_active_jobs_and_only_once(self, db, env):
        report = await _seed_and_embed(db)
        assert report["active_jobs"] == 5 and report["embedded"] == 5  # the 5-day-old job is skipped
        again = await pool_embedding.embed_pool(db)
        assert again["to_embed"] == 0

    async def test_changed_description_reembeds_that_job(self, db, env):
        await _seed_and_embed(db)
        await db.execute(update(DailyJobPool).where(DailyJobPool.id == "be2")
                         .values(description="Requirements:\n• Go and gRPC"))
        await db.commit()
        assert (await pool_embedding.embed_pool(db))["to_embed"] == 1

    async def test_model_change_reembeds_everything(self, db, env):
        await _seed_and_embed(db)
        env["monkeypatch"].setattr(config, "EMBED_TAG", "voyage-5/1024")
        assert (await pool_embedding.embed_pool(db))["to_embed"] == 5

    async def test_documents_are_embedded_as_documents(self, db, env):
        await _seed_and_embed(db)
        assert {kind for _, kind in env["embedder"].calls} == {"document"}


class TestRun:
    async def test_subscriber_gets_a_ranked_deck(self, db, env):
        await _seed_and_embed(db)
        events = await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        kinds = [e["type"] for e in events]
        assert kinds[0] == "started" and kinds[-1] == "done"
        assert {"cv_ready", "candidates", "progress"} <= set(kinds)
        cand = next(e for e in events if e["type"] == "candidates")
        assert cand["pool"] == 5 and cand["candidates"] == 5

        run = (await db.execute(select(DmRun))).scalar_one()
        assert run.status == "done" and run.entitlement == "subscription"
        assert run.input_tokens == 5 * 1000 and run.output_tokens == 5 * 300
        cards = (await db.execute(select(DmRunResult).order_by(DmRunResult.rank))).scalars().all()
        scores = [c.match_score for c in cards]
        assert scores == sorted(scores, reverse=True)
        assert cards[0].job_id in ("be1", "be2")  # the backend CV's best matches lead
        assert "old1" not in {c.job_id for c in cards}
        snap = cards[0].job_snapshot
        assert snap["ats"] == "lever" and snap["apply_url"].endswith("/apply")
        assert cards[0].best_cv_ref == "cv-0" and cards[0].analysis["cv_scores"][0]["label"] == "Backend"

    async def test_prompts_carry_no_contact_details(self, db, env):
        await _seed_and_embed(db)
        await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        system_text = env["claude"].calls[0]["system"][0]["text"]
        assert "noa.levi@example.com" not in system_text and "123-4567" not in system_text
        assert "2020 - 2026" in system_text  # dates survive redaction

    async def test_second_run_same_day_returns_the_deck(self, db, env):
        await _seed_and_embed(db)
        await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        calls = len(env["claude"].calls)
        events = await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        assert [e["type"] for e in events] == ["already"] and events[0]["status"] == "done"
        assert len(env["claude"].calls) == calls

    async def test_running_run_is_busy_until_stale(self, db, env):
        db.add(DmRun(subject=SUBSCRIBER.subject, match_day=config.match_day(), entitlement="subscription",
                     status="running", started_at=config.utcnow()))
        await db.commit()
        outcome, _ = await service.claim_run(db, SUBSCRIBER)
        assert outcome == "busy"
        await db.execute(update(DmRun).values(started_at=config.utcnow() - timedelta(minutes=30)))
        await db.commit()
        outcome, _ = await service.claim_run(db, SUBSCRIBER)
        assert outcome == "retry"

    async def test_cv_vector_is_cached_across_days(self, db, env):
        await _seed_and_embed(db)
        await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        env["monkeypatch"].setattr(config, "match_day", lambda now=None: date.today() + timedelta(days=1))
        await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        query_calls = [n for n, kind in env["embedder"].calls if kind == "query"]
        assert query_calls == [1]  # embedded on the first click only
        assert (await db.execute(select(func.count()).select_from(DmCvEmbedding))).scalar() == 1

    async def test_two_versions_share_the_deck(self, db, env):
        await _seed_and_embed(db)
        await _collect(_cvs(BACKEND_CV, DATA_CV), SUBSCRIBER)
        cards = (await db.execute(select(DmRunResult))).scalars().all()
        assert "de1" in {c.job_id for c in cards}  # the Data CV gets its floor of slots
        assert env["claude"].calls[0]["tools"][0]["input_schema"]["properties"]["best_cv_id"]["enum"] == ["cv1", "cv2"]

    async def test_acted_jobs_stay_out_of_later_decks(self, db, env):
        await _seed_and_embed(db)
        await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        top = (await db.execute(select(DmRunResult).where(DmRunResult.rank == 1))).scalar_one()
        top.user_action = "skipped"
        await db.commit()
        env["monkeypatch"].setattr(config, "match_day", lambda now=None: date.today() + timedelta(days=1))
        await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        day2 = (await db.execute(select(DmRun).order_by(DmRun.id.desc()))).scalars().first()
        ids = {r.job_id for r in (await db.execute(
            select(DmRunResult).where(DmRunResult.run_id == day2.id))).scalars()}
        assert top.job_id not in ids

    async def test_pdf_blob_is_read_once_and_returned(self, db, env):
        await _seed_and_embed(db)

        async def fake_extract(b64):
            assert b64 == "JVBERi0xLjQK"
            return BACKEND_CV
        env["monkeypatch"].setattr(cv_text, "extract_pdf_text", fake_extract)
        events = await _collect([service.CvInput("main", "Main", "[PDF_BASE64:JVBERi0xLjQK]")], SUBSCRIBER)
        extracted = next(e for e in events if e["type"] == "cv_text")
        assert extracted["cv_id"] == "main" and "Kafka" in extracted["text"]
        assert events[-1]["type"] == "done"

    async def test_empty_pool_fails_without_using_the_day(self, db, env):
        events = await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        assert events[-1]["type"] == "error" and events[-1]["code"] == "DM_POOL_EMPTY"
        assert (await db.execute(select(DmRun.status))).scalar() == "failed"
        await _seed_and_embed(db)
        assert (await _collect(_cvs(BACKEND_CV), SUBSCRIBER))[-1]["type"] == "done"

    async def test_synced_but_not_embedded_says_preparing(self, db, env):
        seed_jobs(db, standard_pool())
        await db.commit()
        events = await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        assert events[-1]["code"] == "DM_POOL_PREPARING" and "[jma:DM_POOL_PREPARING]" in events[-1]["message"]
        assert (await db.execute(select(DmRun.status))).scalar() == "failed"  # retryable

    async def test_too_short_cv(self, db, env):
        await _seed_and_embed(db)
        events = await _collect(_cvs("Python"), SUBSCRIBER)
        assert events[-1]["code"] == "DM_NO_CV"


class TestTrialRuns:
    async def _trial(self, db, install="t" * 32, ip="1.2.3.4", cv=BACKEND_CV):
        from daily_matches.text_prep import cv_fingerprint
        return await resolve_access(db, None, install, ip, cv_fingerprint(cv))

    async def test_successful_trial_is_consumed(self, db, env):
        await _seed_and_embed(db)
        access = await self._trial(db)
        assert access.kind == "trial"
        assert (await _collect(_cvs(BACKEND_CV), access))[-1]["type"] == "done"
        trial = (await db.execute(select(DmTrial))).scalar_one()
        assert trial.status == "consumed"
        assert (await self._trial(db)).reason == "trial_used"

    async def test_failed_trial_is_released_and_retryable(self, db, env):
        await _seed_and_embed(db)
        broken = FakeClaude(fail_when=lambda text: True, error_factory=lambda: _status_error(429))
        env["monkeypatch"].setattr(main_module, "_ac", lambda: broken)
        access = await self._trial(db)
        events = await _collect(_cvs(BACKEND_CV), access)
        assert events[-1]["type"] == "error" and "[jma:AI_RATE_LIMIT]" in events[-1]["message"]
        assert (await db.execute(select(func.count()).select_from(DmTrial))).scalar() == 0
        assert (await db.execute(select(DmRun.status))).scalar() == "failed"

        env["monkeypatch"].setattr(main_module, "_ac", lambda: env["claude"])
        access = await self._trial(db)
        assert access.kind == "trial"
        assert (await _collect(_cvs(BACKEND_CV), access))[-1]["type"] == "done"


class TestServerKeyFailures:
    async def test_no_credit_does_not_suggest_a_personal_key(self, db, env):
        await _seed_and_embed(db)
        broke = FakeClaude(fail_when=lambda text: True, error_factory=lambda: _no_credit())
        env["monkeypatch"].setattr(main_module, "_ac", lambda: broke)
        events = await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        message = events[-1]["message"]
        assert events[-1]["type"] == "error" and "[jma:AI_UNAVAILABLE]" in message
        assert "Claude" not in message and "לא נספרה" in message
        assert (await db.execute(select(DmRun.status))).scalar() == "failed"  # the day isn't used up


def _no_credit():
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    body = {"type": "error", "error": {"type": "invalid_request_error",
                                       "message": "Your credit balance is too low to access the Anthropic API."}}
    return APIStatusError("Your credit balance is too low to access the Anthropic API.",
                          response=httpx.Response(400, request=request, json=body), body=body)


class TestRetention:
    async def test_purge(self, db, env):
        await _seed_and_embed(db)
        await _collect(_cvs(BACKEND_CV), SUBSCRIBER)
        await db.execute(update(DmRun).values(match_day=config.match_day() - timedelta(days=60)))
        await db.execute(update(DmCvEmbedding).values(last_used_at=config.utcnow() - timedelta(days=200)))
        db.add(DmJobEmbedding(job_id="gone", model=config.EMBED_TAG, content_hash="x", embedding=[0.0]))
        await db.commit()
        report = await pool_embedding.purge_retention(db)
        assert report["deck_cards"] > 0 and report["cv_vectors"] == 1 and report["orphan_job_vectors"] == 1
