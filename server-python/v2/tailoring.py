"""V2 Phase-2 tailoring — classify / baseline-groom / niche-restructure.

CRITICAL shared design: prompt caching. All three endpoints send the SAME
system block — the Original CV + the Job Description — carrying
cache_control:ephemeral (see _v2_cached_context). Because the system content
is byte-identical across the sequential calls in this flow, Anthropic caches
that large static prefix on the first call and every later call in the flow
reads it from cache — drastically cutting token cost and latency so the live
UI updates feel instant. Only the per-step USER turn differs (modular prompts),
never the cached base context.

Modularity: BASELINE_GROOM_USER and NICHE_RESTRUCTURE_USER are deliberately
separate prompts even though they share the cached system context, so each
step's rules can evolve independently.

All calls go through main.call_claude_cached (shared infra, not V1 flow logic).
Block-keyed I/O: the CV is passed as the ordered semantic-map blocks and each
transform returns per-block text, so the CV window can apply changes live,
block by block, and revert cleanly.
"""
import json
from typing import Optional

from fastapi import Depends
from pydantic import BaseModel

from main import call_claude_cached, parse_json_response
from app.core.deps import get_current_user
from app.core.models import User
from v2.router import router

# Same Haiku ID the rest of the backend uses (see [[anthropic-model-ids]]);
# classification and the constrained baseline groom are cheap/mechanical, so
# Haiku is plenty and keeps the live UI snappy.
_TAILOR_MODEL = "claude-haiku-4-5-20251001"
# The niche restructure is the one genuinely hard judgement call in the flow —
# it decides what to cut and how to re-angle a career story — so it runs on the
# stronger model. It fires once, only when the user explicitly opts in, so the
# extra cost is bounded (and the cached CV+JD prefix keeps it cheap).
_TAILOR_MODEL_ADVANCED = "claude-sonnet-4-6"

# Recruiter-craft rules distilled from professional CV-writing guidance. Kept
# as a shared constant so both transforms speak the same language, and kept
# deliberately BOUNDED — they improve how existing content is phrased, they
# never license inventing content. Anything the CV can't support becomes a
# [למילוי] placeholder for the user to fill, which preserves user control
# instead of silently fabricating numbers.
_WRITING_RULES = """\
WRITING CRAFT (apply within your allowed scope — never as licence to invent):
- Open every bullet with a strong action verb. Never "responsible for", "helped
  with", "worked on", "אחראי על", "עזרתי ב-".
- Weave in the job description's recurring keywords NATURALLY, and ONLY where
  the candidate's real content already supports them. Never keyword-stuff.
- Keep every bullet to 1-2 lines. Recruiters skim; dense paragraphs get skipped.
- Prefer concrete impact: what was achieved, measured by what, by doing what.
  If a metric is genuinely absent from the CV, do NOT invent one — write the
  bullet without it, or mark a suggested slot as [למילוי] for the user to fill.
- Never invent employers, titles, dates, technologies or numbers."""


def _v2_cached_context(cv_text: str, job_text: str) -> list:
    """The shared, cached base context reused across ALL Phase-2 calls. Kept
    byte-identical per (cv, jd) so the Anthropic prompt cache hits on every
    call after the first in the flow."""
    return [{
        "type": "text",
        "text": (
            "You are a senior CV-tailoring expert. The candidate's ORIGINAL CV and the "
            "target JOB DESCRIPTION are below; treat them as your fixed reference for every "
            "instruction you receive.\n\n"
            "=== ORIGINAL CV ===\n"
            f"{cv_text}\n"
            "=== END CV ===\n\n"
            "=== JOB DESCRIPTION ===\n"
            f"{job_text}\n"
            "=== END JOB DESCRIPTION ==="
        ),
        "cache_control": {"type": "ephemeral"},
    }]


def _blocks_for_prompt(blocks: list) -> str:
    """Compact, id-keyed rendering of the CV blocks for the user turn."""
    out = []
    for b in blocks or []:
        out.append(f'[{b.get("id")}] ({b.get("type","text")}) {b.get("label","")}\n{b.get("text","")}')
    return "\n\n".join(out)


