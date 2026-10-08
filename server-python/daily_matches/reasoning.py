"""Stage 2: one Haiku 5.5 call per candidate job, all in parallel, each returning
strict JSON through a tool call. The model scores each job on its own; picking
the best jobs is plain sorting afterwards.

Schema: the model names CV versions by fixed aliases (cv1..cv5), never by the
extension's own IDs. Strict tool schemas are compiled once and cached for 24h
per distinct schema, so aliases keep it to five schema variants in total
instead of a new one for every user.

Caching: the tools and the system block (rubric + every CV version) are
identical across the run's calls. Haiku 5.5 caches prefixes of 512+ tokens
(Haiku 4.5 needed 4,096, which is why the rubric's worked examples are so many;
they stay, for the quality they bring). A cache entry is readable only after
the first response has started, so call 1 goes out alone and the rest follow
WARMUP_DELAY_S later, each paying a tenth of the input price for the prefix. A
prefix that is still too short isn't marked, and every call goes at once.

Output: below MAYBE_SCORE the analysis is never shown, so the rubric asks for a
short one there. Output tokens are the larger share of a call's cost.

Failure policy: a single failed job is left out of the deck. If half or more
fail, the cause is systemic (no credit, rate limit, outage), so the whole run
fails with the mapped user-facing error and is retryable.

A model named openrouter:<id> (admins' comparison only, config.COMPARE_MODEL)
gets the same rubric, CVs and tool schema through OpenRouter's OpenAI-style
API instead, so the two verdicts are comparable.
"""
import asyncio
import importlib
import json
import logging
import weakref
from dataclasses import dataclass
from typing import Awaitable, Callable

import httpx
from pydantic import BaseModel, ValidationError

from daily_matches import config
from daily_matches.text_prep import estimate_tokens

logger = logging.getLogger(__name__)

TOOL_NAME = "submit_match"
MAX_REQUIREMENTS = 10
# The scoring arithmetic (score_of). RUBRIC states the same numbers to the
# model; change them in both places.
MUST_COST = {"primary": (35, 12), "core": (20, 8), "supporting": (12, 5)}  # (missing, partial)
NICE_COST = {"primary": (6, 2), "core": (6, 2), "supporting": (3, 1)}  # a nice item is never primary; treated as core
NICE_COST_MAX = 15
YEARS_WEIGHT = 30  # a shortfall of the whole requirement costs this much
OFFSETS = ("strong_academics", "adjacent_skills", "relevant_projects")
OFFSET_POINTS, OFFSETS_MAX = 5, 10
CAPS = {"level_unproven": 65, "no_people_leadership": 55, "overqualified": 55, "hard_blocker": 40,
        "domain_mismatch": 55, "not_a_job": 0}
NO_REQUIREMENTS_CAP = 65  # a posting that states no must requirement can't be judged as a strong match
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
turn, analyze how the candidate's evidence meets each of the posting's \
requirements and which CV version they should submit, then report it by \
calling the submit_match tool exactly once. Always answer through the tool, \
never in plain text.

WHY THIS MATTERS
The candidate sees only the jobs that come out well, and decides where to \
spend their applications from your analysis. A job that comes out too well \
costs them an application, a rejection and their trust in every other match. \
A job that comes out too low costs one missed lead among many. So when the \
evidence sits between two classifications, choose the less favorable one.

YOU CLASSIFY, ARITHMETIC SCORES
You don't give the score. Fixed arithmetic (below) turns your \
classifications into one, the same way for every job, so two jobs with the \
same gaps always get the same score. Your part is the judgment arithmetic \
can't make: what each requirement is, how central it is to this role, and \
how far the candidate's evidence meets it.

GROUND RULES
- Judge only from what the CV says. Never assume a skill, a level or a number \
of years the CV doesn't show. No evidence counts as missing.
- Classify the requirements against the best CV version. cv_scores rates \
every version on one 0-100 scale, only to compare the versions with each \
other; best_cv_id names the best one.
- The posting and the CV may be in Hebrew or English, or a mix. Judge them the \
same way.

