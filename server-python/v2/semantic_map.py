"""V2 /api/v2/semantic-map + /api/v2/cv-blocks — Task 1: AI semantic block
mapping, strictly upload-time and database-backed.

Genuinely new V2-only logic (no V1 equivalent exists to replicate — V1 never
runs an AI parser over the raw uploaded CV to register role boundaries; see
the answer to the architecture questions in v2/v2_content.js's block near
_v2FetchSemanticMap).

Anti-hallucination design (mirrors main.py's own established pattern — see
_split_original_lines / _best_match's "never an LLM's re-typed approximation"
comment at main.py:715-738): the model is asked for LINE-NUMBER ranges only,
never for the block text itself. The endpoint slices the caller's own
cv_text by those line numbers to build the returned text, so the original
spacing/line-breaks/formatting are always byte-exact — the model's only job
is classification (which lines belong to which block), not transcription.

Upload-time-only contract:
  POST /api/v2/semantic-map — called EXACTLY ONCE per genuine CV upload (see
    v2/v2-entry.js's parallel #btnSaveSettings listener). Runs the AI parse
    and UPSERTS the result into v2_cv_semantic_maps, keyed by user_id.
  GET  /api/v2/cv-blocks    — called during job navigation. Pure DB read, no
    AI call, no heuristic fallback, no client-side caching of the result —
    the CV window renders exactly what was computed at upload time or shows
    an empty state prompting a re-upload.
"""
import hashlib
import json

from json_repair import repair_json
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends

from main import call_claude_cached
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.models import User
from v2.models import V2CvSemanticMap
from v2.router import router


class SemanticMapRequest(BaseModel):
    cvText: str = ""


SEMANTIC_MAP_PROMPT = """\
You are analysing the structural layout of a candidate's CV/resume so a UI can \
render each part as its own visual block with an "insert here" button.

The CV below has each line prefixed with its 0-based line number in the exact \
format "N: <line text>". Use ONLY these line numbers to describe block \
boundaries — do NOT repeat or retype any CV content in your answer.

Identify blocks in reading order and classify each as one of:
  "summary"    — profile / objective / about-me / headline block
  "skills"     — technical skills / tools / technologies list
  "role"       — ONE single employer/job entry (see rule below)
  "education"  — degrees / academic background
  "languages"  — spoken/written languages
  "projects"   — personal/side projects
  "other"      — anything else (contact info, header, military service, etc.)

CRITICAL RULE — role granularity: if the CV lists multiple employers or \
positions (e.g. "Matrix IT", "JobMatch AI", "Google"), each one MUST be its \
own separate "role" block, even though they all sit under one "Experience" \
heading. Never merge two different employers/roles into a single block. A \
role block starts at that role's own heading/title line (often containing a \
company name, job title, or a date range) and ends on the line right before \
the next role starts (or the section ends).

Return ONLY valid JSON, no markdown:
{{"blocks":[
  {{"type":"summary|skills|role|education|languages|projects|other","label":"<short block title, e.g. the role's job-title/company line, in its original language>","start_line":<int>,"end_line":<int>}},
  ...
]}}

Blocks must be in ascending, non-overlapping line order and together should \
cover essentially the whole document.

=== CV (line-numbered) ===
{numbered_cv}"""


def _number_lines(cv_text: str) -> tuple[str, list[str]]:
    lines = cv_text.splitlines()
    numbered = "\n".join(f"{i}: {line}" for i, line in enumerate(lines))
    return numbered, lines


