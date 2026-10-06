"""One Daily Matches run: claim the day, prepare CVs, Stage 1, Stage 2, store
the deck.

The pipeline runs as its own task and reports through a queue that the SSE
response drains. If the user closes the side panel mid-build, the task keeps
going and the deck is waiting when they come back. Every failure path marks
the day's run failed and releases a reserved trial, so a failed run never uses
up the day or the free trial.
"""
import asyncio
import json
import logging
from dataclasses import dataclass
from typing import AsyncIterator, Callable

from fastapi import HTTPException
from sqlalchemy import and_, delete, or_, select, update
from sqlalchemy.exc import IntegrityError

from app.core import db as core_db
from app.models.job_pool import DailyJobPool
from daily_matches import config, cv_text, embeddings, reasoning, retrieval, store
from daily_matches.entitlement import Access, DmError, consume_trial, release_trial, reserve_trial
from daily_matches.jobs_meta import apply_url_for, ats_for
from daily_matches.models import DmRun, DmRunResult
from daily_matches.text_prep import (
    card_excerpt,
    cv_fingerprint,
    is_pdf_blob,
    job_llm_text,
    normalize_cv_text,
    pdf_b64_from_blob,
    redact_contacts,
    sha256,
)

logger = logging.getLogger(__name__)

TERMINAL_EVENTS = {"done", "already", "error"}
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

# Tests point this at their own engine; production uses the app's factory.
SESSION_FACTORY = None
_running: set[asyncio.Task] = set()


def _new_session():
    return (SESSION_FACTORY or core_db.async_session_factory)()


@dataclass
class CvInput:
    id: str
    label: str
    text: str


@dataclass
class _PreparedCv:
    alias: str
    ref: str
    label: str
    text: str
    hash: str


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def error_event(code: str, message: str) -> dict:
    return {"type": "error", "code": code, "message": message}


# ── The day's claim ───────────────────────────────────────────────────────────

async def claim_run(session, access: Access) -> tuple[str, DmRun]:
    """'new' or 'retry': this call owns a running row. 'done' or 'busy': it
    doesn't. The unique (subject, match_day) row is the once-a-day lock."""
    now = config.utcnow()
    day = config.match_day(now)
    run = DmRun(subject=access.subject, match_day=day, entitlement=access.kind,
                status="running", started_at=now)
    session.add(run)
    try:
        await session.commit()
        return "new", run
    except IntegrityError:
        await session.rollback()

    existing = (await session.execute(select(DmRun).where(
        DmRun.subject == access.subject, DmRun.match_day == day))).scalar_one()
    if existing.status == "done":
        return "done", existing
    retried = await session.execute(
        update(DmRun)
        .where(DmRun.id == existing.id, or_(
            DmRun.status == "failed",
            and_(DmRun.status == "running", DmRun.started_at < now - config.RUN_STALE_AFTER),
        ))
        .values(status="running", started_at=now, finished_at=None, error=None, entitlement=access.kind)
        .execution_options(synchronize_session=False)
    )
    if retried.rowcount != 1:
        await session.rollback()
        return "busy", existing
    await session.execute(delete(DmRunResult).where(DmRunResult.run_id == existing.id))
    await session.commit()
    await session.refresh(existing)
    return "retry", existing


async def _mark_failed(session, run_id: int | None, install_hash: str | None, code: str) -> None:
    try:
        await session.rollback()
        if run_id is not None:
            await session.execute(update(DmRun).where(DmRun.id == run_id)
                                  .values(status="failed", error=code[:200], finished_at=config.utcnow())
                                  .execution_options(synchronize_session=False))
        if install_hash:
            await release_trial(session, install_hash)
        await session.commit()
    except Exception:  # noqa: BLE001 — cleanup must not mask the original error
        logger.exception("[DM] could not mark run %s failed", run_id)


# ── Ranking and cards ─────────────────────────────────────────────────────────

def rank_cards(candidates: list[retrieval.Candidate],
               analyses: dict[str, dict | None]) -> list[tuple[retrieval.Candidate, dict | None]]:
    """Analyzed jobs by score. Only jobs at or above MIN_DISPLAY_SCORE make the
    deck, unless fewer than MIN_CARDS do: then the best of the rest fill it, so
    a thin day still shows something."""
    analyzed = [(c, analyses[c.job_id]) for c in candidates if analyses.get(c.job_id)]
    analyzed.sort(key=lambda t: (-t[1]["match_score"], -t[0].sim))
    passing = [t for t in analyzed if t[1]["match_score"] >= config.MIN_DISPLAY_SCORE]
    if len(passing) >= config.MIN_CARDS:
        return passing
    rest = [t for t in analyzed if t[1]["match_score"] < config.MIN_DISPLAY_SCORE]
    unanalyzed = sorted(((c, None) for c in candidates if not analyses.get(c.job_id)), key=lambda t: -t[0].sim)
    return (passing + rest + unanalyzed)[:config.MIN_CARDS]


