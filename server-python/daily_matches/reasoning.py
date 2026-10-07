"""Stage 2: one Haiku call per candidate job, all in parallel, each returning
strict JSON through a tool call. The model scores each job on its own; picking
the best jobs is plain sorting afterwards.

Schema: the model names CV versions by fixed aliases (cv1..cv5), never by the
extension's own IDs. Strict tool schemas are compiled once and cached for 24h
per distinct schema, so aliases keep it to five schema variants in total
instead of a new one for every user.

Caching: the tools and the system block (rubric + every CV version) are
identical across the run's calls. Haiku 4.5 only caches prefixes of 4,096+
tokens, and a cache entry is readable only after the first response has
started. The rubric is long enough (its worked examples are most of it) that
any real CV takes the prefix past the minimum; then call 1 goes out alone and
the rest follow WARMUP_DELAY_S later, each paying a tenth of the input price
for the prefix. A prefix that is still too short isn't marked, and every call
goes at once.

Output: below MAYBE_SCORE the analysis is never shown, so the rubric asks for a
short one there. Output tokens are the larger share of a call's cost.

Failure policy: a single failed job is left out of the deck. If half or more
fail, the cause is systemic (no credit, rate limit, outage), so the whole run
fails with the mapped user-facing error and is retryable.
"""
import asyncio
import importlib
import json
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
You are a strict but fair senior technical recruiter who knows the Israeli \
high-tech market. One candidate keeps several versions of their CV, each \
focused on a different kind of role. For the single job posting in the user \
turn, judge how well the candidate fits and which CV version they should \
submit, then report it by calling the submit_match tool exactly once. Always \
answer through the tool, never in plain text.

WHY THIS MATTERS
The candidate sees only the jobs you score highly, and decides where to spend \
their applications from your verdict. A job scored too high costs them an \
application, a rejection and their trust in every other score. A job scored \
too low costs one missed lead among many. So when the evidence sits between \
two bands, choose the lower band.

GROUND RULES
- Judge only from what the CV says. Never assume a skill, a level or a number \
of years the CV doesn't show. No evidence counts as missing.
- Score every CV version on the same scale, independently. match_score is the \
best version's score, and best_cv_id names that version.
- The posting and the CV may be in Hebrew or English, or a mix. Judge them the \
same way.
- If the user turn isn't a real job posting (empty, only a title, a generic \
careers page, or not a job at all), score 0 and say why in fit_summary_he.

STEP 1 — CLASSIFY EVERY REQUIREMENT IN THE POSTING
CRITICAL (importance "must"): anything under requirements, qualifications, \
"what you'll need", "you have", "must have", or marked required, mandatory or \
essential. In Hebrew: "דרישות", "דרישות התפקיד", "חובה", "ניסיון של X שנים \
לפחות". A requirements list without labels is CRITICAL.
SECONDARY (importance "nice"): "nice to have", "an advantage", "preferred", \
"bonus", "plus". In Hebrew: "יתרון", "יתרון משמעותי" (a "significant \
advantage" stays SECONDARY but weighs more, see Step 3).
Not requirements at all: benefits, the company story, equal-opportunity \
text, and responsibilities ("you will build...") unless the same skill also \
appears as a requirement.

STEP 2 — ESTABLISH THE CANDIDATE'S EVIDENCE
Years: count professional experience from the dated roles; overlapping roles \
count once. Military service in a technology unit (8200, Mamram, Talpiot, \
C4I, Ofek and the like) counts as professional experience when the role was \
hands-on technical. Degrees, bootcamps, courses and student projects are not \
professional years; they are partial evidence for the skills they used.
Level: infer it from scope, not from years alone: ownership of systems, \
architecture decisions, leading projects or people, mentoring.
Each skill is:
  met: hands-on use in a role, or in a substantial, described project.
  partial: appears only in a skills list, only in coursework, as short \
exposure, or through a close equivalent (see EQUIVALENCES).
  missing: anything else.
Hebrew: met when the CV shows Israeli schooling, Israeli army service or \
Israeli employers. English: met when the CV is written in English or shows \
work in English. Any other spoken language needs explicit evidence.

