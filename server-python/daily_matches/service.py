"""One Daily Matches run: claim the day, prepare CVs, Stage 1, Stage 2, store
the deck.

Stage 1 takes only fresh jobs (published within FRESH_WINDOW) that this person
was never given before, in the fields their CV versions focus on and at their
level, and keeps the MAX_ANALYZED most similar to their CVs. Stage 2 scores
each of those with its own LLM call. The deck is the jobs scoring STRONG_SCORE
or more, then the MAYBE_SCORE ones; nothing below is shown, so a quiet day
shows few cards or none.

The pipeline runs as its own task and reports through a queue that the SSE
response drains. If the user closes the side panel mid-build, the task keeps
going and the deck is waiting when they come back. Every failure path marks
the day's run failed and releases a reserved trial, so a failed run never uses
up the day or the free trial. A run with nothing new to analyze costs nothing,
so it doesn't use them up either.
"""
import asyncio
import json
import logging
from dataclasses import dataclass, field
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
# main.ai_error codes that mean the server's own Anthropic account refused the call.
SERVER_KEY_FAILURES = ("AI_NO_CREDIT", "AI_KEY_INVALID", "AI_KEY_DENIED")
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
    focus: list[str] = field(default_factory=list)  # job categories this version targets


@dataclass
class Prefs:
    level: str | None = None  # a config.LEVEL_EXCLUDES key, or None for any level


@dataclass
class _PreparedCv:
    alias: str
    ref: str
    label: str
    text: str
    hash: str
    focus: list[str] = field(default_factory=list)


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
    if existing.status == "done" and existing.candidates != 0 and not access.is_admin:
        return "done", existing
    retryable = [
        DmRun.status == "failed",
        and_(DmRun.status == "running", DmRun.started_at < now - config.RUN_STALE_AFTER),
        # Nothing was analyzed, so nothing was spent: after changing their
        # focus or CVs, a person may look again the same day.
        and_(DmRun.status == "done", DmRun.candidates == 0),
    ]
    if access.is_admin:
        # Admins rebuild a finished day on purpose, to judge a change to the
        # matching right away. The day's results go, so its jobs count as unseen.
        retryable.append(DmRun.status == "done")
    retried = await session.execute(
        update(DmRun)
        .where(DmRun.id == existing.id, or_(*retryable))
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

SHOWN_TIERS = ("strong", "maybe")


def tier_for(score: int) -> str:
    if score >= config.STRONG_SCORE:
        return "strong"
    return "maybe" if score >= config.MAYBE_SCORE else "hidden"


def rank_results(candidates: list[retrieval.Candidate],
                 analyses: dict[str, dict | None]) -> list[tuple[retrieval.Candidate, dict, str]]:
    """Every analyzed job, best first, with its tier. Only strong and maybe are
    shown; hidden ones are kept so they never come back. A job whose analysis
    failed is left out entirely, so a later run can try it again."""
    analyzed = [(c, analyses[c.job_id]) for c in candidates if analyses.get(c.job_id)]
    analyzed.sort(key=lambda t: (-t[1]["match_score"], -t[0].sim))
    return [(c, a, tier_for(a["match_score"])) for c, a in analyzed]


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
        "is_new": bool(published and published >= config.utcnow() - config.FRESH_WINDOW),
        "excerpt": card_excerpt(job.description),
    }


def job_filters(access: Access, prepared: list[_PreparedCv], prefs: Prefs,
                now) -> tuple[store.JobFilter, dict[str, store.JobFilter]]:
    """The run's filter (every focused category together) and one per CV
    version: a version searches its own categories, or the run's when it has
    none. No focus anywhere means every category."""
    excluded = list(config.LEVEL_EXCLUDES.get(prefs.level or "", ()))
    union = sorted({c for cv in prepared for c in cv.focus})

    def make(categories: list[str]) -> store.JobFilter:
        return store.JobFilter(subject=access.subject, active_since=now - config.ACTIVE_WINDOW,
                               published_since=now - config.FRESH_WINDOW,
                               categories=categories, excluded_seniority=excluded)
    return make(union), {cv.alias: make(cv.focus or union) for cv in prepared}


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
        focus = [c for c in config.CATEGORIES if c in set(cv.focus or [])]
        prepared.append(_PreparedCv(alias=f"cv{len(prepared) + 1}", ref=cv.id,
                                    label=(cv.label or "").strip()[:60] or f"CV {len(prepared) + 1}",
                                    text=norm, hash=sha256(norm), focus=focus))
    if not prepared:
        raise DmError("DM_NO_CV", "לא נמצאו קורות חיים עם מספיק טקסט להתאמה. העלה/י קורות חיים בהגדרות.", 422)
    return prepared


async def _ask_compare_model(prompt_cvs, prompt_jobs) -> dict[str, dict | None] | None:
    """Admins' runs: config.COMPARE_MODEL analyzes the same jobs, alongside the
    main model. Its failure never fails the run."""
    try:
        other, usage = await reasoning.analyze_jobs(prompt_cvs, prompt_jobs, model=config.COMPARE_MODEL)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[DM] compare model %s failed: %s", config.COMPARE_MODEL, exc)
        return None
    logger.warning("[DM] compare model %s cost $%.4f", config.COMPARE_MODEL,
                   config.usage_cost(usage, config.COMPARE_MODEL))
    return other


