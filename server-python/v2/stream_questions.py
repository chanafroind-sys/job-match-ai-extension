"""V2 /api/v2/stream-questions — physical 1:1 copy of the V1 flow.

Replication contract: the entire execution flow is duplicated verbatim from
main.py (frozen V1) so V2 can be modified without ever touching V1:
  • StreamQuestionsRequest            ← main.py:1635
  • _cv_system_blocks                 ← main.py:813
  • _SCORING_RULES / BASE_ANALYSIS_USER ← main.py:831 / 855
  • STREAM_QUESTIONS_LIVE_PROMPT      ← main.py:1717
  • _stream_q_parse                   ← main.py:1745
  • the endpoint generator            ← main.py:1820

The ONLY functional delta vs. V1: the route is mounted at
/api/v2/stream-questions (via the v2 router prefix) instead of
/api/stream-questions.

Pure infrastructure (anthropic client, Gumroad license verification, cached
Claude caller, JSON parsing, model-alias resolution) is imported from main —
these are shared plumbing, not flow logic, and must behave identically in
both pipelines.
"""
import json
from typing import Optional

from fastapi import Header
from fastapi.responses import StreamingResponse
from json_repair import repair_json
from pydantic import BaseModel

# Shared infrastructure only — no V1 flow logic is imported.
from main import (
    anthropic_client,
    call_claude_cached,
    parse_json_response,
    verify_gumroad_license,
    _resolve_model,
)
from v2.router import router


class StreamQuestionsRequest(BaseModel):
    cvText:     str = ""
    jobText:    str = ""
    model:      str = "claude-sonnet-4-6"
    baseScore:  int = -1
    gapPct:     int = -1


def _cv_system_blocks(cv_text: str) -> list:
    """Return a system-prompt block list with the CV cached via ephemeral cache_control."""
    return [
        {
            "type": "text",
            "text": (
                "You are a senior recruitment expert and screening specialist.\n\n"
                "=== CANDIDATE CV ===\n"
                f"{cv_text}\n"
                "=== END CV ==="
            ),
            "cache_control": {"type": "ephemeral"},
        }
    ]


_SCORING_RULES = """\
SCORING RULES:
STEP 1 — classify every requirement:
  CRITICAL = "must"/"required"/"mandatory" or listed in the primary requirements section
  SECONDARY = "nice to have"/"preferred"/"advantage"/"bonus" or in a lower-priority section

STEP 2 — deduct from 100:
  Missing CRITICAL requirement: -15 to -25 per item (proportional to centrality)
  Partial/theoretical on a CRITICAL item: -5 to -12
  Years shortfall: (required - actual) / required × 30 pts
  Seniority mismatch (Senior/Lead in title but not in CV): cap at 65
  Missing SECONDARY/nice-to-have: -2 to -5 per item (NEVER more than -5 each)

DOMAIN MISMATCH: cap at 55 ONLY when the candidate genuinely lacks the critical skills.
  If they have the required skills but come from a different job-title background, do NOT cap — score on skill fit alone.

STEP 3 — positive partial offsets (secondary gaps only):
  Strong relevant academics +5 | Adjacent transferable skills +5 | Relevant projects +5

CALIBRATION: 85+ shortlist | 70-84 interview | 55-69 gaps | <40 wrong fit
A candidate meeting all CRITICALs but lacking all SECONDARYs → 65-75, not below 55.
Score <50 means most CRITICALs are missing — not just a different background.\
"""

BASE_ANALYSIS_USER = """Analyse the fit between the candidate CV (in your system prompt) and this job posting.

{scoring_rules}

Additionally compute:
  gap_pct = integer 0-40 — how many score points COULD be gained if the candidate could fully clarify all uncertain/missing areas through follow-up questions. 0 means the CV is fully self-explanatory; 35 means strong potential to improve with answers.

MANDATORY: Before setting base_score you MUST complete the scoring_reasoning field with explicit step-by-step arithmetic covering ALL four sections below. Do NOT skip or summarise — write the actual numbers.

Return ONLY valid JSON — no markdown:
{{
  "scoring_reasoning": "<REQUIRED — explicit maths in English covering all four steps:\n1. TOTAL YEARS CHECK: job requires X total yrs, candidate has Y → shortfall Z → penalty = Z/X×30 = P pts\n2. CORE TECH YEAR CHECK: for each tech with an explicit years requirement, write 'TechName: required Xyr, candidate has Yyr → shortfall Z → penalty P pts'\n3. MISSING CRITICAL TECHS: list every CRITICAL technology/tool not found anywhere in the CV and its individual deduction (−15 to −25). Write 'none' only if literally nothing is missing.\n4. FINAL ARITHMETIC: start=100, list every deduction with its label, sum them, clamp to [0,100] → base_score=N>",
  "base_score": <integer 0-100>,
  "gap_pct": <integer 0-40>,
  "jobTitle": "<job title>",
  "company": "<company name>",
  "jobLanguage": "hebrew" | "english",
  "summary": "<2 sentences in Hebrew describing overall fit>",
  "strengths": ["<Hebrew sentence with skill names in English>", ...],
  "hard_gaps": ["<Hebrew sentence with skill names in English>", ...]
}}

=== JOB DESCRIPTION ===
{job_text}"""