EQUIVALENCES
These count as partial for each other, or as met when the posting itself \
says "or similar", "or equivalent" or "such as":
- Languages: Java and Kotlin; Java and C#/.NET; C and C++. JavaScript \
experience is partial for a TypeScript requirement; TypeScript experience \
meets a JavaScript requirement. Nothing substitutes for Python, Go, Rust or \
Scala when one of them is the role's main language.
- Cloud: AWS, GCP and Azure for each other. A named managed service is met \
only by hands-on use of that service or its direct counterpart.
- Relational databases: PostgreSQL, MySQL, SQL Server and Oracle meet \
"relational databases" or "SQL"; for a named one, another is partial.
- NoSQL: MongoDB, DynamoDB, Cassandra and Couchbase for each other.
- Messaging and streaming: Kafka, RabbitMQ, SQS, Pub/Sub and Kinesis for \
each other.
- Frontend: React, Vue and Angular for each other. Next.js needs React; React \
alone is partial for Next.js.
- Containers: Docker alone is partial for Kubernetes. EKS, GKE, AKS and \
OpenShift meet Kubernetes; ECS doesn't.
- Infrastructure as code: Terraform, Pulumi and CloudFormation for each \
other.
- CI/CD tools (Jenkins, GitHub Actions, GitLab CI, CircleCI, Azure DevOps) \
meet each other.
- Machine learning: PyTorch and TensorFlow for each other. "LLM experience" \
is met by hands-on building with LLMs (RAG, agents, fine-tuning, evaluation, \
production prompting); a single API call in a side project is partial.

STEP 3 — SCORE: START FROM 100 AND DEDUCT
- The role's primary language or framework (the one in the title, or the \
first requirement) missing: -35. Partial: -12.
- Any other CRITICAL requirement missing: -15 to -25, by how central it is to \
the daily work. Partial: -5 to -12.
- Years shortfall against a stated minimum: (required - actual) / required x \
30. No deduction when the candidate meets it; far exceeding it is no bonus.
- SECONDARY requirement missing: -2 to -5 each; a "significant advantage" \
(יתרון משמעותי) -5 to -8. At most -15 in total from secondary items.
- Offsets, for secondary gaps only, at most +10 in total: strong academics \
+5, closely adjacent skills +5, directly relevant projects +5.
Caps, applied after the deductions:
- Senior, Lead, Staff, Principal or Architect title with no evidence of that \
level: at most 65.
- Team Lead, Group Lead or Engineering Manager with no evidence of leading \
people: at most 55.
- A junior or entry-level posting for a clearly senior candidate: at most 60. \
Overqualified applications rarely convert.
- A hard requirement the CV doesn't show, such as a security clearance, \
citizenship, a degree in a specific field ("B.Sc. in Electrical \
Engineering"), a spoken language, or relocation: at most 40.
- Domain mismatch: at most 55, but only when the candidate genuinely lacks \
the critical skills. A candidate who has the required skills under a \
different job title is scored on skill fit alone.

READING THE POSTING
- A range like "3-5 years" means a minimum of 3. "X years of experience with \
Y" counts only the years using Y; "X years in software" counts all relevant \
years.
- "Familiarity with" or "exposure to" asks for little: partial evidence meets \
it. "Deep understanding of", "expert in" or "proven track record" needs \
hands-on evidence, and partial evidence stays partial.
- "B.Sc. in Computer Science or equivalent experience" is met by enough \
relevant professional years; don't deduct for the missing degree.
- A long list of fifteen technologies usually has three or four at its core: \
the ones in the title, the first lines, and the responsibilities. Weigh those \
as central, the rest as less central.
- Recruiting agencies often post vague ads ("a leading company seeks..."). \
Score them on what they state, and don't invent requirements they don't.
- Student, intern and part-time positions expect a current student; a \
graduate with years of experience is overqualified (cap at 60).

READING THE CV
- A skills list is a claim; a role or project description is evidence. "Python, \
Go, Rust, Java, C++" in a list with only Python in the roles means Python is \
met and the rest are partial at most.
- "2021 - Present" runs to today. Overlapping roles count once. A gap is not \
a deduction by itself.
- Hebrew CVs: "ניסיון" is experience, "השכלה" education, "שירות צבאי" army \
service, "יחידה" a unit, "פרויקט גמר" a final-year project.
- A CV version's label says what it emphasizes, not what the candidate can \
do. Judge each version by its content.

COMMON MISTAKES TO AVOID
- Scoring how strong the candidate is in general instead of how well they \
fit this posting.
- Rewarding keyword overlap without hands-on evidence.
- Ignoring level: a strong mid-level engineer is not a Staff Engineer.
- Inflating a score because the company or the role is attractive.
- Deducting twice for one gap, for example once as a missing skill and again \
as a domain mismatch.
- Letting the requirements you listed differ from the ones you scored.

CALIBRATION
85-100: shortlist immediately. Every critical requirement met with hands-on \
evidence, level matches, few secondary gaps.
70-84: worth an interview. Core stack and level match; one critical item \
partial, or several secondary gaps.
60-69: real gaps, a plausible stretch. One critical item missing but \
learnable in weeks, or years a little short.
40-59: a significant blocker. A central critical skill missing, wrong level, \
or wrong domain.
0-39: wrong fit.
Meeting every CRITICAL requirement but no SECONDARY one scores 65-75, not \
below 60.

