"""V2 /api/v2/semantic-map — Task 1: AI semantic block mapping on CV upload.

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
"""
import json

from fastapi import Header
from json_repair import repair_json
from pydantic import BaseModel
from typing import Optional

from main import call_claude_cached, verify_gumroad_license
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


@router.post("/semantic-map")
async def semantic_map_endpoint(
    body: SemanticMapRequest,
    x_license_key: Optional[str] = Header(None),
):
    """One-time (client-cached) AI structural map of the raw uploaded CV.
    Returns blocks with byte-exact text sliced from the caller's own cv_text —
    the model never supplies the text itself, only line-range classifications."""
    if not body.cvText or len(body.cvText.strip()) < 50:
        return {"blocks": []}

    try:
        await verify_gumroad_license(x_license_key or "")
    except Exception:
        return {"blocks": []}

    numbered_cv, lines = _number_lines(body.cvText[:8000])
    if not lines:
        return {"blocks": []}

    try:
        raw, stop = await call_claude_cached(
            system_blocks=[{
                "type": "text",
                "text": "You are a precise document-structure analyst.",
            }],
            user_content=SEMANTIC_MAP_PROMPT.format(numbered_cv=numbered_cv),
            max_tokens=2000,
            model="claude-3-5-haiku",
        )
        parsed = json.loads(repair_json(raw if isinstance(raw, str) else str(raw)))
        raw_blocks = parsed.get("blocks", []) if isinstance(parsed, dict) else []
    except Exception as e:
        print(f"[JMA:v2:semantic_map] error: {e}")
        return {"blocks": []}

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
    return {"blocks": blocks}
