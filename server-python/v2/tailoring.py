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
# these transforms are cheap/constrained, Haiku is plenty and keeps latency low.
_TAILOR_MODEL = "claude-haiku-4-5-20251001"


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
            user_content=BASELINE_GROOM_USER.format(blocks=_blocks_for_prompt([b.dict() for b in body.blocks])),
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

Focus (EXPAND and lead with these block ids): {focus_ids}
Condense (SHRINK these block ids by about {shrink_pct}%): {shrink_ids}

RULES:
- SHRINK targets: condense to ~{shrink_pct}% of their bullets — keep the strongest 1-2 \
bullets and the role header/title. NEVER delete a role entirely or fabricate gaps.
- FOCUS targets: expand and sharpen — surface the job-relevant achievements, add emphasis, \
lead with the most relevant points. You may rephrase and re-order WITHIN the block.
- Do NOT invent experience, skills, employers, or numbers the candidate does not have.
- Bold job-relevant keywords already present with **double asterisks**.
- Keep each block's language (Hebrew/English) as in the original.

Here are the current CV blocks (id-keyed):
{blocks}

Return ONLY valid JSON, no markdown. Include ONLY the blocks you changed:
{{"blocks":[{{"id":"<block id>","text":"<restructured block text, with **bolded** keywords>"}}]}}"""


@router.post("/niche-restructure")
async def niche_restructure(body: NicheRestructureRequest, user: User = Depends(get_current_user)):
    if not body.cvText or not body.blocks:
        return {"blocks": []}
    try:
        raw, _ = await call_claude_cached(
            system_blocks=_v2_cached_context(body.cvText, body.jobText),
            user_content=NICHE_RESTRUCTURE_USER.format(
                focus_ids=", ".join(body.focusAreaIds) or "(none specified)",
                shrink_ids=", ".join(body.shrinkIds) or "(none specified)",
                shrink_pct=max(10, min(90, body.shrinkPct)),
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
        print(f"[JMA:v2:niche_restructure] error: {e}")
        return {"blocks": [], "error": f"{type(e).__name__}"}