class _BlockIn(BaseModel):
    id: str = ""
    type: str = "text"
    label: str = ""
    text: str = ""


# ── 1. Classifier — niche vs general ─────────────────────────────────────────

class ClassifyFitRequest(BaseModel):
    cvText: str = ""
    jobText: str = ""
    answers: list = []
    blocks: list[_BlockIn] = []


CLASSIFY_USER = """Using the ORIGINAL CV and JOB DESCRIPTION in your system context, classify \
the match as exactly one of "general" or "niche".

- "general" (General Fit): the JOB spans essentially the SAME breadth as the CV's PRIMARY \
identity — same core domains and trajectory. The CV needs only minor grooming, not a \
rewrite. Choose this ONLY when the job is broadly aligned with the whole CV.

- "niche" (Niche Fit): the job concentrates on ONE specialised subset while the CV is \
broad/multi-domain. To compete, the CV needs a structural shift — shrink the unrelated \
experience and expand the niche focus.

⚠️ EXPLICIT DECIDING RULE — this IS niche, do NOT call it general:
If the CV carries SUBSTANTIAL weight across several disciplines (e.g. heavy traditional \
Backend + DB optimization AS WELL AS AI / automations), but the JOB focuses almost \
entirely on ONE of those subsets (e.g. exclusively AI Agents, Prompt Engineering, \
client-facing automations), you MUST classify it as NICHE. Reason: leaving the heavy \
non-relevant experience (e.g. traditional Java/SQL backend) prominent would DILUTE the \
candidate's signal for the specialised role — so the off-target domain must be \
structurally shrunk and the on-target domain expanded. High keyword overlap does NOT \
make it general when the job targets only one slice of a multi-domain CV.

When you are torn between general and niche for a SPECIALISED job description, choose \
niche. A pure tool-level mismatch alone (knows PostgreSQL, job says MySQL, same domain) \
is NOT by itself niche.

The CV's structural blocks (use these exact ids for focus_areas):
{blocks}

Return ONLY valid JSON, no markdown:
{{
  "fit_type": "general" | "niche",
  "summary_he": "<up to 35 Hebrew words: why it fits + what will be adjusted>",
  "recommendations": {{
    "focus_areas": [{{"id":"<block id to EXPAND/lead with — the job's niche domain>","label":"<short Hebrew label>"}}],
    "shrink_candidates": [{{"id":"<block id of UNRELATED experience to condense>","label":"<short Hebrew label>"}}],
    "suggested_shrink": 50
  }}
}}
For "general" fit, focus_areas and shrink_candidates may be empty arrays."""


@router.post("/classify-fit")
async def classify_fit(body: ClassifyFitRequest, user: User = Depends(get_current_user)):
    if not body.cvText or not body.jobText:
        return {"fit_type": "general", "summary_he": "", "recommendations": {}, "error": "missing_cv_or_jd"}
    try:
        raw, _ = await call_claude_cached(
            system_blocks=_v2_cached_context(body.cvText, body.jobText),
            user_content=CLASSIFY_USER.format(blocks=_blocks_for_prompt([b.dict() for b in body.blocks])),
            max_tokens=700,
            model=_TAILOR_MODEL,
        )
        data = parse_json_response(raw)
        ft = data.get("fit_type")
        if ft not in ("general", "niche"):
            ft = "general"
        return {
            "fit_type": ft,
            "summary_he": data.get("summary_he", ""),
            "recommendations": data.get("recommendations", {}) or {},
        }
    except Exception as e:
        print(f"[JMA:v2:classify] error: {e}")
        # Fail safe toward 'general' (never force a structural rewrite on error).
        return {"fit_type": "general", "summary_he": "", "recommendations": {}, "error": f"{type(e).__name__}"}


# ── 2. Phase 1 — baseline grooming (all fits) ────────────────────────────────

class BaselineGroomRequest(BaseModel):
    cvText: str = ""
    jobText: str = ""
    answers: list = []
    blocks: list[_BlockIn] = []