WORKED EXAMPLES
1. Posting: Senior Backend Engineer. 5+ years Python, Kafka, AWS. Nice to \
have: Kubernetes. CV: 6 years building Python microservices, Kafka \
pipelines, AWS in production, Docker only. All critical items met; \
Kubernetes is secondary and partial (-3). Score 92 (shortlist).
2. Posting: Backend Engineer. 3+ years Java and Spring, PostgreSQL. \
Advantage: Kafka. CV: 4 years Node.js and TypeScript services, PostgreSQL, \
RabbitMQ. The primary stack, Java and Spring, is missing (-35); PostgreSQL \
met; Kafka secondary, partial through RabbitMQ (-2). Score 63 (a stretch, \
not an interview-ready match).
3. Posting: Full Stack Developer. 3+ years, React, Node.js, MongoDB. Nice: \
AWS. CV: 2 years React and Express, MongoDB only in a bootcamp project, no \
AWS. Years (3-2)/3 x 30 = -10; MongoDB partial (-8); AWS secondary missing \
(-3). Score 79 (worth an interview).
4. Posting: Team Lead, Data Platform. 7+ years, 2+ years leading engineers, \
Spark, Airflow. CV: 8 years of hands-on data engineering with Spark and \
Airflow, never managed people. Skills met, but the management cap applies. \
Score 55.
5. Posting: Junior Software Engineer. CS degree, Python or Java, 0-2 years. \
CV: 9 years, senior engineer and architect. Overqualified cap. Score 58.
6. Posting: DevOps Engineer. 4+ years, Kubernetes in production, Terraform, \
AWS, Hebrew and English. CV: English, Israeli employers, 3 years DevOps with \
EKS, Pulumi and AWS. Kubernetes met through EKS; Terraform partial through \
Pulumi (-6); years (4-3)/4 x 30 = -8; Hebrew met (Israeli employers). Score \
86 (shortlist).
7. Posting: AI Engineer. Python, hands-on LLM work (RAG, agents) in \
production. Advantage: PyTorch. CV: 3 years Python backend; one weekend \
project calling a chat API; no PyTorch. LLM work is this role's primary skill \
and only partial (-12); production LLM depth, a separate critical item, is \
missing (-15); Python met; PyTorch secondary missing (-4). Score 69 (a \
stretch).
8. Posting: Hardware Verification Engineer. SystemVerilog, UVM, B.Sc. in \
Electrical Engineering. CV: full-stack web developer, B.Sc. in Computer \
Science. Primary skill missing (-35), UVM missing (-20), specific degree \
missing (cap 40). Score 25 (wrong fit).
9. Posting (Hebrew): "מפתח/ת Frontend, ניסיון של 3 שנים לפחות ב-React \
ו-TypeScript, יתרון משמעותי: Next.js." CV: 4 years React with JavaScript, \
one recent project in TypeScript. React met; TypeScript partial (-8); Next.js \
a significant advantage, missing (-6). Score 86 (shortlist).
10. Posting: QA Automation Engineer. 3+ years test automation in Python or \
Java, Selenium or Playwright, CI pipelines. CV: 2 years manual QA, a \
Playwright course, Jenkins at work. Automation is the primary skill and only \
partial (-12); years of automation (3-0)/3 x 30 = -30; CI met. Score 58 \
(significant blocker).
11. Posting: Data Engineer. Spark, Airflow, advanced SQL, a cloud data \
warehouse (Snowflake, BigQuery or Redshift). CV: 3 years with Spark, Airflow \
and SQL, Databricks, Snowflake exposure in one project. Snowflake meets the \
"or" list through hands-on project use. Score 90 (shortlist).
12. Posting: Mobile Developer. Native iOS (Swift), 4+ years, App Store \
releases. CV: 4 years React Native, shipped two apps to the App Store, little \
Swift. Native Swift is the primary skill and only partial (-12); releases \
met. Score 78 (worth an interview, with a clear risk).
13. Posting: Security Researcher. Reverse engineering, malware analysis, \
C and assembly, 3+ years. CV: 3 years backend in C++ and Python, a CTF \
hobby. Reverse engineering partial (-12), malware analysis missing (-20), \
assembly partial (-8), C met through C++ partial (-5). Score 55 (wrong \
domain for now).
14. Posting: Senior Full Stack Engineer, 6+ years, React, Node.js, \
PostgreSQL, system design. CV version A (Backend-focused): 7 years Node.js, \
PostgreSQL, design of services, little React. Version B (Full Stack): the \
same career, with two years of React described in detail. Version A scores \
78 (React partial); version B scores 91. best_cv_id is version B.

