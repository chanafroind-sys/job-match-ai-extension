"""The owner's view of the running system: server failures, paying licenses,
AI spend, and the daily collection, gathered for the admin console's
"system status" panel (GET /api/admin/health) and the report it copies.

Writers never slow or fail a request: each write is a background task with its
own database session, and any failure in it is only printed.
  MonitorMiddleware   5xx answers, exceptions, requests over SLOW_SECONDS
  record_license      a license that verified (fingerprint, plan, active)
  record_usage        tokens of one Claude call, summed per day and model
Nothing personal is stored: no key, no CV, no job text, no request body.
"""
import asyncio
import hashlib
import re
import time
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import delete, func, select
from starlette.types import ASGIApp, Receive, Scope, Send

from app.models.monitoring import AiUsageDaily, AppError, LicenseActivity

SLOW_SECONDS = 30
ERROR_RETENTION = timedelta(days=60)
ACTIVE_WINDOW = timedelta(days=35)  # a monthly subscriber verifies at least once a billing month
MAX_PENDING = 200  # background writes waiting at once; past this, new ones are dropped

_session_factory = None  # tests set their own
_pending: set[asyncio.Task] = set()


def _sessions():
    if _session_factory is not None:
        return _session_factory
    from app.core.db import async_session_factory
    return async_session_factory


_locks: dict = {}


def _lock() -> asyncio.Lock:
    """One write at a time per event loop: two requests verifying the same
    license, or calling the same model, would otherwise both insert its row."""
    loop = asyncio.get_running_loop()
    if loop not in _locks:
        _locks.clear()
        _locks[loop] = asyncio.Lock()
    return _locks[loop]


async def _serial(write, *args) -> None:
    async with _lock():
        for attempt in (1, 2):  # a second server instance can still race: its row exists now
            if await write(*args) or attempt == 2:
                return


def _spawn(coro) -> None:
    if len(_pending) >= MAX_PENDING:
        coro.close()
        return
    try:
        task = asyncio.get_running_loop().create_task(coro)
    except RuntimeError:
        coro.close()
        return
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def flush() -> None:
    """Waits for the background writes (tests, shutdown)."""
    while _pending:
        await asyncio.gather(*list(_pending), return_exceptions=True)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: datetime | None) -> datetime | None:
    return dt.replace(tzinfo=timezone.utc) if dt is not None and dt.tzinfo is None else dt


# ── Writers ──────────────────────────────────────────────────────────────────

async def _write_error(kind: str, route: str, status: int | None, detail: str, seconds: int | None) -> bool:
    try:
        async with _sessions()() as s:
            s.add(AppError(kind=kind, route=route[:160], status=status, detail=(detail or "")[:300],
                           seconds=seconds))
            await s.commit()
        return True
    except Exception as exc:  # noqa: BLE001 — monitoring never fails anything
        print(f"[JMA:monitor] error not saved: {type(exc).__name__}")
        return False


def record_error(kind: str, route: str, status: int | None = None, detail: str = "",
                 seconds: int | None = None) -> None:
    _spawn(_serial(_write_error, kind, route, status, detail, seconds))


def key_fingerprint(license_key: str) -> str:
    return hashlib.sha256(("jma-license:" + license_key.strip()).encode()).hexdigest()[:40]


async def _write_license(key_hash: str, tier: str, active: bool) -> bool:
    try:
        async with _sessions()() as s:
            row = await s.get(LicenseActivity, key_hash)
            now = _utcnow()
            if row is None:
                s.add(LicenseActivity(key_hash=key_hash, tier=tier, active=active, first_seen=now, last_seen=now))
            else:
                row.tier, row.active, row.last_seen = tier, active, now
            await s.commit()
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[JMA:monitor] license not saved: {type(exc).__name__}")
        return False


def record_license(license_key: str, tier: str, active: bool = True) -> None:
    """A license verified with the payment provider. Admin keys aren't customers."""
    try:
        from main import STATIC_ADMIN_KEYS
        if license_key.strip() in STATIC_ADMIN_KEYS:
            return
    except Exception:  # noqa: BLE001
        pass
    _spawn(_serial(_write_license, key_fingerprint(license_key), (tier or "standard")[:20], bool(active)))


async def _write_usage(day: date, model: str, usage: dict) -> bool:
    try:
        async with _sessions()() as s:
            row = await s.get(AiUsageDaily, (day, model))
            if row is None:
                row = AiUsageDaily(day=day, model=model, calls=0, input_tokens=0, output_tokens=0,
                                   cache_read_tokens=0, cache_write_tokens=0)
                s.add(row)
            row.calls += 1
            row.input_tokens += usage["input_tokens"]
            row.output_tokens += usage["output_tokens"]
            row.cache_read_tokens += usage["cache_read_tokens"]
            row.cache_write_tokens += usage["cache_write_tokens"]
            await s.commit()
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"[JMA:monitor] usage not saved: {type(exc).__name__}")
        return False