STEP 1 — LIST THE POSTING'S REQUIREMENTS
importance "must": anything under requirements, qualifications, "what \
you'll need", "you have", "must have", or marked required, mandatory or \
essential. In Hebrew: "דרישות", "דרישות התפקיד", "חובה". A requirements list \
without labels is must.
importance "nice": "nice to have", "an advantage", "preferred", "bonus", \
"plus". In Hebrew: "יתרון", "יתרון משמעותי".
Not requirements at all: benefits, the company story, equal-opportunity \
text, and responsibilities ("you will build...") unless the same skill also \
appears as a requirement. Years of experience are not a requirement item: \
they go in years_required.
List every must requirement (up to 10 items in all), then the most important \
nice ones. Never leave out a must requirement because the candidate lacks it. \
Split a line that names separately central skills ("Python and Kafka") into \
separate items; keep alternatives ("Python or Java") as one item.

STEP 2 — WEIGH EACH REQUIREMENT
weight, for a must item:
  primary: the role's main language, framework or discipline: the one in the \
job title, or the first requirement. One per posting, two at most.
  core: used every day in this role; a gap would show in the first weeks.
  supporting: needed, but not central to the daily work.
weight, for a nice item: core only for a "significant advantage" (יתרון \
משמעותי) or a nice-to-have the posting clearly leans on; otherwise \
supporting. Never primary.

STEP 3 — ESTABLISH THE CANDIDATE'S EVIDENCE
Years: count professional experience from the dated roles; overlapping roles \
count once. Military service in a technology unit (8200, Mamram, Talpiot, \
C4I, Ofek and the like) counts as professional experience when the role was \
hands-on technical. Degrees, bootcamps, courses and student projects are not \
professional years; they are partial evidence for the skills they used.
Level: infer it from scope, not from years alone: ownership of systems, \
architecture decisions, leading projects or people, mentoring.
status, for each requirement:
  met: hands-on use in a role, or in a substantial, described project.
  partial: appears only in a skills list, only in coursework, as short \
exposure, or through a close equivalent (see EQUIVALENCES).
  missing: anything else.
A primary item has a higher bar: partial only for a close equivalent or real \
but limited professional use. A course, a toy project or a skills-list \
mention leaves a primary item missing.
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

STEP 4 — YEARS, CAPS AND OFFSETS
years_required: the minimum years of experience the posting asks for, \
overall or in its main discipline; 0 when it states none. A range like "3-5 \
years" means 3.
years_relevant: the candidate's professional years in comparable roles, from \
the best CV version. When the posting ties its years to a skill the \
candidate lacks, still count their years in comparable roles: the missing \
skill already costs its own points, and nothing is counted twice.
caps: every limit that applies, else an empty list:
  level_unproven: a Senior, Lead, Staff, Principal or Architect title, and the \
CV shows no evidence of that level.
  no_people_leadership: a Team Lead, Group Lead or Engineering Manager role, \
and the CV shows no leading of people.
  overqualified: a junior, entry-level, student or intern role for a clearly \
senior candidate. Such applications rarely convert.
  hard_blocker: a security clearance, citizenship, a degree in a specific \
field ("B.Sc. in Electrical Engineering"), a spoken language, or relocation \
that the posting requires and the CV doesn't show.
  domain_mismatch: the candidate lacks the critical skills of this whole \
domain, not just a matching job title. Someone with the required skills under \
a different title is no mismatch.
  not_a_job: the user turn isn't a real job posting (empty, only a title, a \
generic careers page, or not a job at all).
offsets, strengths that make up for nice-to-have gaps only, else an empty \
list: strong_academics, adjacent_skills (closely related skills the posting \
would value), relevant_projects (directly relevant projects).