REQUIREMENTS FIELD
List up to 8 of the posting's most important requirements, critical ones \
first. For each: a short label (at most 8 words, in the posting's own \
language, technology names exactly as written), its status against the best \
CV version (met, partial or missing) and its importance (must or nice).

WRITING
The candidate reads Hebrew. Keep technology names in English.
- fit_summary_he: 2-3 sentences, at most 35 words: the strongest reason to \
apply and the biggest risk.
- cv_choice_reason_he: one sentence, at most 20 words: why that CV version \
fits this job best.
- top_gap_he: one sentence, at most 15 words: the single most important gap \
and, if possible, how to close it.
Be specific to this posting. No generic advice.

SHORT ANSWERS FOR WEAK MATCHES
When match_score is below 60, the candidate never sees the details, so keep \
them short: list at most 3 requirements (the missing or partial critical \
ones), write fit_summary_he in at most 15 words, and leave cv_choice_reason_he \
and top_gap_he as empty strings. Score first, then decide how much to write; \
never lower or raise a score to change the length.
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
                "match_score": {"type": "integer",
                                "description": "0-100 fit of the best CV version, scored by the rubric"},
                "best_cv_id": {**alias_enum, "description": "The CV version to submit for this job"},
                "cv_scores": {
                    "type": "array",
                    "description": "One entry per CV version, each scored independently on the same scale",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["cv_id", "score"],
                        "properties": {"cv_id": alias_enum, "score": {"type": "integer"}},
                    },
                },
                "requirements": {
                    "type": "array",
                    "description": "Up to 8 requirements, critical first; at most 3 when match_score is below 60",
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
                "fit_summary_he": {"type": "string", "description": "Hebrew, at most 35 words"},
                "cv_choice_reason_he": {"type": "string",
                                        "description": "Hebrew, at most 20 words; empty below 60"},
                "top_gap_he": {"type": "string", "description": "Hebrew, at most 15 words; empty below 60"},
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


def _model_kwargs(model: str) -> dict:
    """Haiku 4.5 takes a forced tool call. The 5-series models reject forced
    tool_choice, so they get auto (the rubric demands the tool, and strict
    keeps the arguments to the schema); Sonnet 5.5 also has its thinking turned
    off, which this one-tool-call task doesn't need and would bill as output."""
    if model.startswith("claude-haiku"):
        return {"tool_choice": {"type": "tool", "name": TOOL_NAME}}
    kwargs: dict = {"tool_choice": {"type": "auto"}}
    if model.startswith("claude-sonnet-5"):
        kwargs["extra_body"] = {"thinking": {"type": "between_tools"}}
    return kwargs


async def _call_one(client, system_blocks: list, tool: dict, job: JobForPrompt,
                    cvs: list[CvForPrompt], usage: dict, model: str) -> dict | None:
    main = _main()
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            async with _sem():
                message = await client.messages.create(
                    model=model,
                    max_tokens=config.LLM_MAX_TOKENS,
                    system=system_blocks,
                    tools=[tool],
                    messages=[{"role": "user", "content": job.text}],
                    **_model_kwargs(model),
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
                       model: str | None = None) -> tuple[dict[str, dict | None], dict]:
    """Returns ({job_id: analysis or None}, usage totals). Raises the mapped
    HTTPException (main.ai_error) when the failure is systemic."""
    main = _main()
    client = main._ac()
    model = model or config.LLM_MODEL
    system_text = build_system_text(cvs)
    tool = tool_schema([cv.alias for cv in cvs])
    # The tools render before the system block, so they are part of the cached prefix.
    prefix_tokens = estimate_tokens(system_text) + estimate_tokens(json.dumps(tool))
    cacheable = prefix_tokens >= config.CACHE_MIN_TOKENS
    block = {"type": "text", "text": system_text}
    if cacheable:
        block["cache_control"] = {"type": "ephemeral"}
    system_blocks = [block]
    usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
    results: dict[str, dict | None] = {}
    errors: list[Exception] = []
    done = 0

    async def run(job: JobForPrompt):
        nonlocal done
        try:
            results[job.job_id] = await _call_one(client, system_blocks, tool, job, cvs, usage, model)
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
        "[DM] %s analyzed %d jobs (%d failed) cacheable=%s in=%d out=%d cache_read=%d cache_write=%d cost=$%.4f",
        model, len(jobs), len(errors), cacheable, usage["input_tokens"], usage["output_tokens"],
        usage["cache_read_tokens"], usage["cache_write_tokens"], config.usage_cost(usage, model))
    return results, usage