STREAM_QUESTIONS_LIVE_PROMPT = """\
You are a senior career consultant. The candidate CV is in your system prompt.

The initial match score is {base_score}% with {gap_pct} improvement points available.

Identify UP TO {n_questions} of the most critical and substantial skill gaps that are unclear or missing in \
the CV and are clearly required by the job below. Focus only on high-impact gaps; do not force minor questions just to meet a count.

CRITICAL OUTPUT FORMAT — for EACH gap emit EXACTLY these 3 lines the MOMENT you identify it:
Line 1 (metadata — emit immediately): [META]{{"id":"qN","skill":"<English name>","weight":<int>}}
Line 2 (question   — stream freely):  <full Hebrew question text, one line>
Line 3 (close):                        [EXPL]<Hebrew explanation, max 15 words>[/EXPL]

Rules:
• Your FIRST token must be `[` — no preamble, no thinking text, no introduction.
• Emit gap #1 the instant you find it — do NOT read the whole job first.
• weights must sum to exactly {gap_pct}. Skill names in English; all text in Hebrew.
• Do NOT add any other lines, commentary, or JSON wrappers.
• After the last question output: [QUESTIONS_DONE]

--- ADVANCED GAP EVALUATION RULES ---
1. DO NOT ask novice-level questions if the CV demonstrates advanced experience in a related domain.
2. If the job requires AI tooling (like Copilot/Cursor) and the CV already shows hands-on AI Development (LLMs, Prompts, Agents), acknowledge their AI background in the question rather than assuming they lack AI literacy.
3. Tailor the phrasing to match the candidate's existing professional depth (e.g., blend their Java/Python/AI background into the context of the question).

=== JOB DESCRIPTION ===
{job_text}"""


async def _stream_q_parse(token_iter):
    """
    3-state parser for STREAM_QUESTIONS_LIVE_PROMPT output.
    Yields SSE-formatted data strings (not full 'data: ...' lines yet — caller wraps).

    States:
      WAIT_META  → accumulate until [META]...\\n is complete → emit q_open
      STREAM_TEXT → flush tokens immediately (keeping last GUARD chars) → on [EXPL] emit final text
      COLLECT_EXPL → accumulate until [/EXPL] → emit q_close → back to WAIT_META
    """
    state  = "WAIT_META"
    buf    = ""
    q_id   = ""
    GUARD  = 14          # bytes kept back to detect split markers

    async for chunk in token_iter:
        buf += chunk

        # Inner loop: drain buf through state transitions without waiting for next chunk
        changed = True
        while changed:
            changed = False

            if state == "WAIT_META":
                if "[META]" in buf:
                    start  = buf.index("[META]")
                    after  = buf[start + 6:]
                    if "\n" in after:
                        meta_raw, buf = after.split("\n", 1)
                        try:
                            meta  = json.loads(repair_json(meta_raw.strip()))
                            q_id  = meta.get("id", "")
                            yield f"data: {json.dumps({'q_open': meta})}\n\n"
                            state   = "STREAM_TEXT"
                            changed = True
                        except Exception:
                            buf = after  # skip bad meta, keep trying
                    else:
                        buf = buf[start:]   # keep [META]... for next chunk
                elif "[QUESTIONS_DONE]" in buf:
                    return
                else:
                    buf = buf[-GUARD:]  # keep tail in case [META] spans chunks

            elif state == "STREAM_TEXT":
                if "[EXPL]" in buf:
                    idx      = buf.index("[EXPL]")
                    tail_txt = buf[:idx]
                    buf      = buf[idx + 6:]
                    if tail_txt:
                        yield f"data: {json.dumps({'q_token': {'id': q_id, 'text': tail_txt}})}\n\n"
                    state   = "COLLECT_EXPL"
                    changed = True
                elif "[QUESTIONS_DONE]" in buf:
                    pre = buf[:buf.index("[QUESTIONS_DONE]")].strip()
                    if pre:
                        yield f"data: {json.dumps({'q_token': {'id': q_id, 'text': pre}})}\n\n"
                    return
                else:
                    # Flush safe portion; retain GUARD chars for split-marker detection
                    if len(buf) > GUARD:
                        safe = buf[:-GUARD]
                        yield f"data: {json.dumps({'q_token': {'id': q_id, 'text': safe}})}\n\n"
                        buf = buf[-GUARD:]

            elif state == "COLLECT_EXPL":
                if "[/EXPL]" in buf:
                    expl, buf = buf.split("[/EXPL]", 1)
                    yield f"data: {json.dumps({'q_close': {'id': q_id, 'explanation': expl.strip()}})}\n\n"
                    state   = "WAIT_META"
                    changed = True
                elif "[QUESTIONS_DONE]" in buf:
                    return