BASELINE_GROOM_USER = """Task: BASELINE GROOMING — the safe, minimal pass applied to every CV.

HARD RULES (violating these is a failure):
- Do NOT add, invent, remove, or move any experience, role, skill, or bullet.
- Do NOT change facts, numbers, dates, employers, or the meaning of any line.
- ONLY: (a) minor phrasing/wording improvements, and (b) wrap words/technologies that \
are ALREADY present and are relevant to the job in **double asterisks** to bold them.
- Keep each block's language (Hebrew stays Hebrew, English stays English) and roughly \
its original length.

ONE DELIBERATE EXCEPTION — the professional HEADLINE / TITLE:
The candidate's professional title line (the headline right under the name, and the \
opening identity sentence of the summary/profile block, if present) MUST be re-angled \
to match this specific job, so a recruiter sees the relevant identity immediately. \
Example shape: a broad "Full-Stack Developer" becomes "AI & Automation Engineer | \
Full-Stack Developer" when the job is AI-focused — leading with the job's domain while \
KEEPING the candidate's real background visible.
Constraints on this exception: use ONLY domains/technologies the CV genuinely supports \
— never invent a title the candidate has no basis for, never claim a seniority level \
the CV doesn't show, and never drop their real profession entirely. Reorder and \
re-emphasise, do not fabricate. Apply it to the headline/summary block ONLY; every \
other block still follows the HARD RULES above.

{writing_rules}

Here are the CV blocks (id-keyed):
{blocks}

Return ONLY valid JSON, no markdown. Include ONLY the blocks you actually changed:
{{"blocks":[{{"id":"<block id>","text":"<groomed block text, with **bolded** keywords>"}}]}}"""


@router.post("/baseline-groom")
async def baseline_groom(body: BaselineGroomRequest, user: User = Depends(get_current_user)):
    if not body.cvText or not body.blocks:
        return {"blocks": []}
    try:
        raw, _ = await call_claude_cached(
            system_blocks=_v2_cached_context(body.cvText, body.jobText),
            user_content=BASELINE_GROOM_USER.format(
                writing_rules=_WRITING_RULES,
                blocks=_blocks_for_prompt([b.dict() for b in body.blocks]),
            ),
            max_tokens=2500,
            model=_TAILOR_MODEL,
        )
        data = parse_json_response(raw)
        blocks = data.get("blocks", []) if isinstance(data, dict) else []
        clean = [{"id": b["id"], "text": b["text"]} for b in blocks if b.get("id") and b.get("text")]
        return {"blocks": clean}
    except Exception as e:
        print(f"[JMA:v2:baseline_groom] error: {e}")
        return {"blocks": [], "error": f"{type(e).__name__}"}


# ── 3. Phase 2 — niche restructuring ─────────────────────────────────────────

class NicheRestructureRequest(BaseModel):
    cvText: str = ""
    jobText: str = ""
    answers: list = []
    blocks: list[_BlockIn] = []
    focusAreaIds: list[str] = []
    shrinkIds: list[str] = []
    shrinkPct: int = 50


NICHE_RESTRUCTURE_USER = """Task: NICHE RESTRUCTURING — the user opted into a structural emphasis shift.

The user made TWO opposite selections. Read them carefully — never swap them:

EXPAND (make MORE prominent — these are the job's niche focus):
{focus_list}

SHRINK (make LESS prominent — off-target for this job):
{shrink_list}

SHRINK semantics — unambiguous: remove about {shrink_pct}% of each SHRINK block's \
volume, i.e. KEEP only ~{keep_pct}% of it. Keep the role header/title line and the \
strongest {keep_bullets} bullet(s); drop the rest. A SHRINK block's output MUST be \
clearly SHORTER than its input. NEVER delete a role entirely or fabricate employment gaps.

EXPAND semantics: sharpen and surface the job-relevant achievements, lead with the most \
relevant points, add emphasis. You may rephrase and re-order WITHIN the block. An EXPAND \
block's output should be at least as detailed as its input — NEVER shorten an EXPAND block.
Inside an EXPAND block, order the bullets by IMPACT rather than chronology — the most \
impressive, most job-relevant achievement first.

{writing_rules}

RULES:
- Do NOT modify ANY block that is not listed in EXPAND or SHRINK above — return only \
listed blocks.
- Do NOT invent experience, skills, employers, or numbers the candidate does not have.
- Bold job-relevant keywords already present with **double asterisks**.
- Keep each block's language (Hebrew/English) as in the original.

SELF-CHECK before answering: for every SHRINK id, is your text shorter than the \
original? For every EXPAND id, is nothing lost? If not, fix it.

Here are the current CV blocks (id-keyed):
{blocks}

Return ONLY valid JSON, no markdown. Include ONLY the blocks you changed:
{{"blocks":[{{"id":"<block id>","text":"<restructured block text, with **bolded** keywords>"}}]}}"""