THE ARITHMETIC (for your understanding; never compute it in your answer)
Start at 100. A must item costs, when missing / partial: primary 35 / 12, \
core 20 / 8, supporting 12 / 5. A nice item costs: core 6 / 2, supporting \
3 / 1, and nice items cost 15 at most in total. A years shortfall costs \
(required - relevant) / required x 30. Each offset gives back 5, at most 10 \
in all, and never more than the nice items cost. Then the lowest applying \
cap limits the result: level_unproven 65, no_people_leadership 55, \
overqualified 55, hard_blocker 40, domain_mismatch 55, not_a_job 0. A \
posting that lists no must requirement is capped at 65. A job shows as a \
match from 70, and as worth a look from 60.
So classify honestly. An item marked partial to be kind, or supporting to \
soften a gap, puts in front of the candidate a job that will waste their \
application.

READING THE POSTING
- "X years of experience with Y" counts only the years using Y; "X years in \
software" counts all relevant years.
- "Familiarity with" or "exposure to" asks for little: partial evidence meets \
it. "Deep understanding of", "expert in" or "proven track record" needs \
hands-on evidence, and partial evidence stays partial.
- "B.Sc. in Computer Science or equivalent experience" is met by enough \
relevant professional years.
- A long list of fifteen technologies usually has three or four at its core: \
the ones in the title, the first lines, and the responsibilities. Those are \
primary or core; the rest supporting.
- Recruiting agencies often post vague ads ("a leading company seeks..."). \
List what they state, and don't invent requirements they don't.

READING THE CV
- A skills list is a claim; a role or project description is evidence. "Python, \
Go, Rust, Java, C++" in a list with only Python in the roles means Python is \
met and the rest are partial at most.
- "2021 - Present" runs to today. Overlapping roles count once. A gap is not \
a shortfall by itself.
- Hebrew CVs: "ניסיון" is experience, "השכלה" education, "שירות צבאי" army \
service, "יחידה" a unit, "פרויקט גמר" a final-year project.
- A CV version's label says what it emphasizes, not what the candidate can \
do. Judge each version by its content.

COMMON MISTAKES TO AVOID
- Classifying how strong the candidate is in general instead of how they meet \
this posting.
- Marking an item met for keyword overlap without hands-on evidence.
- Ignoring level: a strong mid-level engineer is not a Staff Engineer.
- Softening a classification because the company or the role is attractive.
- Counting one gap twice: as two requirements, or as a missing skill plus a \
domain_mismatch when the candidate has the domain's other skills.