def record_usage(model: str, usage) -> None:
    """usage: an Anthropic response's usage object."""
    if usage is None:
        return
    u = {"input_tokens": getattr(usage, "input_tokens", 0) or 0,
         "output_tokens": getattr(usage, "output_tokens", 0) or 0,
         "cache_read_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
         "cache_write_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0}
    _spawn(_serial(_write_usage, _utcnow().date(), model[:60], u))


# ── Middleware ───────────────────────────────────────────────────────────────

_ID_SEGMENT = re.compile(r"/(\d+|[0-9a-f]{8,}|[0-9a-f-]{36})(?=/|$)", re.I)


def _route_of(scope: Scope) -> str:
    route = scope.get("route")
    path = getattr(route, "path", None) or _ID_SEGMENT.sub("/{id}", scope.get("path", "?"))
    return f"{scope.get('method', '')} {path}"


class MonitorMiddleware:
    """Raw ASGI, like main._CORSMiddleware, so WebSockets pass untouched."""

    def __init__(self, app: ASGIApp) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") == "OPTIONS":
            await self._app(scope, receive, send)
            return
        started = time.monotonic()
        state = {"status": None, "body": b""}

        async def watch(message: dict) -> None:
            if message["type"] == "http.response.start":
                state["status"] = message.get("status")
                waited = time.monotonic() - started
                if waited > SLOW_SECONDS:
                    record_error("slow", _route_of(scope), state["status"], "", int(waited))
            elif message["type"] == "http.response.body" and (state["status"] or 0) >= 500 \
                    and len(state["body"]) < 300:
                state["body"] += message.get("body", b"")[:300]
            await send(message)

        try:
            await self._app(scope, receive, watch)
        except Exception as exc:
            record_error("exception", _route_of(scope), 500, f"{type(exc).__name__}: {str(exc)[:200]}",
                         int(time.monotonic() - started))
            raise
        if (state["status"] or 0) >= 500:
            record_error("server_error", _route_of(scope), state["status"],
                         state["body"].decode("utf-8", "replace"), int(time.monotonic() - started))


# ── The status report ────────────────────────────────────────────────────────

def _price(model: str) -> tuple:
    from daily_matches.config import PRICES
    known = {**PRICES, "claude-sonnet-4-6": (3.00, 15.00, 0.30, 3.75)}
    return known.get(model, (3.00, 15.00, 0.30, 3.75))  # unknown: priced high, never under


def _cost(model: str, i: int, o: int, r: int, w: int) -> float:
    p_in, p_out, p_read, p_write = _price(model)
    return (i * p_in + o * p_out + r * p_read + w * p_write) / 1_000_000


async def build_health(db, now: datetime | None = None) -> dict:
    """Everything the status panel shows; aggregates only."""
    from daily_matches import config as dm_config
    from daily_matches.models import DmPipelineDay, DmRun, DmTrial

    now = now or _utcnow()
    await db.execute(delete(AppError).where(AppError.at < now - ERROR_RETENTION))
    await db.commit()

    # Licenses
    lic = (await db.execute(select(LicenseActivity))).scalars().all()
    recent = [r for r in lic if _as_utc(r.last_seen) >= now - ACTIVE_WINDOW]
    tiers: dict[str, int] = {}
    for r in recent:
        if r.active:
            tiers[r.tier] = tiers.get(r.tier, 0) + 1
    subscribers = {
        "paying_by_plan": tiers,
        "paying_total": sum(tiers.values()),
        "cancelling": sum(1 for r in recent if not r.active),  # cancelled, period not over yet
        "new_this_month": sum(1 for r in lic if _as_utc(r.first_seen) >= now.replace(day=1, hour=0, minute=0,
                                                                                    second=0, microsecond=0)),
        "active_last_7_days": sum(1 for r in lic if _as_utc(r.last_seen) >= now - timedelta(days=7)),
    }

    # AI spend this calendar month (UTC): every feature's calls + Daily Matches runs
    month_start = now.date().replace(day=1)
    spend: dict[str, float] = {}
    for row in (await db.execute(select(AiUsageDaily).where(AiUsageDaily.day >= month_start))).scalars():
        spend[row.model] = spend.get(row.model, 0.0) + _cost(row.model, row.input_tokens, row.output_tokens,
                                                              row.cache_read_tokens, row.cache_write_tokens)
    month_start_dt = datetime.combine(month_start, datetime.min.time(), tzinfo=timezone.utc)
    runs_month = (await db.execute(select(DmRun).where(DmRun.started_at >= month_start_dt))).scalars().all()
    dm_cost = sum(dm_config.usage_cost({"input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
                                        "cache_read_tokens": r.cache_read_tokens,
                                        "cache_write_tokens": r.cache_write_tokens}) for r in runs_month)
    total = sum(spend.values()) + dm_cost
    ai = {"month_usd": round(total, 2), "features_usd": {m: round(v, 2) for m, v in spend.items()},
          "daily_matches_usd": round(dm_cost, 2),
          "per_paying_user_usd": round(total / subscribers["paying_total"], 2) if subscribers["paying_total"] else None}

    # Daily Matches: the last week's decks
    week = now - timedelta(days=7)
    runs = (await db.execute(select(DmRun).where(DmRun.started_at >= week))).scalars().all()
    fail_codes: dict[str, int] = {}
    for r in runs:
        if r.status == "failed":
            code = (re.search(r"\[jma:([A-Z_]+)\]", r.error or "") or re.search(r"^([A-Z_]{4,})", r.error or ""))
            key = code.group(1) if code else (r.error or "unknown")[:60]
            fail_codes[key] = fail_codes.get(key, 0) + 1
    decks = {"built_last_7_days": sum(1 for r in runs if r.status == "done"),
             "failed_last_7_days": sum(1 for r in runs if r.status == "failed"), "failures_by_reason": fail_codes,
             "free_trials_used": (await db.execute(select(func.count()).select_from(DmTrial).where(
                 DmTrial.status == "consumed"))).scalar() or 0}

    # The daily collection
    days = (await db.execute(select(DmPipelineDay).order_by(DmPipelineDay.day.desc()).limit(3))).scalars().all()
    il_today = dm_config.to_israel(now).date()
    collection = {"ran_today": bool(days) and days[0].day == il_today, "last_days": [
        {"day": d.day.isoformat(), "new_jobs": (d.summary or {}).get("new_total"),
         "linkedin_jobs": ((d.summary or {}).get("linkedin") or {}).get("jobs"),
         "linkedin_problem": ((d.summary or {}).get("linkedin") or {}).get("blocked"),
         "apify_credit_left_usd": (((d.summary or {}).get("linkedin") or {}).get("credit") or {}).get("left_usd"),
         "error": (d.summary or {}).get("extra_error")} for d in days]}

    # Server failures, last 7 days, grouped
    errs = (await db.execute(select(AppError).where(AppError.at >= week).order_by(AppError.at.desc()))).scalars().all()
    groups: dict[tuple, dict] = {}
    for e in errs:
        k = (e.kind, e.route, e.status, (e.detail or "")[:120])
        g = groups.setdefault(k, {"kind": e.kind, "route": e.route, "status": e.status, "detail": k[3],
                                  "count": 0, "last": _as_utc(e.at).strftime("%Y-%m-%d %H:%M")})
        g["count"] += 1
    errors = {"total_last_7_days": len(errs), "groups": sorted(groups.values(), key=lambda g: -g["count"])[:30]}

    health = {"generated_utc": now.strftime("%Y-%m-%d %H:%M"), "subscribers": subscribers, "ai_cost": ai,
              "daily_matches": decks, "collection": collection, "server_errors": errors}
    health["report_text"] = report_text(health)
    return health


def report_text(h: dict) -> str:
    """The plain-text report the admin copies and pastes to Claude."""
    s, ai, dm, col, err = h["subscribers"], h["ai_cost"], h["daily_matches"], h["collection"], h["server_errors"]
    lines = [f"JMA system report — {h['generated_utc']} UTC",
             f"Paying: {s['paying_total']} {s['paying_by_plan']} | cancelling {s['cancelling']} | "
             f"new this month {s['new_this_month']} | active 7d {s['active_last_7_days']}",
             f"AI cost this month: ${ai['month_usd']} (features {ai['features_usd']}, daily matches "
             f"${ai['daily_matches_usd']}) | per paying user: {ai['per_paying_user_usd']}",
             f"Decks 7d: {dm['built_last_7_days']} built, {dm['failed_last_7_days']} failed {dm['failures_by_reason']} "
             f"| free trials used: {dm['free_trials_used']}",
             f"Collection ran today: {col['ran_today']}"]
    for d in col["last_days"]:
        lines.append(f"  {d['day']}: new {d['new_jobs']}, linkedin {d['linkedin_jobs']}"
                     f"{' (' + str(d['linkedin_problem']) + ')' if d['linkedin_problem'] else ''}, "
                     f"apify left ${d['apify_credit_left_usd']}{', ERROR ' + str(d['error']) if d['error'] else ''}")
    lines.append(f"Server errors 7d: {err['total_last_7_days']}")
    for g in err["groups"]:
        lines.append(f"  {g['count']}x {g['kind']} {g['status'] or ''} {g['route']} (last {g['last']})"
                     f"{': ' + g['detail'] if g['detail'] else ''}")
    return "\n".join(lines)