@router.post("/stream-questions")
async def stream_questions_endpoint(
    body: StreamQuestionsRequest,
    x_license_key: Optional[str] = Header(None),
):
    """
    Single streaming call that:
      1. Runs Pass 1 (base score + analysis) — fast non-streaming call.
      2. Emits {meta: {base_score, gap_pct, jobTitle, company, summary}} as first SSE event.
      3. Streams questions token-by-token via q_open / q_token / q_close events.
      4. Emits [DONE].
    The client can open a textarea the moment the first q_open arrives,
    letting the user type while subsequent tokens / questions are still streaming.
    """
    def _sse_err(msg: str):
        async def _gen():
            yield f'data: {json.dumps({"error": msg})}\n\n'
            yield "data: [DONE]\n\n"
        return StreamingResponse(_gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    if not body.cvText or not body.jobText:
        return _sse_err("חסרים נתוני CV או משרה.")

    license_key = x_license_key or ""
    try:
        await verify_gumroad_license(license_key)
    except Exception:
        return _sse_err("רישיון לא תקף.")

    cv_text  = body.cvText[:3000]
    job_text = body.jobText[:2500]
    sys_blocks     = _cv_system_blocks(cv_text)
    resolved_model = _resolve_model(body.model)

    async def generate():
        # ── Pass 1: base score (skip if client already has a local score) ─────
        base_score = 50
        gap_pct    = 20
        meta_out   = {}
        if body.baseScore >= 0:
            # Client provided local matcher score — skip AI Pass 1 entirely
            base_score = max(0, min(100, body.baseScore))
            gap_pct    = max(0, min(40,  body.gapPct if body.gapPct >= 0 else 20))
            meta_out   = {"base_score": base_score, "gap_pct": gap_pct}
            print(f"[JMA:v2:stream_q] pass1 skipped (client score={base_score} gap={gap_pct})")
        else:
            try:
                raw1, stop1 = await call_claude_cached(
                    system_blocks=sys_blocks,
                    user_content=BASE_ANALYSIS_USER.format(
                        scoring_rules=_SCORING_RULES,
                        job_text=job_text,
                    ),
                    max_tokens=1800,
                    model="claude-3-5-haiku",
                )
                if stop1 != "max_tokens":
                    a = parse_json_response(raw1)
                    base_score = max(0, min(100, int(a.get("base_score", 50))))
                    gap_pct    = max(0, min(40,  int(a.get("gap_pct",    20))))
                    reasoning  = a.get("scoring_reasoning", "")
                    if reasoning:
                        print(f"[JMA:v2:stream_q] scoring_reasoning:\n{reasoning}")
                    meta_out = {
                        "base_score":  base_score,
                        "gap_pct":     gap_pct,
                        "jobTitle":    a.get("jobTitle",    ""),
                        "company":     a.get("company",     ""),
                        "jobLanguage": a.get("jobLanguage", "english"),
                        "summary":     a.get("summary",     ""),
                        "strengths":   a.get("strengths",   []),
                        "hard_gaps":   a.get("hard_gaps",   []),
                    }
                    print(f"[JMA:v2:stream_q] pass1 base={base_score} gap={gap_pct}")
            except Exception as e:
                print(f"[JMA:v2:stream_q] pass1 error: {e}")

        yield f"data: {json.dumps({'meta': meta_out})}\n\n"

        # ── Pass 2: stream questions token-by-token ──────────────────────────
        if gap_pct > 0:
            n_q = 4 if gap_pct >= 20 else 3
            prompt = STREAM_QUESTIONS_LIVE_PROMPT.format(
                base_score=base_score,
                gap_pct=gap_pct,
                n_questions=n_q,
                job_text=job_text,
            )
            try:
                async with anthropic_client.messages.stream(
                    model="claude-sonnet-4-6",
                    max_tokens=700,
                    system=sys_blocks,
                    messages=[{"role": "user", "content": prompt}],
                ) as stream:
                    async for sse_chunk in _stream_q_parse(stream.text_stream):
                        yield sse_chunk
            except Exception as e:
                print(f"[JMA:v2:stream_q] pass2 error: {e}")

        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
