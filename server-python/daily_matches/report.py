"""A health report on the last days of Daily Matches, for a public run log.

Read-only. Aggregates only: no subjects, no CV text, no job titles, nothing
that ties a deck to a person. scripts/dm_report.py prints it; the
"Daily Matches report" workflow runs that, so the pipeline and the decks can
be checked from GitHub without access to the web service's logs.
"""
from collections import Counter
from datetime import timedelta

from sqlalchemy import select

from daily_matches import config, store
from daily_matches.models import DmPipelineDay, DmRun, DmRunResult
from daily_matches.service import compare_summary, main_reason


def _reason_key(analysis: dict | None) -> str:
    r = main_reason(analysis)
    if not r:
        return "other"
    if r["kind"] == "cap":
        return f"cap:{r['name']}"
    if r["kind"] == "years":
        return "years"
    if r["kind"] == "verdict":
        return f"verdict:{r.get('verdict')}"
    return f"{r.get('importance')}_{r.get('status')}"  # must_missing, must_partial, nice_missing...


async def build_report(session, now=None, days: int = 3) -> dict:
    now = now or config.utcnow()
    since = now - timedelta(days=days)
    runs = (await session.execute(select(DmRun).where(DmRun.started_at >= since)
                                  .order_by(DmRun.started_at))).scalars().all()
    out_runs = []
    for run in runs:
        rows = (await session.execute(select(DmRunResult).where(DmRunResult.run_id == run.id))).scalars().all()
        tiers = Counter(r.tier or "strong" for r in rows)
        scores = [r.match_score for r in rows if r.match_score is not None]
        usage = {"input_tokens": run.input_tokens or 0, "output_tokens": run.output_tokens or 0,
                 "cache_read_tokens": run.cache_read_tokens or 0, "cache_write_tokens": run.cache_write_tokens or 0}
        finished = config.as_utc(run.finished_at)
        started = config.as_utc(run.started_at)
        out_runs.append({
            "run": run.id,
            "day": run.match_day.isoformat(),
            "started_utc": started.strftime("%Y-%m-%d %H:%M") if started else None,
            "seconds": round((finished - started).total_seconds()) if finished and started else None,
            "status": run.status,
            "entitlement": run.entitlement,
            "new_in_fields": run.fresh_jobs,
            "sent_to_ai": run.candidates,
            "analyzed_ok": len(rows),
            "strong": tiers.get("strong", 0), "maybe": tiers.get("maybe", 0), "hidden": tiers.get("hidden", 0),
            "scores": {"max": max(scores), "median": sorted(scores)[len(scores) // 2], "min": min(scores)} if scores else None,
            "score_bands": dict(sorted(Counter(min(s // 10 * 10, 90) for s in scores).items(), reverse=True)),
            "hidden_reasons": dict(Counter(_reason_key(r.analysis) for r in rows if (r.tier or "") == "hidden")
                                   .most_common()),
            # Left-out jobs the person said fit them, by the reason they were left
            # out: where the scoring is too strict.
            "marked_fits": dict(Counter(_reason_key(r.analysis) for r in rows if r.user_action == "fits")
                                .most_common()),
            "with_unknown_credentials": sum(1 for r in rows if (r.analysis or {}).get("to_confirm")),
            "method": next(((r.analysis or {}).get("method") or "scored" for r in rows), None),
            "verdicts": dict(Counter((r.analysis or {}).get("verdict") for r in rows
                                     if (r.analysis or {}).get("verdict")).most_common()),
            # Admins' runs: the side-by-side comparison, and who they marked right.
            "compare": compare_summary(list(rows), run),
            "tokens": usage,
            "cache_hit_share": round(usage["cache_read_tokens"] / max(1, usage["cache_read_tokens"]
                                                                       + usage["cache_write_tokens"]), 2),
            "cost_usd_at_current_prices": round(config.usage_cost(usage), 4),
            "error": (run.error or "")[:120] or None,
        })
    counts = await store.pool_counts(session, now - config.ACTIVE_WINDOW, now=now)
    return {"utc": now.strftime("%Y-%m-%d %H:%M"), "model": config.LLM_MODEL, "max_analyzed": config.MAX_ANALYZED,
            "max_analyzed_first": config.MAX_ANALYZED_FIRST,
            "pool": counts, "collection": await _collection(session, now, days), "runs": out_runs}


async def _collection(session, now, days: int) -> list[dict] | str:
    """Each day's collection (daily_pipeline.day_summary), newest first: new
    jobs per source, and LinkedIn's state."""
    first = config.to_israel(now).date() - timedelta(days=days)
    try:
        rows = (await session.execute(select(DmPipelineDay).where(DmPipelineDay.day > first)
                                      .order_by(DmPipelineDay.day.desc()))).scalars().all()
    except Exception as exc:  # noqa: BLE001 — a database the migration hasn't reached yet
        await session.rollback()
        return f"unavailable: {type(exc).__name__}"
    return [{"day": r.day.isoformat(), "finished_il": config.to_israel(config.as_utc(r.finished_at)).strftime("%H:%M"),
             **r.summary} for r in rows]
