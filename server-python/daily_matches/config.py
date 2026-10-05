"""Daily Matches settings. Every tunable lives here; the ones worth changing in
production read an environment variable so Render can adjust them without a
code change."""
import os
from datetime import date, datetime, timedelta, timezone


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def mode() -> str:
    """Rollout switch, read on every call.

    off    — default. The status endpoint reports disabled and nothing runs.
    admins — only licenses in ADMIN_KEYS can use it, for testing in production.
    on     — everyone (subscribers, plus the one free trial).
    """
    raw = (os.getenv("DAILY_MATCHES_ENABLED", "") or "").strip().lower()
    if raw in ("1", "true", "on", "yes", "all"):
        return "on"
    if raw in ("admin", "admins"):
        return "admins"
    return "off"


# ── Embeddings (Voyage AI — Anthropic has no embedding model) ─────────────────
VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
EMBED_MODEL = os.getenv("DM_EMBED_MODEL", "voyage-4")
EMBED_DIM = 1024  # must match vector(1024) in the migration
# Stored on every vector row. Changing the model or dimension makes every
# stored vector stale, and the embedding job then re-embeds the pool.
EMBED_TAG = f"{EMBED_MODEL}/{EMBED_DIM}"
EMBED_BATCH_TEXTS = 64
EMBED_BATCH_CHARS = 200_000  # voyage-4 accepts 120K tokens per request; Hebrew runs ~2 chars/token

# ── Stage 2 (LLM) ─────────────────────────────────────────────────────────────
# Same ID main.py resolves "haiku" to. Never a claude-3-5-* ID: those are retired
# and one already broke V2's semantic map silently.
LLM_MODEL = "claude-haiku-4-5-20251001"
LLM_MAX_TOKENS = 1200
LLM_CONCURRENCY = _int("DM_LLM_CONCURRENCY", 40)  # server-wide, all runs together
CACHE_MIN_TOKENS = 4096  # Haiku 4.5 silently skips caching shorter prefixes
# A cache entry becomes readable only once the first response starts, so the
# other calls wait this long after the first one is sent.
WARMUP_DELAY_S = 1.2

# ── Matching ──────────────────────────────────────────────────────────────────
TOP_K = _int("DM_TOP_K", 15)
MIN_PER_CV = 3  # each CV version is guaranteed this many of the TOP_K slots
MIN_DISPLAY_SCORE = _int("DM_MIN_SCORE", 50)
MIN_CARDS = 5  # below this many passing cards, the best of the rest are shown
ACTIVE_WINDOW = timedelta(hours=48)  # same "still open" rule as app/routes/jobs.py
NEW_JOB_WINDOW = timedelta(days=3)
RUN_STALE_AFTER = timedelta(minutes=6)  # a "running" row older than this is retryable

# ── Free trial ────────────────────────────────────────────────────────────────
TRIAL_IP_MAX = _int("DM_TRIAL_IP_MAX", 3)
TRIAL_IP_WINDOW = timedelta(days=30)
TRIAL_DAILY_BUDGET = _int("DM_TRIAL_DAILY_BUDGET", 200)  # server-wide trials per day
TRIAL_RESERVATION_TTL = timedelta(minutes=10)

# ── Input limits ──────────────────────────────────────────────────────────────
MAX_CV_VERSIONS = 5
MAX_CV_CHARS = 30_000
MIN_CV_CHARS = 200
MAX_PDF_BYTES = 5 * 1024 * 1024

# ── Retention ─────────────────────────────────────────────────────────────────
RESULTS_RETENTION = timedelta(days=30)
CV_EMBED_RETENTION = timedelta(days=90)

# Salt for hashing install IDs and IPs. Changing it orphans every recorded
# trial, which would hand everyone a second one, so set it once and keep it.
HASH_SALT = os.getenv("DM_HASH_SALT", "jma-daily-matches-v1")

# Haiku 4.5 list prices, USD per million tokens — for the admin cost report only.
PRICE_IN, PRICE_OUT, PRICE_CACHE_READ, PRICE_CACHE_WRITE = 1.00, 5.00, 0.10, 1.25


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; everything here is UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _last_sunday(year: int, month: int) -> date:
    first_next = date(year + (month == 12), month % 12 + 1, 1)
    last = first_next - timedelta(days=1)
    return last - timedelta(days=(last.weekday() + 1) % 7)


def _il_offset(utc_dt: datetime) -> timedelta:
    """Israel's UTC offset by rule, for hosts without a tz database (Windows
    without tzdata, slim containers). DST runs from the Friday before the last
    Sunday of March, 02:00 local, to the last Sunday of October, 02:00 local."""
    year = utc_dt.year
    start_day = _last_sunday(year, 3) - timedelta(days=2)
    end_day = _last_sunday(year, 10)
    start = datetime(start_day.year, start_day.month, start_day.day, tzinfo=timezone.utc)  # 02:00 UTC+2
    end = datetime(end_day.year, end_day.month, end_day.day, tzinfo=timezone.utc) - timedelta(hours=1)  # 02:00 UTC+3
    return timedelta(hours=3) if start <= utc_dt < end else timedelta(hours=2)


def _to_il(now: datetime) -> datetime:
    try:
        from zoneinfo import ZoneInfo
        return now.astimezone(ZoneInfo("Asia/Jerusalem"))
    except Exception:  # no tz database on this host
        utc = now.astimezone(timezone.utc)
        offset = _il_offset(utc)
        return utc.astimezone(timezone(offset))


def match_day(now: datetime | None = None) -> date:
    """The quota day: the calendar day in Israel."""
    return _to_il(now or utcnow()).date()


def il_day_start_utc(now: datetime | None = None) -> datetime:
    """UTC instant of the most recent Israel midnight."""
    local = _to_il(now or utcnow())
    midnight_local = local.replace(hour=0, minute=0, second=0, microsecond=0)
    # With a tz database the offset is recomputed for midnight. The rule-based
    # fallback keeps the current offset, which is an hour off only on the two
    # DST switch days, after 02:00.
    return midnight_local.astimezone(timezone.utc)


def next_reset(now: datetime | None = None) -> datetime:
    """The next Israel midnight, when a new run becomes available."""
    nxt = il_day_start_utc(now) + timedelta(days=1, hours=1)  # an hour past, to clear DST edges
    return _to_il(nxt).replace(hour=0, minute=0, second=0, microsecond=0)
