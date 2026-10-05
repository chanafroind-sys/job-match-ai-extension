"""Stage 2: one Haiku call per candidate job, all in parallel, each returning
strict JSON through a forced tool call.

Schema: the model names CV versions by fixed aliases (cv1..cv5), never by the
extension's own IDs. Strict tool schemas are compiled once and cached for 24h
per distinct schema, so aliases keep it to five schema variants in total
instead of a new one for every user.

Caching: the system block (rubric + every CV version) is identical across the
run's calls. Haiku 4.5 only caches prefixes of 4,096+ tokens, and a cache entry
is readable only after the first response has started. So when the prefix is
long enough, call 1 goes out alone and the rest follow WARMUP_DELAY_S later;
when it isn't, all calls go at once and nothing is marked for caching.

Failure policy: a single failed job becomes a card without analysis. If half
or more fail, the cause is systemic (no credit, rate limit, outage), so the
whole run fails with the mapped user-facing error and is retryable.
"""
import asyncio
import importlib
import logging
import weakref
from dataclasses import dataclass
from typing import Awaitable, Callable

from pydantic import BaseModel, ValidationError

from daily_matches import config
from daily_matches.text_prep import estimate_tokens

logger = logging.getLogger(__name__)

TOOL_NAME = "submit_match"
MAX_REQUIREMENTS = 8
# One server-wide cap on in-flight calls, so a morning burst of runs queues
# here instead of tripping the account's rate limit. Keyed by event loop
# because an asyncio.Semaphore can't be shared across loops.
_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _sem() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    sem = _semaphores.get(loop)
    if sem is None:
        sem = _semaphores[loop] = asyncio.Semaphore(config.LLM_CONCURRENCY)
    return sem


def _main():
    return importlib.import_module("main")


@dataclass
class CvForPrompt:
    alias: str   # cv1..cv5 — what the model sees
    ref: str     # the extension's own ID — what the card stores
    label: str
    text: str    # normalized, contacts redacted


@dataclass
class JobForPrompt:
    job_id: str
    text: str


RUBRIC = """\
You are a strict but fair senior hiring manager. One candidate keeps several \
versions of their CV. For the single job posting in the user turn, judge how \
well the candidate fits and which CV version they should submit, then report \
it by calling the submit_match tool exactly once.

SCORING — score every CV version on the same scale; match_score is the best one.
STEP 1 — classify every requirement in the posting:
  CRITICAL (importance "must") = "must", "required", "mandatory", or listed in the main requirements section
  SECONDARY (importance "nice") = "nice to have", "preferred", "advantage", "bonus", or a lower-priority section
STEP 2 — start from 100 and deduct:
  Missing CRITICAL requirement: -15 to -25 per item (proportional to how central it is)
  Partial or only theoretical on a CRITICAL item: -5 to -12
  Years shortfall: (required - actual) / required x 30 points
  Seniority mismatch (Senior/Lead/Staff title with no evidence of that level): cap at 65
  Missing SECONDARY item: -2 to -5 each, never more than -5 each
  Offsets for secondary gaps only: strong academics +5, closely adjacent skills +5, relevant projects +5
DOMAIN MISMATCH: cap at 55 ONLY when the candidate genuinely lacks the critical \
skills. A candidate with the required skills but a different job-title \
background is scored on skill fit alone.
CALIBRATION: 85+ shortlist immediately | 70-84 worth an interview | 55-69 real \
gaps | 40-54 significant blocker | below 40 wrong fit. Meeting every CRITICAL \
requirement but no SECONDARY one scores 65-75, not below 55.

REQUIREMENTS: list up to 8 of the posting's most important requirements, \
CRITICAL ones first. For each give a short label (at most 8 words, in the \
posting's own language, technology names exactly as written), its status \
against the best CV version (met | partial | missing) and its importance \
(must | nice). Judge only from what the CV actually says; never assume a skill \
that isn't there.

WRITING: the candidate reads Hebrew. Keep technology names in English.
  fit_summary_he: 2-3 sentences, at most 35 words: the strongest reason to apply and the biggest risk.
  cv_choice_reason_he: one sentence, at most 20 words: why that CV version fits this job best.
  top_gap_he: one sentence, at most 15 words: the single most important gap and, if possible, how to address it.
Be specific to this posting. No generic advice.
"""