def merge_compare(analyses: dict[str, dict | None], other: dict[str, dict | None] | None) -> None:
    """Puts the compare model's verdict next to the main one on each analysis,
    or marks it failed, so every analyzed job counts in compare_summary."""
    if other is None:
        return
    for job_id, main_analysis in analyses.items():
        if not main_analysis:
            continue
        alt = other.get(job_id)
        if not alt:
            main_analysis["compare"] = {"model": config.COMPARE_MODEL, "failed": True}
            continue
        main_analysis["compare"] = {
            "model": config.COMPARE_MODEL, "match_score": alt["match_score"], "tier": tier_for(alt["match_score"]),
            "best_cv_ref": alt["best_cv_ref"], "fit_summary_he": alt["fit_summary_he"],
            "requirements": alt["requirements"], "cap": alt.get("cap"),
            "cost_usd": round(float(alt.get("_cost_usd") or 0), 6), "provider": alt.get("_provider") or "",
        }


def compare_summary(rows: list[DmRunResult], run: DmRun) -> dict | None:
    """How far the compare model is from the main one across every job the run
    analyzed (shown or not): the numbers to decide a switch on."""
    pairs, failed, cost, model = [], 0, 0.0, None
    for row in rows:
        alt = (row.analysis or {}).get("compare")
        if not alt or row.match_score is None:
            continue
        model = alt.get("model") or model
        if alt.get("failed"):
            failed += 1
            continue
        pairs.append((row.match_score, alt["match_score"], row.tier or tier_for(row.match_score),
                      alt.get("tier") or tier_for(alt["match_score"])))
        cost += float(alt.get("cost_usd") or 0)
    if model is None:
        return None
    n = len(pairs)
    shown = ("strong", "maybe")
    main_usage = {"input_tokens": run.input_tokens or 0, "output_tokens": run.output_tokens or 0,
                  "cache_read_tokens": run.cache_read_tokens or 0, "cache_write_tokens": run.cache_write_tokens or 0}
    return {
        "model": model,
        "main_model": config.LLM_MODEL,
        "jobs": n + failed,
        "failed": failed,
        "mean_abs_diff": round(sum(abs(a - b) for a, b, _, _ in pairs) / n, 1) if n else None,
        "mean_diff": round(sum(b - a for a, b, _, _ in pairs) / n, 1) if n else None,  # + : the other model scores higher
        "within_10": round(100 * sum(abs(a - b) <= 10 for a, b, _, _ in pairs) / n) if n else None,
        "same_tier": round(100 * sum(t == u for _, _, t, u in pairs) / n) if n else None,
        "shown_main": sum(t in shown for _, _, t, _ in pairs),
        "shown_other": sum(u in shown for _, _, _, u in pairs),
        "shown_both": sum(t in shown and u in shown for _, _, t, u in pairs),
        "cost_other_usd": round(cost, 4),
        "cost_main_usd": round(config.usage_cost(main_usage), 4),
    }