def job_snapshot(job: DailyJobPool) -> dict:
    ats = ats_for(job.company, job.url)
    published = config.as_utc(job.published_at)
    return {
        "title": job.title,
        "company": job.company,
        "category": job.category,
        "seniority": job.seniority,
        "url": job.url,
        "apply_url": apply_url_for(ats, job.url, job.company, job.external_job_id),
        "ats": ats,
        "published_at": published.isoformat() if published else None,
        "is_new": bool(published and published >= config.utcnow() - config.NEW_JOB_WINDOW),
        "excerpt": card_excerpt(job.description),
    }


# ── The pipeline ──────────────────────────────────────────────────────────────

async def _prepare_cvs(cvs_in: list[CvInput], emit: Callable[[dict], None]) -> list[_PreparedCv]:
    prepared: list[_PreparedCv] = []
    for cv in cvs_in[:config.MAX_CV_VERSIONS]:
        text = cv.text
        if is_pdf_blob(text):
            text = await cv_text.extract_pdf_text(pdf_b64_from_blob(text))
            emit({"type": "cv_text", "cv_id": cv.id, "text": text})  # the extension keeps it
        norm = normalize_cv_text(text)
        if len(norm) < config.MIN_CV_CHARS:
            continue
        prepared.append(_PreparedCv(alias=f"cv{len(prepared) + 1}", ref=cv.id,
                                    label=(cv.label or "").strip()[:60] or f"CV {len(prepared) + 1}",
                                    text=norm, hash=sha256(norm)))
    if not prepared:
        raise DmError("DM_NO_CV", "לא נמצאו קורות חיים עם מספיק טקסט להתאמה. העלה/י קורות חיים בהגדרות.", 422)
    return prepared