def _clamp_blocks(raw_blocks: list, line_count: int) -> list[dict]:
    """Validate/clamp AI-proposed line ranges — never trust them blindly.
    Sorts by start_line and clips each block's end so ranges cannot overlap
    or run past the document, since the caller will slice cv_text by these
    numbers verbatim."""
    cleaned = []
    for b in raw_blocks:
        try:
            start = max(0, min(int(b.get("start_line", 0)), line_count - 1))
            end   = max(start, min(int(b.get("end_line", start)), line_count - 1))
        except (TypeError, ValueError):
            continue
        block_type = b.get("type") if b.get("type") in (
            "summary", "skills", "role", "education", "languages", "projects", "other"
        ) else "other"
        cleaned.append({
            "type": block_type,
            "label": str(b.get("label", ""))[:80],
            "start_line": start,
            "end_line": end,
        })

    cleaned.sort(key=lambda b: b["start_line"])
    for i in range(len(cleaned) - 1):
        if cleaned[i]["end_line"] >= cleaned[i + 1]["start_line"]:
            cleaned[i]["end_line"] = max(cleaned[i]["start_line"], cleaned[i + 1]["start_line"] - 1)
    return [b for b in cleaned if b["end_line"] >= b["start_line"]]


def _cv_hash(cv_text: str) -> str:
    return hashlib.sha256(cv_text.encode()).hexdigest()[:32]


@router.post("/semantic-map")
async def semantic_map_endpoint(
    body: SemanticMapRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Upload-time only. Runs the AI structural parse and UPSERTS the result
    into v2_cv_semantic_maps for this user — never called during job
    navigation (see GET /cv-blocks below for the read path). Returns blocks
    with byte-exact text sliced from the caller's own cv_text — the model
    never supplies the text itself, only line-range classifications."""
    if not body.cvText or len(body.cvText.strip()) < 50:
        return {"blocks": [], "saved": False}

    numbered_cv, lines = _number_lines(body.cvText[:8000])
    if not lines:
        return {"blocks": [], "saved": False}

    try:
        raw, stop = await call_claude_cached(
            system_blocks=[{
                "type": "text",
                "text": "You are a precise document-structure analyst.",
            }],
            user_content=SEMANTIC_MAP_PROMPT.format(numbered_cv=numbered_cv),
            max_tokens=2000,
            # Real Anthropic Haiku ID (matches _resolve_model('haiku') and every
            # actually-executed call in main.py). Was "claude-3-5-haiku" — an
            # invalid ID copied from main.py:1875's Pass-1 path, which almost
            # never runs (Pass 1 is skipped when the client sends a local
            # score), so its typo stayed latent there. Here the AI runs every
            # time, so the bad ID made the API reject every call and the row
            # never saved.
            model="claude-haiku-4-5-20251001",
        )
        parsed = json.loads(repair_json(raw if isinstance(raw, str) else str(raw)))
        raw_blocks = parsed.get("blocks", []) if isinstance(parsed, dict) else []
    except Exception as e:
        print(f"[JMA:v2:semantic_map] error: {e}")
        return {"blocks": [], "saved": False, "error": f"{type(e).__name__}: {e}"}

    clamped = _clamp_blocks(raw_blocks, len(lines))
    blocks = [
        {
            "type": b["type"],
            "label": b["label"] or lines[b["start_line"]].strip()[:60],
            "text": "\n".join(lines[b["start_line"]:b["end_line"] + 1]).strip(),
        }
        for b in clamped
    ]
    blocks = [b for b in blocks if b["text"]]
    if not blocks:
        return {"blocks": [], "saved": False, "error": "ai_returned_no_blocks"}

    cv_hash = _cv_hash(body.cvText)
    result = await db.execute(select(V2CvSemanticMap).where(V2CvSemanticMap.user_id == user.id))
    row = result.scalar_one_or_none()
    if row is None:
        row = V2CvSemanticMap(user_id=user.id, cv_hash=cv_hash, blocks=blocks)
        db.add(row)
    else:
        row.cv_hash = cv_hash
        row.blocks = blocks
    await db.commit()

    return {"blocks": blocks, "saved": True}


@router.get("/cv-blocks")
async def cv_blocks_endpoint(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Job-navigation read path — pure DB lookup, no AI call, no fallback.
    Renders exactly what POST /semantic-map computed at upload time."""
    result = await db.execute(select(V2CvSemanticMap).where(V2CvSemanticMap.user_id == user.id))
    row = result.scalar_one_or_none()
    if row is None:
        return {"blocks": [], "processed": False}
    return {"blocks": row.blocks, "processed": True, "cvHash": row.cv_hash}
