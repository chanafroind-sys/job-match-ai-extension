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
# Haiku 5.5 (from 2026-10-08; Haiku 4.5 before): far stronger than 4.5 at a
# tenth of its per-token price. Its ID has no date suffix. Never a claude-3-5-*
# ID: those are retired and one already broke V2's semantic map silently. V1
# (main.py) keeps its own model choice.
LLM_MODEL = "claude-haiku-5-5"
# Reading a PDF CV into text: a transcription, which needs no thinking (Haiku
# 5.5 thinks by default on a free-form answer) and runs once per uploaded file.
CV_EXTRACT_MODEL = "claude-haiku-4-5-20251001"
# A cap, not a charge. Haiku 5.5's tokenizer counts ~30% more tokens for the same text.
LLM_MAX_TOKENS = 1600
# Only when the API refuses a forced tool call: the answer then may think first,
# and thinking counts against max_tokens.
LLM_MAX_TOKENS_AUTO = 4000
LLM_CONCURRENCY = _int("DM_LLM_CONCURRENCY", 40)  # server-wide, all runs together
CACHE_MIN_TOKENS = 1024  # Haiku 5.5 caches prefixes of 512+ tokens; the rubric alone is ~4K
# A cache entry becomes readable only once the first response starts, so the
# other calls wait this long after the first one is sent.
WARMUP_DELAY_S = 1.2
# A second model that admins' runs also ask, so its verdict shows next to the
# main one on each card. Empty: off. For deciding whether a pricier model is
# worth it, on real decks.
COMPARE_MODEL = (os.getenv("DM_COMPARE_MODEL", "") or "").strip()

# ── Comparing a cheaper non-Anthropic model (through OpenRouter) ──────────────
# DM_COMPARE_MODEL=openrouter:<OpenRouter model id>, for example
# openrouter:deepseek/deepseek-v4.1-flash, plus DM_OPENROUTER_KEY. Only hosts
# that keep nothing and train on nothing are used (OpenRouter's ZDR and
# data_collection=deny), and never the providers in DM_OPENROUTER_IGNORE:
# by default DeepSeek's own servers, which process in China.
OPENROUTER_PREFIX = "openrouter:"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_KEY = (os.getenv("DM_OPENROUTER_KEY", "") or "").strip()
OPENROUTER_IGNORE = tuple(p.strip() for p in (os.getenv("DM_OPENROUTER_IGNORE", "deepseek") or "").split(",") if p.strip())
# Empty: the model's default. Otherwise an effort (none, low, medium, high);
# reasoning is billed as output.
OPENROUTER_REASONING = (os.getenv("DM_OPENROUTER_REASONING", "") or "").strip().lower()
OPENROUTER_CONCURRENCY = _int("DM_OPENROUTER_CONCURRENCY", 10)
OPENROUTER_TIMEOUT_S = 90.0

# ── Matching ──────────────────────────────────────────────────────────────────
# A deck holds only jobs published in the last FRESH_WINDOW that this person
# was never shown or analyzed for: for a daily user, the last day's jobs.
FRESH_WINDOW = timedelta(days=3)
MAX_ANALYZED = _int("DM_MAX_ANALYZED", 40)  # LLM calls per run; the cost cap
MIN_PER_CV = 3  # each CV version is guaranteed this many of the analyzed slots
STRONG_SCORE = _int("DM_STRONG_SCORE", 70)  # the deck
MAYBE_SCORE = _int("DM_MAYBE_SCORE", 60)  # shown after the strong ones, marked "worth a look"
ACTIVE_WINDOW = timedelta(hours=48)  # same "still open" rule as app/routes/jobs.py
RUN_STALE_AFTER = timedelta(minutes=6)  # a "running" row older than this is retryable

# What the extension may send as a CV version's focus: the pool's own categories.
CATEGORIES = ("Backend", "Frontend", "Full Stack", "DevOps", "Mobile", "Data", "AI / ML",
              "QA", "Security", "Embedded", "Hardware")
# Experience level → job seniorities left out. Unknown seniority always stays in.
LEVEL_EXCLUDES = {
    "junior": ("Senior",),
    "mid": (),
    "senior": ("Junior",),
    "lead": ("Junior", "Mid"),
}

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

# List prices, USD per million tokens (input, output, cache read, cache write)
# — for the admin cost report only.
PRICES = {
    "claude-haiku-4-5-20251001": (1.00, 5.00, 0.10, 1.25),
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),  # prompts up to 100K tokens (ours are ~10K)
    "claude-sonnet-5-5": (2.00, 10.00, 0.20, 2.50),
}
PRICE_IN, PRICE_OUT, PRICE_CACHE_READ, PRICE_CACHE_WRITE = PRICES[LLM_MODEL]


def usage_cost(usage: dict, model: str = LLM_MODEL) -> float:
    if usage.get("cost_usd") is not None:  # OpenRouter reports what each call cost
        return float(usage["cost_usd"])
    p_in, p_out, p_read, p_write = PRICES.get(model, PRICES[LLM_MODEL])
    return ((usage.get("input_tokens") or 0) * p_in + (usage.get("output_tokens") or 0) * p_out
            + (usage.get("cache_read_tokens") or 0) * p_read
            + (usage.get("cache_write_tokens") or 0) * p_write) / 1_000_000


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


def to_israel(now: datetime | None = None) -> datetime:
    return _to_il(now or utcnow())


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