async def _pipeline(cvs_in: list[CvInput], primary_id: str | None, access: Access,
                    emit: Callable[[dict], None]) -> None:
    run_id: int | None = None
    reserved_install: str | None = None
    async with _new_session() as session:
        try:
            outcome, run = await claim_run(session, access)
            if outcome in ("done", "busy"):
                emit({"type": "already", "run_id": run.id, "status": "done" if outcome == "done" else "running"})
                return
            run_id = run.id
            emit({"type": "started", "run_id": run_id})

            if access.kind == "trial":
                primary = next((c for c in cvs_in if c.id == primary_id), cvs_in[0])
                await reserve_trial(session, access, cv_fingerprint(primary.text), run_id)
                reserved_install = access.install_hash

            prepared = await _prepare_cvs(cvs_in, emit)

            # CV vectors: cached by text hash, so only a new or edited version costs a call.
            cv_rows: dict[str, int] = {}
            missing: list[_PreparedCv] = []
            for cv in prepared:
                row_id = await store.find_cv_embedding(session, access.subject, cv.hash)
                if row_id:
                    cv_rows[cv.alias] = row_id
                else:
                    missing.append(cv)
            if missing:
                await session.commit()  # no connection held while Voyage works (it can wait out a rate limit)
                vectors = await embeddings.embed_texts([redact_contacts(cv.text) for cv in missing], "query")
                for cv, vec in zip(missing, vectors):
                    cv_rows[cv.alias] = await store.save_cv_embedding(session, access.subject, cv.hash, vec)
            await store.touch_cv_embeddings(session, list(cv_rows.values()))
            await session.commit()
            emit({"type": "cv_ready", "count": len(prepared), "embedded_now": len(missing)})

            # Stage 1
            since = config.utcnow() - config.ACTIVE_WINDOW
            counts = await store.pool_counts(session, since)
            per_cv = await store.search_jobs(session, cv_rows, access.subject, since, config.TOP_K)
            candidates = retrieval.merge_candidates(per_cv, config.TOP_K, config.MIN_PER_CV)
            jobs = {}
            if candidates:
                rows = await session.execute(select(DailyJobPool).where(
                    DailyJobPool.id.in_([c.job_id for c in candidates])))
                jobs = {j.id: j for j in rows.scalars()}
                candidates = [c for c in candidates if c.job_id in jobs]
            if not candidates and counts["active"] > counts["embedded"]:
                # Jobs are in, vectors aren't yet: the status call starts that in the background.
                raise DmError("DM_POOL_PREPARING", "מאגר המשרות של היום בהכנה. נסה/י שוב בעוד כמה דקות.", 503)
            if not candidates:
                raise DmError("DM_POOL_EMPTY", "מאגר המשרות של היום עדיין לא מוכן. נסה/י שוב בעוד כמה שעות.", 503)
            emit({"type": "candidates", "pool": counts["active"], "embedded": counts["embedded"],
                  "candidates": len(candidates)})

            # Stage 2 — the job rows are loaded; release the connection during the LLM calls.
            await session.commit()
            prompt_cvs = [reasoning.CvForPrompt(cv.alias, cv.ref, cv.label, redact_contacts(cv.text))
                          for cv in prepared]
            prompt_jobs = [reasoning.JobForPrompt(c.job_id, job_llm_text(
                jobs[c.job_id].title, jobs[c.job_id].company, jobs[c.job_id].category,
                jobs[c.job_id].seniority, jobs[c.job_id].description)) for c in candidates]
            analyses, usage = await reasoning.analyze_jobs(
                prompt_cvs, prompt_jobs,
                on_progress=lambda done, total: emit({"type": "progress", "done": done, "total": total}))

            # The deck
            alias_to_ref = {cv.alias: cv.ref for cv in prepared}
            cards = rank_cards(candidates, analyses)
            for rank, (cand, analysis) in enumerate(cards, 1):
                session.add(DmRunResult(
                    run_id=run_id, job_id=cand.job_id, rank=rank, vector_score=round(cand.sim, 4),
                    match_score=analysis["match_score"] if analysis else None,
                    best_cv_ref=analysis["best_cv_ref"] if analysis else alias_to_ref.get(cand.best_cv),
                    analysis=analysis, job_snapshot=job_snapshot(jobs[cand.job_id]),
                ))
            await session.execute(
                update(DmRun).where(DmRun.id == run_id).values(
                    status="done", finished_at=config.utcnow(), pool_size=counts["active"],
                    candidates=len(candidates), results=len(cards), **usage,
                ).execution_options(synchronize_session=False))
            if reserved_install:
                await consume_trial(session, reserved_install)
            await session.commit()
            emit({"type": "done", "run_id": run_id, "count": len(cards)})

        except DmError as exc:
            await _mark_failed(session, run_id, reserved_install, exc.code)
            emit(error_event(exc.code, exc.coded()))
        except cv_text.PdfRejected as exc:
            await _mark_failed(session, run_id, reserved_install, "DM_CV_UNREADABLE")
            emit(error_event("DM_CV_UNREADABLE", f"{exc} [jma:DM_CV_UNREADABLE]"))
        except embeddings.EmbeddingUnavailable as exc:
            logger.error("[DM] embeddings unavailable: %s", exc)
            await _mark_failed(session, run_id, reserved_install, "DM_NOT_READY")
            emit(error_event("DM_NOT_READY", "ההתאמות היומיות לא זמינות כרגע. נסה/י שוב מאוחר יותר. [jma:DM_NOT_READY]"))
        except HTTPException as exc:  # main.ai_error: already "message [jma:CODE]"
            await _mark_failed(session, run_id, reserved_install, "AI_ERROR")
            emit(error_event("AI_ERROR", str(exc.detail)))
        except asyncio.CancelledError:
            await asyncio.shield(_mark_failed(session, run_id, reserved_install, "CANCELLED"))
            raise
        except Exception:  # noqa: BLE001
            logger.exception("[DM] run %s crashed", run_id)
            await _mark_failed(session, run_id, reserved_install, "DM_INTERNAL")
            emit(error_event("DM_INTERNAL", "קרתה תקלה בבניית ההתאמות. אפשר לנסות שוב. [jma:DM_INTERNAL]"))


def start_pipeline(cvs_in: list[CvInput], primary_id: str | None, access: Access) -> tuple[asyncio.Task, asyncio.Queue]:
    queue: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(_pipeline(cvs_in, primary_id, access, queue.put_nowait))
    _running.add(task)  # a strong reference, so the task outlives a closed connection
    task.add_done_callback(_running.discard)
    return task, queue


async def stream_run(cvs_in: list[CvInput], primary_id: str | None, access: Access) -> AsyncIterator[str]:
    task, queue = start_pipeline(cvs_in, primary_id, access)
    while True:
        try:
            event = await asyncio.wait_for(queue.get(), timeout=10)
        except asyncio.TimeoutError:
            if task.done() and queue.empty():
                yield sse(error_event("DM_INTERNAL", "הריצה הסתיימה בלי תוצאה. נסה/י שוב. [jma:DM_INTERNAL]"))
                break
            yield ": keep-alive\n\n"
            continue
        yield sse(event)
        if event["type"] in TERMINAL_EVENTS:
            break
    yield "data: [DONE]\n\n"


async def single_event_stream(event: dict) -> AsyncIterator[str]:
    yield sse(event)
    yield "data: [DONE]\n\n"