def _labelled_list(ids: list, blocks_by_id: dict) -> str:
    """Render 'id — label (type)' lines. Passing the LABEL next to the id (not a
    bare "b3, b7") is what stops the model mixing the two lists up."""
    if not ids:
        return "  (none)"
    out = []
    for i in ids:
        b = blocks_by_id.get(i)
        out.append(f'  - {i} — "{(b or {}).get("label", "")}" ({(b or {}).get("type", "?")})')
    return "\n".join(out)


@router.post("/niche-restructure")
async def niche_restructure(body: NicheRestructureRequest, user: User = Depends(get_current_user)):
    """Structural emphasis shift. Hardened against the model doing the inverse of
    what was asked: the two lists are labelled (not bare ids), overlapping ids are
    resolved, unrequested blocks are dropped, and — the real guard — any SHRINK
    block that comes back the same length or LONGER than the original is rejected
    and the original kept. Same for an EXPAND block that came back shorter."""
    if not body.cvText or not body.blocks:
        return {"blocks": []}

    blocks_by_id = {b.id: b.dict() for b in body.blocks}
    shrink_ids = [i for i in body.shrinkIds if i in blocks_by_id]
    # A block can never be both — EXPAND wins (never silently shrink something
    # the user asked to emphasise).
    focus_ids = [i for i in body.focusAreaIds if i in blocks_by_id]
    shrink_ids = [i for i in shrink_ids if i not in focus_ids]

    if not focus_ids and not shrink_ids:
        # Without at least one target the model has no instruction to follow and
        # would freestyle over the whole CV — refuse instead.
        return {"blocks": [], "error": "no_valid_targets"}

    shrink_pct = max(10, min(90, body.shrinkPct))
    keep_pct = 100 - shrink_pct
    try:
        raw, _ = await call_claude_cached(
            system_blocks=_v2_cached_context(body.cvText, body.jobText),
            user_content=NICHE_RESTRUCTURE_USER.format(
                focus_list=_labelled_list(focus_ids, blocks_by_id),
                shrink_list=_labelled_list(shrink_ids, blocks_by_id),
                shrink_pct=shrink_pct,
                keep_pct=keep_pct,
                keep_bullets=1 if shrink_pct >= 70 else 2,
                writing_rules=_WRITING_RULES,
                blocks=_blocks_for_prompt([b.dict() for b in body.blocks]),
            ),
            max_tokens=2500,
            model=_TAILOR_MODEL_ADVANCED,  # hardest judgement in the flow
        )
        data = parse_json_response(raw)
        returned = data.get("blocks", []) if isinstance(data, dict) else []
    except Exception as e:
        print(f"[JMA:v2:niche_restructure] error: {e}")
        return {"blocks": [], "error": f"{type(e).__name__}"}

    allowed = set(focus_ids) | set(shrink_ids)
    clean, rejected = [], []
    for b in returned:
        bid, text = b.get("id"), b.get("text")
        if not bid or not text or bid not in allowed:
            rejected.append({"id": bid, "why": "not_requested"})
            continue
        orig = blocks_by_id[bid].get("text", "") or ""
        # Direction check — this is what catches an inverted transform.
        if bid in shrink_ids and len(text) >= len(orig) * 0.95:
            rejected.append({"id": bid, "why": "shrink_not_shorter"})
            continue
        if bid in focus_ids and len(text) < len(orig) * 0.6:
            rejected.append({"id": bid, "why": "expand_got_shorter"})
            continue
        clean.append({"id": bid, "text": text})

    if rejected:
        print(f"[JMA:v2:niche_restructure] rejected {len(rejected)} block(s): {rejected}")
    return {"blocks": clean, "rejected": rejected}