def build_system_text(cvs: list[CvForPrompt]) -> str:
    parts = [RUBRIC, "\nCANDIDATE CV VERSIONS (contact details removed):"]
    for cv in cvs:
        parts.append(f'\n=== {cv.alias} · label: "{cv.label}" ===\n{cv.text}\n=== end of {cv.alias} ===')
    return "\n".join(parts)


def tool_schema(aliases: list[str]) -> dict:
    alias_enum = {"type": "string", "enum": list(aliases)}
    return {
        "name": TOOL_NAME,
        "description": "Record the fit analysis for this job posting. Call exactly once.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["match_score", "best_cv_id", "cv_scores", "requirements",
                         "fit_summary_he", "cv_choice_reason_he", "top_gap_he"],
            "properties": {
                "match_score": {"type": "integer", "description": "0-100 fit of the best CV version"},
                "best_cv_id": alias_enum,
                "cv_scores": {
                    "type": "array",
                    "description": "One entry per CV version",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["cv_id", "score"],
                        "properties": {"cv_id": alias_enum, "score": {"type": "integer"}},
                    },
                },
                "requirements": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["text", "status", "importance"],
                        "properties": {
                            "text": {"type": "string"},
                            "status": {"type": "string", "enum": ["met", "partial", "missing"]},
                            "importance": {"type": "string", "enum": ["must", "nice"]},
                        },
                    },
                },
                "fit_summary_he": {"type": "string"},
                "cv_choice_reason_he": {"type": "string"},
                "top_gap_he": {"type": "string"},
            },
        },
    }


class _Requirement(BaseModel):
    text: str
    status: str
    importance: str


class _CvScore(BaseModel):
    cv_id: str
    score: int


class _RawAnalysis(BaseModel):
    match_score: int
    best_cv_id: str
    cv_scores: list[_CvScore] = []
    requirements: list[_Requirement] = []
    fit_summary_he: str = ""
    cv_choice_reason_he: str = ""
    top_gap_he: str = ""


def _clamp(n: int) -> int:
    return max(0, min(100, int(n)))


def normalize_analysis(raw: dict, cvs: list[CvForPrompt]) -> dict | None:
    """Validated, clamped analysis keyed by the extension's CV IDs, or None.
    Strict mode guarantees the shape; this enforces what JSON Schema can't
    (score range, list length, an alias that exists)."""
    try:
        parsed = _RawAnalysis.model_validate(raw)
    except ValidationError:
        return None
    by_alias = {cv.alias: cv for cv in cvs}
    scores = {s.cv_id: _clamp(s.score) for s in parsed.cv_scores if s.cv_id in by_alias}
    best = parsed.best_cv_id if parsed.best_cv_id in by_alias else (
        max(scores, key=scores.get) if scores else cvs[0].alias)
    match = _clamp(parsed.match_score)
    scores[best] = max(scores.get(best, match), match)
    reqs = [
        {"text": r.text.strip()[:120], "status": r.status, "importance": r.importance}
        for r in parsed.requirements
        if r.text.strip() and r.status in ("met", "partial", "missing") and r.importance in ("must", "nice")
    ]
    reqs.sort(key=lambda r: 0 if r["importance"] == "must" else 1)  # stable: keeps the model's order within a group
    return {
        "match_score": match,
        "best_cv_ref": by_alias[best].ref,
        "cv_scores": [
            {"cv_id": cv.ref, "label": cv.label, "score": scores[cv.alias]}
            for cv in cvs if cv.alias in scores
        ],
        "requirements": reqs[:MAX_REQUIREMENTS],
        "fit_summary_he": parsed.fit_summary_he.strip()[:400],
        "cv_choice_reason_he": parsed.cv_choice_reason_he.strip()[:250],
        "top_gap_he": parsed.top_gap_he.strip()[:250],
    }