WORKED EXAMPLES (requirement: importance weight status; years required / \
relevant; caps → the score the arithmetic gives)
1. Senior Backend Engineer. 5+ years Python, Kafka, AWS. Nice to have: \
Kubernetes. CV: 6 years building Python microservices, Kafka pipelines, AWS \
in production, Docker only.
Python: must primary met · Kafka: must core met · AWS: must core met · \
Kubernetes: nice supporting partial (Docker only) · years 5 / 6 → 99, a match.
2. Backend Engineer. 3+ years Java and Spring, PostgreSQL. Advantage: Kafka. \
CV: 4 years of Node.js and TypeScript services, PostgreSQL, RabbitMQ.
Java and Spring: must primary missing · PostgreSQL: must core met · Kafka: \
nice supporting partial (RabbitMQ) · years 3 / 4 → 64, worth a look, not an \
interview-ready match.
3. Full Stack Developer. 3+ years, React, Node.js, MongoDB. Nice: AWS. CV: 2 \
years with React and Express, MongoDB only in a bootcamp project, no AWS.
React: must core met · Node.js: must core met (Express) · MongoDB: must \
supporting partial · AWS: nice supporting missing · years 3 / 2 → 82, a match.
4. Team Lead, Data Platform. 7+ years, 2+ years leading engineers, Spark, \
Airflow. CV: 8 years of hands-on data engineering with Spark and Airflow, \
never managed people.
Spark: must primary met · Airflow: must core met · leading engineers: must \
core missing · years 7 / 8 · caps no_people_leadership → 55, not shown.
5. Junior Software Engineer. CS degree, Python or Java, 0-2 years. CV: 9 \
years, senior engineer and architect.
Every item met · years 0 / 9 · caps overqualified → 55, not shown.
6. DevOps Engineer. 4+ years, Kubernetes in production, Terraform, AWS, \
Hebrew and English. CV: in English, Israeli employers, 3 years of DevOps with \
EKS, Pulumi and AWS.
Kubernetes: must primary met (EKS) · Terraform: must core partial (Pulumi) · \
AWS: must core met · Hebrew and English: must supporting met (Israeli \
employers) · years 4 / 3 → 84, a match.
7. AI Engineer. Python, hands-on LLM work (RAG, agents) in production. \
Advantage: PyTorch. CV: 3 years of Python backend; one weekend project \
calling a chat API; no PyTorch.
LLM work in production: must primary missing (a toy project doesn't carry a \
primary item) · Python: must core met · PyTorch: nice supporting missing → \
62, worth a look.
8. Hardware Verification Engineer. SystemVerilog, UVM, B.Sc. in Electrical \
Engineering. CV: full-stack web developer, B.Sc. in Computer Science.
SystemVerilog: must primary missing · UVM: must core missing · B.Sc. in \
Electrical Engineering: must supporting missing · caps hard_blocker, \
domain_mismatch → 33, not shown.
9. Posting in Hebrew: "מפתח/ת Frontend, ניסיון של 3 שנים לפחות ב-React \
ו-TypeScript, יתרון משמעותי: Next.js." CV: 4 years of React with JavaScript, \
one recent project in TypeScript.
React: must primary met · TypeScript: must core partial · Next.js: nice core \
missing · years 3 / 4 → 86, a match.
10. QA Automation Engineer. 3+ years of test automation in Python or Java, \
Selenium or Playwright, CI pipelines. CV: 2 years of manual QA, a Playwright \
course, Jenkins at work.
Test automation in Python or Java: must primary missing · Selenium or \
Playwright: must core partial (a course) · CI pipelines: must supporting met \
· years 3 / 2 → 47, not shown.
11. Data Engineer. Spark, Airflow, advanced SQL, a cloud data warehouse \
(Snowflake, BigQuery or Redshift). CV: 3 years with Spark, Airflow and SQL, \
Databricks, Snowflake in one project.
Spark: must primary met · Airflow: must core met · advanced SQL: must core \
met · cloud data warehouse: must supporting met (an "or" list, used in a \
project) → 100, a match.
12. Mobile Developer. Native iOS: Swift, UIKit or SwiftUI, 4+ years, App Store \
releases. CV: 4 years of React Native, two apps shipped to the App Store, a \
little Swift at work.
Swift: must primary partial (limited professional use) · UIKit or SwiftUI: \
must core missing · App Store releases: must supporting met · years 4 / 4 → \
68, worth a look.
13. Security Researcher. Reverse engineering, malware analysis, C and \
assembly, 3+ years. CV: 3 years of backend in C++ and Python, a CTF hobby.
Reverse engineering: must primary missing (a hobby doesn't carry a primary \
item) · malware analysis: must core missing · C and assembly: must core \
partial · years 3 / 3 → 37, not shown.
14. Senior Full Stack Engineer, 6+ years, React, Node.js, PostgreSQL, system \
design. Version A (Backend-focused): 7 years of Node.js, PostgreSQL and \
service design, little React. Version B (Full Stack): the same career, with \
two years of React described in detail. B meets React where A only touches \
it, so best_cv_id is B, the requirements are classified against B, and \
cv_scores rates B above A.

WRITING
The candidate reads Hebrew. Keep technology names in English.
- requirement text: a short label, at most 8 words, in the posting's own \
language, technology names exactly as written.
- fit_summary_he: 2-3 sentences, at most 35 words: the strongest reason to \
apply and the biggest risk.
- cv_choice_reason_he: one sentence, at most 20 words: why that CV version \
fits this job best.
- top_gap_he: one sentence, at most 15 words: the single most important gap \
and, if possible, how to close it.
Be specific to this posting. No generic advice.
When the primary item is missing, or a cap of 55 or lower applies, the job \
won't be shown, so keep the Hebrew short: fit_summary_he at most 15 words, \
cv_choice_reason_he and top_gap_he empty strings. Always list the \
requirements in full: the score is made of them.
"""


def build_system_text(cvs: list[CvForPrompt]) -> str:
    parts = [RUBRIC, "\nCANDIDATE CV VERSIONS (contact details removed):"]
    for cv in cvs:
        parts.append(f'\n=== {cv.alias} · label: "{cv.label}" ===\n{cv.text}\n=== end of {cv.alias} ===')
    return "\n".join(parts)


def tool_schema(aliases: list[str]) -> dict:
    """Analysis before verdict: the requirements come first and there is no
    score field at all. The score is computed from these fields (score_of)."""
    alias_enum = {"type": "string", "enum": list(aliases)}
    return {
        "name": TOOL_NAME,
        "description": "Record the requirement-by-requirement analysis of this job posting. Call exactly once.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "required": ["requirements", "years_required", "years_relevant", "caps", "offsets", "best_cv_id",
                         "cv_scores", "fit_summary_he", "cv_choice_reason_he", "top_gap_he"],
            "properties": {
                "requirements": {
                    "type": "array",
                    "description": "Every must requirement, then the most important nice ones; up to 10 in all",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["text", "importance", "weight", "status"],
                        "properties": {
                            "text": {"type": "string"},
                            "importance": {"type": "string", "enum": ["must", "nice"]},
                            "weight": {"type": "string", "enum": ["primary", "core", "supporting"]},
                            "status": {"type": "string", "enum": ["met", "partial", "missing"]},
                        },
                    },
                },
                "years_required": {"type": "integer",
                                   "description": "Minimum years the posting asks for; 0 when it states none"},
                "years_relevant": {"type": "integer",
                                   "description": "The candidate's years in comparable roles (best CV version)"},
                "caps": {"type": "array", "items": {"type": "string", "enum": list(CAPS)}},
                "offsets": {"type": "array", "items": {"type": "string", "enum": list(OFFSETS)}},
                "best_cv_id": {**alias_enum, "description": "The CV version to submit for this job"},
                "cv_scores": {
                    "type": "array",
                    "description": "One entry per CV version, on one 0-100 scale, to compare the versions",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["cv_id", "score"],
                        "properties": {"cv_id": alias_enum, "score": {"type": "integer"}},
                    },
                },
                "fit_summary_he": {"type": "string", "description": "Hebrew, at most 35 words"},
                "cv_choice_reason_he": {"type": "string", "description": "Hebrew, at most 20 words"},
                "top_gap_he": {"type": "string", "description": "Hebrew, at most 15 words"},
            },
        },
    }


class _Requirement(BaseModel):
    text: str
    importance: str
    weight: str = "core"
    status: str


class _CvScore(BaseModel):
    cv_id: str
    score: int


class _RawAnalysis(BaseModel):
    requirements: list[_Requirement] = []
    years_required: int = 0
    years_relevant: int = 0
    caps: list[str] = []
    offsets: list[str] = []
    best_cv_id: str
    cv_scores: list[_CvScore] = []
    fit_summary_he: str = ""
    cv_choice_reason_he: str = ""
    top_gap_he: str = ""


def _clamp(n: int) -> int:
    return max(0, min(100, int(n)))


def score_of(reqs: list[dict], years_required: int, years_relevant: int, caps: list[str],
             offsets: list[str]) -> tuple[int, list[dict], dict | None]:
    """The rubric's arithmetic. Returns (score, breakdown, applied cap). The
    breakdown lists every point lost or given back, for the card to show."""
    breakdown: list[dict] = []
    total = 100
    nice_cost = 0
    for r in reqs:
        if r["status"] == "met":
            continue
        missing = r["status"] == "missing"
        if r["importance"] == "must":
            cost = MUST_COST[r["weight"]][0 if missing else 1]
        else:
            cost = min(NICE_COST[r["weight"]][0 if missing else 1], NICE_COST_MAX - nice_cost)
            nice_cost += cost
        if cost:
            total -= cost
            breakdown.append({"kind": "requirement", "text": r["text"], "importance": r["importance"],
                              "status": r["status"], "points": -cost})
    required = max(0, min(int(years_required), 40))
    relevant = max(0, min(int(years_relevant), 60))
    if required and relevant < required:
        cost = round((required - relevant) / required * YEARS_WEIGHT)
        if cost:
            total -= cost
            breakdown.append({"kind": "years", "required": required, "relevant": relevant, "points": -cost})
    given = sorted(set(o for o in offsets if o in OFFSETS))
    back = min(OFFSET_POINTS * len(given), OFFSETS_MAX, nice_cost)
    if back:
        total += back
        breakdown.append({"kind": "offsets", "names": given, "points": back})
    score = _clamp(total)
    applying = [(CAPS[c], c) for c in set(caps) if c in CAPS]
    if not any(r["importance"] == "must" for r in reqs):
        applying.append((NO_REQUIREMENTS_CAP, "no_requirements"))
    cap = None
    if applying:
        value, name = min(applying)
        if score > value:
            cap, score = {"name": name, "value": value}, value
    return score, breakdown, cap


def normalize_analysis(raw: dict, cvs: list[CvForPrompt]) -> dict | None:
    """Validated analysis keyed by the extension's CV IDs, with the score
    computed by score_of, or None. Strict mode guarantees the shape; this
    enforces what JSON Schema can't (list length, an alias that exists)."""
    try:
        parsed = _RawAnalysis.model_validate(raw)
    except ValidationError:
        return None
    by_alias = {cv.alias: cv for cv in cvs}
    rated = {s.cv_id: _clamp(s.score) for s in parsed.cv_scores if s.cv_id in by_alias}
    best = parsed.best_cv_id if parsed.best_cv_id in by_alias else (
        max(rated, key=rated.get) if rated else cvs[0].alias)
    reqs = [
        {"text": r.text.strip()[:120], "importance": r.importance, "weight": r.weight, "status": r.status}
        for r in parsed.requirements
        if r.text.strip() and r.status in ("met", "partial", "missing") and r.importance in ("must", "nice")
        and r.weight in MUST_COST
    ][:MAX_REQUIREMENTS]
    reqs.sort(key=lambda r: 0 if r["importance"] == "must" else 1)  # stable: keeps the model's order within a group
    match, breakdown, cap = score_of(reqs, parsed.years_required, parsed.years_relevant, parsed.caps, parsed.offsets)
    # The computed score is the best version's. Other versions keep the gap
    # the model saw between them and the best one.
    top = rated.get(best, match)
    scores = {alias: _clamp(match - max(0, top - s)) for alias, s in rated.items()}
    scores[best] = match
    return {
        "match_score": match,
        "best_cv_ref": by_alias[best].ref,
        "cv_scores": [
            {"cv_id": cv.ref, "label": cv.label, "score": scores[cv.alias]}
            for cv in cvs if cv.alias in scores
        ],
        "requirements": reqs,
        "breakdown": breakdown,
        "cap": cap,
        "years": {"required": max(0, parsed.years_required), "relevant": max(0, parsed.years_relevant)},
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
    """Haiku 4.5 and Haiku 5.5 take a forced tool call; Haiku 5.5 then answers
    with the tool call straight away, without its default adaptive thinking.
    Sonnet 5.5 rejects forced tool_choice, so it gets auto (the rubric demands
    the tool, and strict keeps the arguments to the schema) with its thinking
    turned off, which this one-tool-call task doesn't need and would bill as
    output."""
    if model.startswith("claude-haiku"):
        return {"tool_choice": {"type": "tool", "name": TOOL_NAME}}
    kwargs: dict = {"tool_choice": {"type": "auto"}}
    if model.startswith("claude-sonnet-5"):
        kwargs["extra_body"] = {"thinking": {"type": "between_tools"}}
    return kwargs


# Models whose API refused a forced tool call in this process. Haiku 5.5's
# docs accept one; this is the safety net if that ever changes: the call goes
# again with tool_choice auto (the rubric demands the tool) instead of failing
# the run.
_forced_tool_refused: set[str] = set()


def _refuses_forced_tool(exc: Exception) -> bool:
    return getattr(exc, "status_code", 0) == 400 and "tool_choice" in str(exc).lower()


async def _create(client, model: str, system_blocks: list, tool: dict, job: JobForPrompt):
    def send(kwargs: dict, max_tokens: int):
        return client.messages.create(model=model, max_tokens=max_tokens, system=system_blocks, tools=[tool],
                                      messages=[{"role": "user", "content": job.text}], **kwargs)
    kwargs = _model_kwargs(model)
    forced = kwargs.get("tool_choice", {}).get("type") == "tool"
    if forced and model in _forced_tool_refused:
        return await send({"tool_choice": {"type": "auto"}}, config.LLM_MAX_TOKENS_AUTO)
    try:
        return await send(kwargs, config.LLM_MAX_TOKENS)
    except Exception as exc:  # noqa: BLE001
        if not (forced and _refuses_forced_tool(exc)):
            raise
        logger.warning("[DM] %s refused a forced tool call; using tool_choice auto: %s", model, exc)
        _forced_tool_refused.add(model)
        return await send({"tool_choice": {"type": "auto"}}, config.LLM_MAX_TOKENS_AUTO)


async def _call_one(client, system_blocks: list, tool: dict, job: JobForPrompt,
                    cvs: list[CvForPrompt], usage: dict, model: str) -> dict | None:
    main = _main()
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            async with _sem():
                message = await _create(client, model, system_blocks, tool, job)
            for key, value in _usage_of(message).items():
                usage[key] += value
            if getattr(message, "stop_reason", "") == "max_tokens":
                logger.warning("[DM] job %s: output hit max_tokens", job.job_id)
                return None
            block = next((b for b in message.content
                          if getattr(b, "type", "") == "tool_use" and getattr(b, "name", "") == TOOL_NAME), None)
            if block is None:
                return None
            analysis = normalize_analysis(dict(block.input), cvs)
            if analysis is not None:
                analysis["_cost_usd"] = config.usage_cost(_usage_of(message), model)  # for the model comparison
            return analysis
        except Exception as exc:  # noqa: BLE001 — classified below
            last_exc = exc
            if not main._retryable(exc) or attempt == 1:
                break
            await _retry_pause()
    raise last_exc  # type: ignore[misc]


async def _retry_pause() -> None:
    await asyncio.sleep(1.5)


# ── OpenRouter (comparison only) ───────────────────────────────────────────────
_openrouter_transport = None  # tests put an httpx.MockTransport here


def openrouter_body(slug: str, system_text: str, tool: dict, job: JobForPrompt) -> dict:
    body = {
        "model": slug,
        "max_tokens": config.LLM_MAX_TOKENS,
        "messages": [{"role": "system", "content": system_text}, {"role": "user", "content": job.text}],
        "tools": [{"type": "function", "function": {
            "name": tool["name"], "description": tool["description"], "parameters": tool["input_schema"], "strict": True}}],
        "tool_choice": {"type": "function", "function": {"name": TOOL_NAME}},
        # CVs are personal data: only hosts that keep nothing and train on
        # nothing, never the ignored ones, and only hosts that honor the tool call.
        "provider": {"zdr": True, "data_collection": "deny", "ignore": list(config.OPENROUTER_IGNORE),
                     "require_parameters": True},
        "usage": {"include": True},
    }
    if config.OPENROUTER_REASONING:
        body["reasoning"] = {"effort": config.OPENROUTER_REASONING}
    return body


async def _call_openrouter(http: httpx.AsyncClient, sem: asyncio.Semaphore, slug: str, system_text: str,
                           tool: dict, job: JobForPrompt, cvs: list[CvForPrompt], usage: dict) -> dict | None:
    body = openrouter_body(slug, system_text, tool, job)
    for attempt in range(2):
        try:
            async with sem:
                resp = await http.post(config.OPENROUTER_URL, json=body)
        except (httpx.TimeoutException, httpx.TransportError):
            if attempt:
                raise
            await _retry_pause()
            continue
        if resp.status_code in (408, 429, 500, 502, 503, 504) and not attempt:
            await _retry_pause()
            continue
        resp.raise_for_status()
        data = resp.json()
        used = data.get("usage") or {}
        cached = int(((used.get("prompt_tokens_details") or {}).get("cached_tokens")) or 0)
        cost = float(used.get("cost") or 0)
        usage["input_tokens"] += int(used.get("prompt_tokens") or 0) - cached
        usage["cache_read_tokens"] += cached
        usage["output_tokens"] += int(used.get("completion_tokens") or 0)
        usage["cost_usd"] += cost
        message = ((data.get("choices") or [{}])[0].get("message")) or {}
        call = next((c for c in message.get("tool_calls") or []
                     if (c.get("function") or {}).get("name") == TOOL_NAME), None)
        if call is None:
            logger.warning("[DM] %s gave no tool call for job %s", slug, job.job_id)
            return None
        args = call["function"].get("arguments") or "{}"
        try:
            raw = json.loads(args) if isinstance(args, str) else dict(args)
        except ValueError:
            logger.warning("[DM] %s returned unparsable arguments for job %s", slug, job.job_id)
            return None
        analysis = normalize_analysis(raw, cvs)
        if analysis is not None:
            analysis["_cost_usd"] = cost
            analysis["_provider"] = data.get("provider") or ""
        return analysis
    return None


async def _analyze_openrouter(cvs: list[CvForPrompt], jobs: list[JobForPrompt],
                              slug: str) -> tuple[dict[str, dict | None], dict]:
    if not config.OPENROUTER_KEY:
        raise RuntimeError("DM_OPENROUTER_KEY is not set")
    system_text = build_system_text(cvs)
    tool = tool_schema([cv.alias for cv in cvs])
    usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 0.0}
    results: dict[str, dict | None] = {}
    errors: list[Exception] = []
    sem = asyncio.Semaphore(config.OPENROUTER_CONCURRENCY)
    headers = {"Authorization": f"Bearer {config.OPENROUTER_KEY}", "X-Title": "Job Match AI"}
    async with httpx.AsyncClient(timeout=config.OPENROUTER_TIMEOUT_S, headers=headers,
                                 transport=_openrouter_transport) as http:
        async def run(job: JobForPrompt):
            try:
                results[job.job_id] = await _call_openrouter(http, sem, slug, system_text, tool, job, cvs, usage)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[DM] %s job %s failed: %s", slug, job.job_id, type(exc).__name__)
                errors.append(exc)
                results[job.job_id] = None
        await asyncio.gather(*(run(job) for job in jobs))
    if jobs and len(errors) * 2 >= len(jobs):
        raise RuntimeError(f"{slug}: {len(errors)} of {len(jobs)} calls failed ({type(errors[0]).__name__})")
    logger.warning("[DM] %s analyzed %d jobs (%d failed) in=%d cached=%d out=%d cost=$%.4f", slug, len(jobs),
                   len(errors), usage["input_tokens"], usage["cache_read_tokens"], usage["output_tokens"],
                   usage["cost_usd"])
    return results, usage


async def analyze_jobs(cvs: list[CvForPrompt], jobs: list[JobForPrompt],
                       on_progress: Callable[[int, int], Awaitable[None] | None] | None = None,
                       model: str | None = None) -> tuple[dict[str, dict | None], dict]:
    """Returns ({job_id: analysis or None}, usage totals). Raises the mapped
    HTTPException (main.ai_error) when the failure is systemic."""
    if model and model.startswith(config.OPENROUTER_PREFIX):
        return await _analyze_openrouter(cvs, jobs, model[len(config.OPENROUTER_PREFIX):])
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
