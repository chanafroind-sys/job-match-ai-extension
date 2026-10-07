"""HTTP surface: /api/daily-matches/*.

Callers identify with the existing X-License-Key header plus
X-JMA-Install-Id, a random ID the extension generates once (daily/dm-api.js).
The feature is off until DAILY_MATCHES_ENABLED is set (config.mode()).
Errors on the SSE route travel as events, never as a status code mid-stream,
the same rule V1's streaming endpoints follow.
"""
import asyncio
import logging
from datetime import timedelta
from typing import Literal, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import require_admin
from daily_matches import config, cv_text, pool_embedding, service, store
from daily_matches.entitlement import MSG_DISABLED, Access, DmError, client_ip, locked_error, resolve_access
from daily_matches.models import DmRun, DmRunResult
from daily_matches.text_prep import cv_fingerprint, is_pdf_blob, pdf_b64_from_blob

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/daily-matches", tags=["daily-matches"])

_MAX_BLOB = 8_000_000  # a 5 MB PDF is ~7 MB of base64


class CvIn(BaseModel):
    id: str = Field(..., min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field("", max_length=60)
    text: str = Field(..., min_length=1, max_length=_MAX_BLOB)
    # Job categories this version targets; unknown names are ignored, none means all.
    focus: list[str] = Field(default_factory=list, max_length=len(config.CATEGORIES))


class PrefsIn(BaseModel):
    level: Optional[Literal["junior", "mid", "senior", "lead"]] = None


class RunIn(BaseModel):
    cvs: list[CvIn] = Field(..., min_length=1, max_length=config.MAX_CV_VERSIONS)
    primaryCvId: Optional[str] = Field(None, max_length=40)
    prefs: Optional[PrefsIn] = None


class ActionIn(BaseModel):
    action: Literal["viewed", "saved", "skipped", "applied", "clear"]


class ExtractIn(BaseModel):
    pdf: str = Field(..., min_length=10, max_length=_MAX_BLOB)


# ── helpers ───────────────────────────────────────────────────────────────────

async def _access(request: Request, db: AsyncSession, license_key, install_id,
                  fingerprint: str | None = None) -> Access:
    try:
        return await resolve_access(db, license_key, install_id, client_ip(request), fingerprint)
    except DmError as exc:
        raise HTTPException(status_code=exc.http_status, detail=exc.coded())


def _disabled() -> HTTPException:
    return HTTPException(status_code=404, detail=f"{MSG_DISABLED} [jma:DM_DISABLED]")


async def _run_for_day(db: AsyncSession, subject: str) -> DmRun | None:
    return (await db.execute(select(DmRun).where(
        DmRun.subject == subject, DmRun.match_day == config.match_day()))).scalar_one_or_none()


async def _latest_done_run(db: AsyncSession, subject: str) -> DmRun | None:
    return (await db.execute(select(DmRun).where(DmRun.subject == subject, DmRun.status == "done")
                             .order_by(DmRun.match_day.desc()).limit(1))).scalar_one_or_none()


def _run_status(run: DmRun) -> str:
    started = config.as_utc(run.started_at)
    if run.status == "running" and started and started < config.utcnow() - config.RUN_STALE_AFTER:
        return "failed"  # the process died mid-run; a new run is allowed
    return run.status


def _run_json(run: DmRun) -> dict:
    return {
        "id": run.id,
        "match_day": run.match_day.isoformat(),
        "status": _run_status(run),
        "entitlement": run.entitlement,
        "pool_size": run.pool_size,
        "fresh": run.fresh_jobs,
        "candidates": run.candidates,
        "cards": run.results,
    }


def _card_json(row: DmRunResult) -> dict:
    return {
        "id": row.id,
        "rank": row.rank,
        "match_score": row.match_score,
        "tier": row.tier or "strong",
        "vector_score": row.vector_score,
        "best_cv_id": row.best_cv_ref,
        "analysis": row.analysis,
        "job": row.job_snapshot,
        "user_action": row.user_action,
    }


def _shown():
    """Deck rows: strong and maybe, plus rows from before tiers existed."""
    return or_(DmRunResult.tier.is_(None), DmRunResult.tier.in_(service.SHOWN_TIERS))


def _sse_one(event: dict) -> StreamingResponse:
    return StreamingResponse(service.single_event_stream(event), media_type="text/event-stream",
                             headers=service.SSE_HEADERS)


# ── endpoints ─────────────────────────────────────────────────────────────────

@router.get("/status")
async def status(request: Request,
                 x_license_key: Optional[str] = Header(None),
                 x_jma_install_id: Optional[str] = Header(None),
                 db: AsyncSession = Depends(get_db)):
    """What the entry card needs on popup open. No AI cost."""
    try:
        access = await resolve_access(db, x_license_key, x_jma_install_id, client_ip(request))
    except DmError as exc:
        return {"enabled": True, "entitlement": "unknown", "error": exc.coded()}
    if access.kind == "disabled":
        return {"enabled": False, "reason": access.reason}
    today = await _run_for_day(db, access.subject) if access.subject else None
    last = None
    if access.subject and access.kind == "locked" and not today:
        last = await _latest_done_run(db, access.subject)
    pool = await store.pool_counts(db, config.utcnow() - config.ACTIVE_WINDOW)
    return {
        "enabled": True,
        "entitlement": access.kind,
        "reason": access.reason,
        "is_admin": access.is_admin,
        "today": _run_json(today) if today else None,
        "last_run": _run_json(last) if last else None,
        "next_reset_at": config.next_reset().isoformat(),
        "pool": pool,
    }


@router.post("/run")
async def run(body: RunIn, request: Request,
              x_license_key: Optional[str] = Header(None),
              x_jma_install_id: Optional[str] = Header(None),
              db: AsyncSession = Depends(get_db)):
    """Build today's deck. SSE events: started, cv_text (a PDF's extracted text,
    for the extension to keep), cv_ready, candidates, progress, then done,
    already (today's run exists) or error."""
    primary = next((c for c in body.cvs if c.id == body.primaryCvId), body.cvs[0])
    try:
        access = await resolve_access(db, x_license_key, x_jma_install_id, client_ip(request),
                                      cv_fingerprint(primary.text))
    except DmError as exc:
        return _sse_one(service.error_event(exc.code, exc.coded()))
    if access.kind == "disabled":
        return _sse_one(service.error_event("DM_DISABLED", f"{MSG_DISABLED} [jma:DM_DISABLED]"))
    if access.kind == "locked":
        # A trial user whose run already happened today gets that deck back, not a paywall.
        today = await _run_for_day(db, access.subject) if access.subject else None
        if today and _run_status(today) in ("done", "running"):
            return _sse_one({"type": "already", "run_id": today.id, "status": _run_status(today)})
        err = locked_error(access.reason)
        return _sse_one(service.error_event(err.code, err.coded()))

    cvs = [service.CvInput(id=c.id, label=c.label, text=c.text, focus=c.focus) for c in body.cvs]
    prefs = service.Prefs(level=body.prefs.level if body.prefs else None)
    return StreamingResponse(service.stream_run(cvs, body.primaryCvId, access, prefs),
                             media_type="text/event-stream", headers=service.SSE_HEADERS)


@router.get("/today")
async def today(request: Request, latest: bool = False,
                x_license_key: Optional[str] = Header(None),
                x_jma_install_id: Optional[str] = Header(None),
                db: AsyncSession = Depends(get_db)):
    """Today's deck from the database. With latest=1 and no deck today, the most
    recent deck instead (how a user whose trial ended reopens it)."""
    access = await _access(request, db, x_license_key, x_jma_install_id)
    if access.kind == "disabled":
        raise _disabled()
    if not access.subject:
        return {"run": None, "cards": [], "entitlement": access.kind}
    run_row = await _run_for_day(db, access.subject)
    if latest and (run_row is None or run_row.status != "done"):
        run_row = await _latest_done_run(db, access.subject) or run_row
    if run_row is None:
        return {"run": None, "cards": [], "entitlement": access.kind}
    cards = []
    if run_row.status == "done":
        rows = await db.execute(select(DmRunResult).where(DmRunResult.run_id == run_row.id, _shown())
                                .order_by(DmRunResult.rank))
        cards = [_card_json(r) for r in rows.scalars()]
    return {"run": _run_json(run_row), "cards": cards, "entitlement": access.kind}


@router.post("/results/{result_id}/action")
async def record_action(result_id: int, body: ActionIn, request: Request,
                        x_license_key: Optional[str] = Header(None),
                        x_jma_install_id: Optional[str] = Header(None),
                        db: AsyncSession = Depends(get_db)):
    access = await _access(request, db, x_license_key, x_jma_install_id)
    if not access.subject:
        raise _disabled() if access.kind == "disabled" else HTTPException(status_code=403, detail="Forbidden")
    row = (await db.execute(
        select(DmRunResult).join(DmRun, DmRun.id == DmRunResult.run_id)
        .where(DmRunResult.id == result_id, DmRun.subject == access.subject)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Card not found")
    if body.action == "viewed":
        if row.user_action is None:
            row.user_action, row.action_at = "viewed", config.utcnow()
    elif body.action == "clear":
        row.user_action, row.action_at = None, config.utcnow()
    else:
        row.user_action, row.action_at = body.action, config.utcnow()
    await db.commit()
    return {"ok": True, "user_action": row.user_action}


@router.get("/saved")
async def saved(request: Request,
                x_license_key: Optional[str] = Header(None),
                x_jma_install_id: Optional[str] = Header(None),
                db: AsyncSession = Depends(get_db)):
    access = await _access(request, db, x_license_key, x_jma_install_id)
    if not access.subject:
        return {"cards": []}
    rows = await db.execute(
        select(DmRunResult, DmRun.match_day).join(DmRun, DmRun.id == DmRunResult.run_id)
        .where(DmRun.subject == access.subject, DmRunResult.user_action == "saved")
        .order_by(DmRunResult.action_at.desc()).limit(50))
    return {"cards": [{**_card_json(r), "match_day": day.isoformat()} for r, day in rows.all()]}


@router.post("/cv/extract")
async def extract_cv(body: ExtractIn, request: Request,
                     x_license_key: Optional[str] = Header(None),
                     x_jma_install_id: Optional[str] = Header(None),
                     db: AsyncSession = Depends(get_db)):
    """PDF → text when a CV version is added to the library. One Haiku call."""
    access = await _access(request, db, x_license_key, x_jma_install_id)
    if access.kind == "disabled":
        raise _disabled()
    if access.kind == "locked":
        err = locked_error(access.reason)
        raise HTTPException(status_code=err.http_status, detail=err.coded())
    from app.core.rate_limit import check_and_record

    if not check_and_record("dm_cv_extract", access.subject, 12, 3600):
        raise HTTPException(status_code=429, detail="יותר מדי קבצים בשעה האחרונה. נסה/י שוב מאוחר יותר. [jma:AI_RATE_LIMIT]")
    b64 = pdf_b64_from_blob(body.pdf) if is_pdf_blob(body.pdf) else body.pdf
    try:
        text = await cv_text.extract_pdf_text(b64)
    except cv_text.PdfRejected as exc:
        raise HTTPException(status_code=422, detail=f"{exc} [jma:DM_CV_UNREADABLE]")
    return {"text": text}


# ── admin ─────────────────────────────────────────────────────────────────────

def _run_cost(run: DmRun) -> float:
    return config.usage_cost({"input_tokens": run.input_tokens, "output_tokens": run.output_tokens,
                              "cache_read_tokens": run.cache_read_tokens,
                              "cache_write_tokens": run.cache_write_tokens})


def _band(score: int | None) -> str:
    if score is None:
        return "no_analysis"
    return "75+" if score >= 75 else "55-74" if score >= 55 else "35-54" if score >= 35 else "<35"


@router.get("/admin/metrics")
async def admin_metrics(days: int = 14, _admin=Depends(require_admin), db: AsyncSession = Depends(get_db)):
    """Runs and cost per day, plus what users did with cards by score band:
    if 75+ cards aren't applied to more than 55-74 ones, the scores need work."""
    since = config.match_day() - timedelta(days=max(1, min(days, 90)))
    runs = (await db.execute(select(DmRun).where(DmRun.match_day >= since))).scalars().all()
    by_day: dict[str, dict] = {}
    for r in runs:
        d = by_day.setdefault(r.match_day.isoformat(), {"runs": 0, "done": 0, "failed": 0, "trial": 0, "cost_usd": 0.0})
        d["runs"] += 1
        d["done"] += r.status == "done"
        d["failed"] += r.status == "failed"
        d["trial"] += r.entitlement == "trial"
        d["cost_usd"] = round(d["cost_usd"] + _run_cost(r), 4)
    done = [r for r in runs if r.status == "done"]
    rows = (await db.execute(select(DmRunResult.match_score, DmRunResult.user_action, DmRunResult.tier)
                             .join(DmRun, DmRun.id == DmRunResult.run_id)
                             .where(DmRun.match_day >= since))).all()
    bands: dict[str, dict] = {}
    for score, action, tier in rows:
        b = bands.setdefault(_band(score), {"analyzed": 0, "shown": 0, "viewed": 0, "saved": 0,
                                            "skipped": 0, "applied": 0})
        b["analyzed"] += 1
        b["shown"] += tier is None or tier in service.SHOWN_TIERS
        if action in b:
            b[action] += 1
    return {
        "mode": config.mode(),
        "days": [{"day": k, **v} for k, v in sorted(by_day.items())],
        "avg_cost_per_run_usd": round(sum(map(_run_cost, done)) / len(done), 4) if done else None,
        "actions_by_band": bands,
        "pool": await store.pool_counts(db, config.utcnow() - config.ACTIVE_WINDOW),
        "last_embed_report": _last_embed_report or None,
    }


_embed_lock = asyncio.Lock()
_last_embed_report: dict = {}


async def _embed_in_own_session() -> None:
    if _embed_lock.locked():
        return
    async with _embed_lock:
        try:
            async with service._new_session() as session:
                report = await pool_embedding.embed_pool(session)
                report["purged"] = await pool_embedding.purge_retention(session)
            _last_embed_report.clear()
            _last_embed_report.update(report, finished_at=config.utcnow().isoformat())
        except Exception as exc:  # noqa: BLE001
            logger.exception("[DM] embed-pool failed")
            _last_embed_report.clear()
            _last_embed_report.update(error=f"{type(exc).__name__}: {exc}"[:300])


@router.post("/admin/embed-pool")
async def admin_embed_pool(background_tasks: BackgroundTasks, _admin=Depends(require_admin)):
    """Embeds the active pool from the web service, against the web service's
    own database. Useful for a first backfill, or when the cron can't run."""
    if _embed_lock.locked():
        return {"status": "already running"}
    background_tasks.add_task(_embed_in_own_session)
    return {"status": "started", "last_report": _last_embed_report or None}