async def _pipeline(cvs_in: list[CvInput], primary_id: str | None, access: Access,
                    emit: Callable[[dict], None], prefs: Prefs | None = None) -> None:
    prefs = prefs or Prefs()
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

            # Stage 1: fresh, unseen, in focus, at level; the closest MAX_ANALYZED.
            now = config.utcnow()
            run_filter, cv_filters = job_filters(access, prepared, prefs, now)
            counts = await store.pool_counts(session, run_filter.active_since)
            if counts["active"] == 0:
                raise DmError("DM_POOL_EMPTY", "מאגר המשרות של היום עדיין לא מוכן. נסה/י שוב בעוד כמה שעות.", 503)
            fresh_total = await store.count_fresh(session, run_filter)
            per_cv: dict[str, list[tuple[str, float]]] = {}
            for alias, row_id in cv_rows.items():
                found = await store.search_jobs(session, {alias: row_id}, cv_filters[alias], config.MAX_ANALYZED)
                per_cv.update(found)
            candidates = retrieval.merge_candidates(per_cv, config.MAX_ANALYZED, config.MIN_PER_CV)
            jobs = {}
            if candidates:
                rows = await session.execute(select(DailyJobPool).where(
                    DailyJobPool.id.in_([c.job_id for c in candidates])))
                jobs = {j.id: j for j in rows.scalars()}
                candidates = [c for c in candidates if c.job_id in jobs]
            if not candidates and counts["active"] > counts["embedded"]:
                # Jobs are in, vectors aren't yet: the status call starts that in the background.
                raise DmError("DM_POOL_PREPARING", "מאגר המשרות של היום בהכנה. נסה/י שוב בעוד כמה דקות.", 503)
            emit({"type": "candidates", "pool": counts["active"], "embedded": counts["embedded"],
                  "fresh": fresh_total, "candidates": len(candidates)})

            if not candidates:
                # A quiet day: nothing new in this person's fields. Nothing was spent,
                # so the trial stays unused and the day can be retried (claim_run).
                await session.execute(
                    update(DmRun).where(DmRun.id == run_id).values(
                        status="done", finished_at=config.utcnow(), pool_size=counts["active"],
                        fresh_jobs=fresh_total, candidates=0, results=0,
                    ).execution_options(synchronize_session=False))
                if reserved_install:
                    await release_trial(session, reserved_install)
                await session.commit()
                emit({"type": "done", "run_id": run_id, "count": 0, "strong": 0, "maybe": 0,
                      "analyzed": 0, "fresh": fresh_total})
                return

            # Stage 2 — the job rows are loaded; release the connection during the LLM calls.
            await session.commit()
            prompt_cvs = [reasoning.CvForPrompt(cv.alias, cv.ref, cv.label, redact_contacts(cv.text))
                          for cv in prepared]
            prompt_jobs = [reasoning.JobForPrompt(c.job_id, job_llm_text(
                jobs[c.job_id].title, jobs[c.job_id].company, jobs[c.job_id].category,
                jobs[c.job_id].seniority, jobs[c.job_id].description)) for c in candidates]
            compare = (asyncio.create_task(_ask_compare_model(prompt_cvs, prompt_jobs))
                       if config.COMPARE_MODEL and access.is_admin else None)  # alongside, not after
            try:
                analyses, usage = await reasoning.analyze_jobs(
                    prompt_cvs, prompt_jobs,
                    on_progress=lambda done, total: emit({"type": "progress", "done": done, "total": total}))
            except BaseException:
                if compare is not None:
                    compare.cancel()
                raise
            if compare is not None:
                merge_compare(analyses, await compare)
            for analysis in analyses.values():  # per-call bookkeeping, not part of the card
                if analysis:
                    analysis.pop("_cost_usd", None)
                    analysis.pop("_provider", None)

            # The deck: every analyzed job is kept, so none is analyzed or shown twice.
            ranked = rank_results(candidates, analyses)
            for rank, (cand, analysis, tier) in enumerate(ranked, 1):
                session.add(DmRunResult(
                    run_id=run_id, job_id=cand.job_id, rank=rank, vector_score=round(cand.sim, 4),
                    match_score=analysis["match_score"], tier=tier, best_cv_ref=analysis["best_cv_ref"],
                    analysis=analysis, job_snapshot=job_snapshot(jobs[cand.job_id]),
                ))
            strong = sum(1 for *_, t in ranked if t == "strong")
            maybe = sum(1 for *_, t in ranked if t == "maybe")
            await session.execute(
                update(DmRun).where(DmRun.id == run_id).values(
                    status="done", finished_at=config.utcnow(), pool_size=counts["active"],
                    fresh_jobs=fresh_total, candidates=len(candidates), results=strong + maybe, **usage,
                ).execution_options(synchronize_session=False))
            if reserved_install:
                # A trial is used up only by a deck with something in it.
                await (consume_trial if strong + maybe else release_trial)(session, reserved_install)
            await session.commit()
            emit({"type": "done", "run_id": run_id, "count": strong + maybe, "strong": strong,
                  "maybe": maybe, "analyzed": len(candidates), "analyzed_ok": len(ranked), "fresh": fresh_total})

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
            detail = str(exc.detail)
            await _mark_failed(session, run_id, reserved_install, "AI_ERROR")
            if any(f"[jma:{code}]" in detail for code in SERVER_KEY_FAILURES):
                # Daily Matches always runs on the server's key, so main.ai_error's
                # advice to use a personal Claude key doesn't apply here.
                logger.error("[DM] Anthropic refused the server key: %s", detail)
                detail = ("שירות ה-AI של ההתאמות היומיות לא זמין כרגע. הריצה לא נספרה, "
                          "ואפשר לנסות שוב מאוחר יותר. [jma:AI_UNAVAILABLE]")
            emit(error_event("AI_ERROR", detail))
        except asyncio.CancelledError:
            await asyncio.shield(_mark_failed(session, run_id, reserved_install, "CANCELLED"))
            raise
        except Exception:  # noqa: BLE001
            logger.exception("[DM] run %s crashed", run_id)
            await _mark_failed(session, run_id, reserved_install, "DM_INTERNAL")
            emit(error_event("DM_INTERNAL", "קרתה תקלה בבניית ההתאמות. אפשר לנסות שוב. [jma:DM_INTERNAL]"))


def start_pipeline(cvs_in: list[CvInput], primary_id: str | None, access: Access,
                   prefs: Prefs | None = None) -> tuple[asyncio.Task, asyncio.Queue]:
    queue: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(_pipeline(cvs_in, primary_id, access, queue.put_nowait, prefs))
    _running.add(task)  # a strong reference, so the task outlives a closed connection
    task.add_done_callback(_running.discard)
    return task, queue


async def stream_run(cvs_in: list[CvInput], primary_id: str | None, access: Access,
                     prefs: Prefs | None = None) -> AsyncIterator[str]:
    task, queue = start_pipeline(cvs_in, primary_id, access, prefs)
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