def _usage_of(message) -> dict:
    usage = getattr(message, "usage", None)
    return {
        "input_tokens": getattr(usage, "input_tokens", 0) or 0,
        "output_tokens": getattr(usage, "output_tokens", 0) or 0,
        "cache_read_tokens": getattr(usage, "cache_read_input_tokens", 0) or 0,
        "cache_write_tokens": getattr(usage, "cache_creation_input_tokens", 0) or 0,
    }


async def _call_one(client, system_blocks: list, tool: dict, job: JobForPrompt,
                    cvs: list[CvForPrompt], usage: dict) -> dict | None:
    main = _main()
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            async with _sem():
                message = await client.messages.create(
                    model=config.LLM_MODEL,
                    max_tokens=config.LLM_MAX_TOKENS,
                    system=system_blocks,
                    tools=[tool],
                    tool_choice={"type": "tool", "name": TOOL_NAME},
                    messages=[{"role": "user", "content": job.text}],
                )
            for key, value in _usage_of(message).items():
                usage[key] += value
            if getattr(message, "stop_reason", "") == "max_tokens":
                logger.warning("[DM] job %s: output hit max_tokens", job.job_id)
                return None
            block = next((b for b in message.content
                          if getattr(b, "type", "") == "tool_use" and getattr(b, "name", "") == TOOL_NAME), None)
            if block is None:
                return None
            return normalize_analysis(dict(block.input), cvs)
        except Exception as exc:  # noqa: BLE001 — classified below
            last_exc = exc
            if not main._retryable(exc) or attempt == 1:
                break
            await _retry_pause()
    raise last_exc  # type: ignore[misc]


async def _retry_pause() -> None:
    await asyncio.sleep(1.5)


async def analyze_jobs(cvs: list[CvForPrompt], jobs: list[JobForPrompt],
                       on_progress: Callable[[int, int], Awaitable[None] | None] | None = None,
                       ) -> tuple[dict[str, dict | None], dict]:
    """Returns ({job_id: analysis or None}, usage totals). Raises the mapped
    HTTPException (main.ai_error) when the failure is systemic."""
    main = _main()
    client = main._ac()
    system_text = build_system_text(cvs)
    cacheable = estimate_tokens(system_text) >= config.CACHE_MIN_TOKENS
    block = {"type": "text", "text": system_text}
    if cacheable:
        block["cache_control"] = {"type": "ephemeral"}
    system_blocks = [block]
    tool = tool_schema([cv.alias for cv in cvs])
    usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
    results: dict[str, dict | None] = {}
    errors: list[Exception] = []
    done = 0

    async def run(job: JobForPrompt):
        nonlocal done
        try:
            results[job.job_id] = await _call_one(client, system_blocks, tool, job, cvs, usage)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[DM] job %s analysis failed: %s: %s", job.job_id, type(exc).__name__, exc)
            errors.append(exc)
            results[job.job_id] = None
        done += 1
        if on_progress:
            maybe = on_progress(done, len(jobs))
            if asyncio.iscoroutine(maybe):
                await maybe

    if not jobs:
        return results, usage
    first = asyncio.create_task(run(jobs[0]))
    if cacheable and len(jobs) > 1:
        await asyncio.wait({first}, timeout=config.WARMUP_DELAY_S)
    rest = [asyncio.create_task(run(job)) for job in jobs[1:]]
    await asyncio.gather(first, *rest)

    if errors and len(errors) * 2 >= len(jobs):
        raise main.ai_error(errors[0])
    logger.warning(
        "[DM] analyzed %d jobs (%d failed) cacheable=%s in=%d out=%d cache_read=%d cache_write=%d",
        len(jobs), len(errors), cacheable, usage["input_tokens"], usage["output_tokens"],
        usage["cache_read_tokens"], usage["cache_write_tokens"])
    return results, usage
