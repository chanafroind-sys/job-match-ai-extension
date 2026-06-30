import asyncio
import json
import os
import re
import urllib.parse
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from typing import Optional

import httpx
from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, StreamingResponse
from pydantic import BaseModel

load_dotenv()

BACKEND_URL = os.getenv("BACKEND_URL", "https://job-match-ai-extension.onrender.com")
ANTHROPIC_API_KEY: str = os.environ["ANTHROPIC_API_KEY"]
GUMROAD_PRODUCT_ID: str = os.environ["GUMROAD_PRODUCT_ID"]
MAX_DEVICES_PER_KEY: int = int(os.getenv("MAX_DEVICES_PER_KEY", "3"))
MONTHLY_USAGE_LIMIT: int = int(os.getenv("MONTHLY_USAGE_LIMIT", "100"))
USAGE_FILE = Path(__file__).parent / "usage.json"
CLICKS_FILE = Path(__file__).parent / "clicks.json"

# ── Premium ───────────────────────────────────────────────────────────────────

# Comma-separated list of license keys that get premium access
# regardless of Gumroad variants (useful for admin/dev keys)
_PREMIUM_KEYS_ENV = os.getenv("PREMIUM_KEYS", "")
STATIC_PREMIUM_KEYS: set = {k.strip() for k in _PREMIUM_KEYS_ENV.split(",") if k.strip()}

RAW_JOBS_FILE = Path(__file__).parent / "raw_jobs.json"
MAX_RAW_JOBS = 10_000


def _load_raw_jobs() -> list:
    try:
        return json.loads(RAW_JOBS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_raw_jobs(jobs: list) -> None:
    RAW_JOBS_FILE.write_text(json.dumps(jobs, ensure_ascii=False), encoding="utf-8")


def _quick_filter(jobs: list, cv_text: str) -> list:
    """Fast keyword pre-filter — no AI, removes obviously irrelevant jobs."""
    STOP = {
        "with","that","this","have","from","they","will","been","their","what","when",
        "more","also","into","than","then","some","which","them","these","those","would",
        "there","were","your","like","just","over","such","each","after","about","using",
        "work","years","team","skills","looking","good","strong","plus","great","know",
        "high","well","make","help","need","able","both","must","very","only","much",
    }
    cv_words = {w.lower() for w in re.findall(r'\b[a-zA-Z]{4,}\b', cv_text)} - STOP
    if len(cv_words) < 5:
        return jobs  # too few CV keywords — pass everything through
    filtered = []
    for job in jobs:
        text_lower = (job.get("text") or "").lower()
        if sum(1 for w in cv_words if w in text_lower) >= 2:
            filtered.append(job)
    return filtered

# ── Link tracking ─────────────────────────────────────────────────────────────

# Single-pass regex — three alternatives, evaluated in order:
#   group(1)+group(2) : markdown link  [display text](https://url)
#   group(3)          : raw URL with protocol  https://... or http://...
#   group(4)          : bare domain/path without protocol  github.com/user, mysite.io/portfolio, etc.
_LINK_RE = re.compile(
    r'\[([^\]]+)\]\((https?://[^\)]+)\)'                                          # markdown link
    r'|(https?://[^\s\)\]\"\'>]+)'                                                # raw URL w/ protocol
    r'|(?<![/\w@.])'                                                              # bare URL — not preceded by URL chars
      r'([a-zA-Z0-9][a-zA-Z0-9\-]{2,}\.(?:com|io|dev|me|net|org|co|ai|app|tech)'
      r'/[^\s\)\]\"\'>]+)'
)

def inject_tracking_links(cv_text: str, app_id: str) -> str:
    """Replace all URLs with tracking links.

    Handles three forms in order:
      1. [LINK:display|url]  — already-formatted tokens (Claude preserved from original CV);
                               rewrap the inner URL with a tracking URL, keep the display text.
      2. [text](url)         — markdown link
      3. https://...         — raw URL with protocol
      4. domain.com/path     — bare domain URL without protocol
    """
    def _make(url: str, display: str) -> str:
        url = re.sub(r'[.,;:!?]+$', '', url)
        display = re.sub(r'[.,;:!?]+$', '', display)
        full_url = url if url.startswith("http") else f"https://{url}"
        target = ("github" if "github.com" in full_url
                  else "linkedin" if "linkedin.com" in full_url
                  else "portfolio")
        enc = urllib.parse.quote(full_url, safe="")
        tracking = f"{BACKEND_URL}/api/v1/track?app_id={app_id}&target={target}&url={enc}"
        return f"[LINK:{display}|{tracking}]"

    # Pass 1 — rewrap any [LINK:display|url] tokens that Claude preserved verbatim.
    # Results are stashed behind NUL-delimited placeholders so that Pass 2's regex
    # cannot see (and double-wrap) the tracking URLs embedded inside them.
    _EXISTING_RE = re.compile(r'\[LINK:([^\|]*)\|([^\]]+)\]')
    _stash: dict[str, str] = {}

    def _pass1(m: re.Match) -> str:
        key = f"\x00{len(_stash)}\x00"
        _stash[key] = _make(m.group(2), m.group(1) or m.group(2))
        return key

    cv_text = _EXISTING_RE.sub(_pass1, cv_text)

    # Pass 2 — wrap any remaining raw / bare / markdown URLs Claude introduced.
    def _replace(m: re.Match) -> str:
        if m.group(1):                          # markdown [text](url)
            return _make(m.group(2), m.group(1))
        if m.group(3):                          # raw URL with protocol
            url = m.group(3)
            display = re.sub(r'^https?://', '', url).rstrip('/')
            return _make(url, display)
        url = m.group(4)                        # bare domain/path
        return _make(url, url.rstrip('/'))

    cv_text = _LINK_RE.sub(_replace, cv_text)

    # Restore Pass 1 results
    for key, val in _stash.items():
        cv_text = cv_text.replace(key, val)

    return cv_text

anthropic_client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)


# ── Usage tracking ────────────────────────────────────────────────────────────

def _load_usage() -> dict:
    try:
        return json.loads(USAGE_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_usage(data: dict) -> None:
    USAGE_FILE.write_text(json.dumps(data, indent=2))


def _month_key() -> str:
    now = datetime.utcnow()
    return f"{now.year}-{now.month:02d}"


def get_usage_count(license_key: str) -> int:
    usage = _load_usage()
    return usage.get(license_key, {}).get(_month_key(), 0)


def increment_usage(license_key: str) -> int:
    usage = _load_usage()
    month = _month_key()
    usage.setdefault(license_key, {})[month] = usage.get(license_key, {}).get(month, 0) + 1
    _save_usage(usage)
    return usage[license_key][month]


# ── Gumroad verification ──────────────────────────────────────────────────────

TEST_LICENSE_KEY = "TEST-MICHAL-FAKE-KEY"


async def verify_gumroad_license(license_key: str) -> dict:
    """Verify license via Gumroad API. Returns email, uses, and isPremium from variants."""
    masked = license_key[:4] + "****" if len(license_key) > 4 else "****"
    print(f"[JMA:verify] key={masked} len={len(license_key.strip())}")

    if license_key.strip() == TEST_LICENSE_KEY:
        print("[JMA:verify] TEST KEY — bypass OK")
        return {"email": "test@internal", "uses": 1, "isPremium": True}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://api.gumroad.com/v2/licenses/verify",
                data={
                    "product_id": GUMROAD_PRODUCT_ID,
                    "license_key": license_key.strip(),
                    "increment_uses_count": "false",
                },
            )
        data = resp.json()
        print(f"[JMA:verify] Gumroad status={resp.status_code} success={data.get('success')}")
    except Exception as e:
        print(f"[JMA:verify] Gumroad network error: {e}")
        raise HTTPException(status_code=503, detail="לא הצלחנו להגיע לשירות אימות הרישיון. נסי שוב בעוד רגע.")

    if not data.get("success"):
        print(f"[JMA:verify] Gumroad returned success=false: {data.get('message', '')}")
        raise HTTPException(status_code=403, detail="Invalid or expired license key.")

    purchase = data.get("purchase") or {}
    uses: int = purchase.get("uses", 0)
    if uses > MAX_DEVICES_PER_KEY:
        print(f"[JMA:verify] Too many devices: uses={uses} max={MAX_DEVICES_PER_KEY}")
        raise HTTPException(
            status_code=403,
            detail=f"This license key is active on {uses} devices, which exceeds the maximum allowed ({MAX_DEVICES_PER_KEY}). Please purchase a separate license.",
        )

    # Gumroad returns variants as a JSON-encoded string, e.g. '{"Plan": "Premium"}'
    variants_raw = purchase.get("variants", "")
    try:
        if isinstance(variants_raw, str) and variants_raw:
            variants = json.loads(variants_raw)
        else:
            variants = variants_raw or {}
    except (json.JSONDecodeError, TypeError):
        variants = {}

    plan = (variants.get("Plan") or variants.get("plan") or "").strip().lower()
    print(f"[JMA:verify] OK email={purchase.get('email','')} uses={uses} plan={plan!r} isPremium={plan=='premium'}")

    return {
        "email": purchase.get("email", ""),
        "uses": uses,
        "isPremium": plan == "premium",
    }


async def _verify_premium(license_key: str) -> bool:
    """Real-time premium check. Admin/static keys bypass Gumroad instantly."""
    k = license_key.strip()
    if k == TEST_LICENSE_KEY or k in STATIC_PREMIUM_KEYS:
        return True
    try:
        info = await verify_gumroad_license(k)
        return info.get("isPremium", False)
    except HTTPException:
        raise
    except Exception:
        return False


async def require_license(license_key: str) -> str:
    """Validate license and check monthly usage. Returns the license key on success."""
    if not license_key or not license_key.strip():
        print("[JMA:license] REJECTED — empty key")
        raise HTTPException(status_code=401, detail="No license key provided. Please enter a valid license key in the extension settings.")
    await verify_gumroad_license(license_key)
    count = get_usage_count(license_key)
    print(f"[JMA:license] usage={count}/{MONTHLY_USAGE_LIMIT}")
    if count >= MONTHLY_USAGE_LIMIT:
        print(f"[JMA:license] REJECTED — monthly limit reached")
        raise HTTPException(
            status_code=429,
            detail=f"Monthly usage limit reached ({MONTHLY_USAGE_LIMIT} analyses). Resets on the 1st of next month.",
        )
    return license_key


# ── Claude API ────────────────────────────────────────────────────────────────

async def call_claude(prompt: str, max_tokens: int = 1200) -> str:
    print(f"[JMA:claude] calling model prompt_len={len(prompt)} max_tokens={max_tokens}")
    last_exc: Exception | None = None
    for attempt in range(1, 4):
        try:
            message = await anthropic_client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
            result = "".join(block.text for block in message.content if hasattr(block, "text"))
            print(f"[JMA:claude] attempt={attempt} response_len={len(result)} stop_reason={message.stop_reason}")
            return result
        except Exception as e:
            last_exc = e
            print(f"[JMA:claude] attempt={attempt} ERROR: {type(e).__name__}: {e}")
            if attempt < 3:
                await asyncio.sleep(3)
    raise last_exc


def parse_json_response(text: str) -> dict:
    # 1. Try markdown code block (```json ... ```)
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if match:
        raw = match.group(1).strip()
    else:
        # 2. Try to extract the first {...} JSON object from the text
        #    (handles cases where Claude adds intro text before the JSON)
        obj_match = re.search(r'\{[\s\S]*\}', text)
        raw = obj_match.group(0) if obj_match else text.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"[JMA:parse] JSON decode error: {e} | raw_start={raw[:200]!r}")
        raise


def parse_json_array(text: str) -> list:
    """Parse Claude's response as a JSON array, stripping any markdown fences."""
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    raw = match.group(1).strip() if match else text.strip()
    arr_match = re.search(r'\[[\s\S]*\]', raw)
    if arr_match:
        raw = arr_match.group(0)
    result = json.loads(raw)
    return result if isinstance(result, list) else []


def parse_cv_sections_py(cv_text: str) -> dict:
    """Parse a structured CV (with [SECTION] markers) into {marker: content}."""
    markers = {'[NAME]', '[HEADLINE]', '[CONTACT]', '[PROFILE]',
               '[EXPERIENCE]', '[EDUCATION]', '[SKILLS]', '[LANGUAGES]'}
    sections: dict = {}
    current: str | None = None
    lines: list = []
    for line in cv_text.splitlines():
        clean = line.strip().lstrip('#').strip().strip('*').strip()
        if clean in markers:
            if current:
                sections[current] = '\n'.join(lines).strip()
            current, lines = clean, []
        elif current:
            lines.append(line)
    if current:
        sections[current] = '\n'.join(lines).strip()
    return sections


# ── Prompts ───────────────────────────────────────────────────────────────────

QUESTIONS_PROMPT = """You are a recruiter screening a candidate. Read the CV and job description, then identify 1-3 skills or experiences that are either missing from the CV or mentioned too vaguely to evaluate — and that are clearly required or strongly preferred by this job.

IMPORTANT: Always return at least 1 question. If the CV perfectly matches the job, still pick the most important skill to verify.
ALL text fields (question, why, heExplanation) MUST be written in Hebrew (עברית). Keep only skill names in English.

Return JSON only — no markdown, no explanation, no text before or after:
{{"questions":[{{"id":"q1","skill":"<skill name in English>","question":"<שאלת הבהרה קצרה בעברית>","why":"<למה זה חשוב לתפקיד זה בעברית, עד 15 מילים>","heExplanation":"<הסבר פשוט בעברית מה המיומנות הזו אומרת בפועל, עד 20 מילים>"}}]}}
=== CV ===
{cv_text}
=== JOB DESCRIPTION ===
{job_text}"""

ANALYZE_PROMPT = """You are a senior recruitment expert. Analyze the fit between the candidate's CV and the job posting.

MANDATORY LANGUAGE RULE: The fields summary, strengths, and hard_gaps MUST be written in Hebrew (עברית) — no exceptions, regardless of the job's language. Technical terms, skill names, and technologies stay in English inside the Hebrew sentences.

Rules:
- Score 0-100 based on how well real experience matches the requirements (be honest, do not inflate)
- Return JSON only (no markdown, no explanations):
{{
  "score": <0-100>,
  "jobTitle": "<job title from posting>",
  "company": "<company name>",
  "jobLanguage": "hebrew" | "english",
  "summary": "<2 sentences in Hebrew — MANDATORY Hebrew>",
  "strengths": ["<Hebrew sentence, skill names in English>", ...],
  "hard_gaps": ["<Hebrew sentence, skill name in English>", ...]
}}
{answers_section}
=== CV ===
{cv_text}
=== JOB DESCRIPTION ===
{job_text}"""

_CV_LANG_RULE_EN = """LANGUAGE RULE — 100% ENGLISH ONLY:
- The entire CV must be written in English from start to finish — no exceptions
- The candidate's name must always appear in English only — never translate it to Hebrew or any other language
- Do not mix any Hebrew words or characters anywhere in the document"""

_CV_LANG_RULE_HE = """LANGUAGE RULE — HEBREW OUTPUT:
- Write the entire CV in Hebrew (עברית) — this is mandatory
- The candidate's name: if it is a Hebrew name write it in Hebrew; if it is a Latin/English name keep it as-is
- Keep technical terms in English: programming languages (Python, Java, C++), frameworks (React, FastAPI, Node.js), tools (Docker, Git, AWS), company names, product names, software names
- Translate job titles and all section content to Hebrew (e.g. "Software Engineer" → "מהנדס תוכנה")
- Write in natural, professional Hebrew — not a word-for-word translation
- The document direction is right-to-left"""

_CV_LANG_CHECK_EN = "1. LANGUAGE: Is the entire CV in 100% English? If any Hebrew words or characters appear anywhere — translate or remove them. The candidate's name must remain in English exactly as written."

_CV_LANG_CHECK_HE = "1. LANGUAGE: Is the CV body written in Hebrew? Technical terms (technologies, tools, company names, software names) must stay in English — that is correct. But all prose — profile text, bullet points, job titles, education descriptions — must be in Hebrew. Fix any English prose that slipped through. Do NOT translate the candidate's name."

CV_PASS1_PROMPT = """You are a senior CV writer and recruiter expert.
Create a tailored CV in {language} based on the original CV and job requirements.

ABSOLUTE RULES — never break these:
1. ONE PAGE MAXIMUM — the final CV must fit on a single printed page, no exceptions. Cut the least relevant bullet points or shorten descriptions to stay within one page. Never sacrifice core tech, key metrics, or the profile to save space — cut filler first.
2. NEVER invent experience, skills, dates, or company names
3. Do not reorder major sections — always: Profile → Experience → Education → Skills → Languages
4. Languages section is ALWAYS last
5. Do NOT present freelance or independent projects as full-time employment positions
6. Do NOT change the chronological order of work experience entries
7. PRESERVE ALL URLs — every URL in the original CV (GitHub, LinkedIn, portfolio, personal site) MUST appear verbatim in the [CONTACT] section. Do NOT drop, shorten, or paraphrase any URL. If the original CV contains tokens of the form [LINK:display|url], copy them exactly as-is into [CONTACT] — do not alter them.

{language_rule}

COMPANY STRUCTURE IS SACRED — never break this:
- Keep every employer as its own separate block with its own company name, job title, and dates
- NEVER merge bullet points from different companies or roles into a single thematic list
- You may reorder bullet points WITHIN a single role to highlight the most relevant ones first
- You may NOT move bullets across roles or companies under any circumstances
- Use `$ ` (dollar-sign + space) as the bullet marker for ALL bullet points — e.g. `$ Built a REST API using FastAPI`
- Do NOT use •, -, *, –, or any other bullet character — only `$ ` at the start of bullet lines

HEADLINE / SENIORITY GUARDRAILS:
- Use the candidate's real core title as the base (e.g. Backend Developer, Software Engineer)
- You may append a focused orientation if supported by real coursework or projects (e.g. Backend Developer | AI & Data Foundations) — keep it subtle and credible
- Do NOT add seniority levels (Senior, Lead, Staff, Principal, etc.) unless the candidate's CV explicitly shows they held such a title
- Do NOT introduce a completely new domain title based on courses alone

PROFILE WRITING RULES:
- Write what the candidate genuinely brings from their real experience
- Do NOT copy or paraphrase sentences from the job description
- The profile must sound like the candidate speaking about themselves
- Make it personal, specific, and grounded in what is actually in the CV

CORE TECH & HIGH-VALUE METRICS — never omit these:
- NEVER remove core programming languages or technologies from the original CV
- SCAN the original CV for outstanding high-value data points: perfect/near-perfect grades, academic honors, scholarships, significant quantitative achievements
- If the target role requires algorithmic, mathematical, or research-heavy skills: surface any strong math background prominently in the PROFILE
- For all other roles: bring relevant quantitative achievements into the PROFILE or top bullet points
- These high-value signals must never be buried or cut

BOLD FORMATTING FOR RECRUITER SCANNING:
- Use **double asterisks** around 3–6 key terms per section — this applies to EVERY section including [PROFILE]
- In [PROFILE]: bold 2–4 role-relevant technologies or measurable skills (e.g. **Python**, **FastAPI**, **95% test coverage**)
- In [EXPERIENCE] bullets: bold the most impactful technology or metric per bullet
- Bold: specific technologies, measurable achievements, and role-critical skills
- Do NOT bold generic words (e.g. "team player", "motivated", "experience")

OUTPUT FORMAT — use these exact section markers. Rules:
- Write each marker on its own line, exactly as shown — no #, no **, no other prefix or suffix
- Immediately follow each marker with the real content on the next line — no blank line between marker and content
- Do NOT write the marker name as a heading or label — it is replaced by the parser

[NAME]
[HEADLINE]
[CONTACT]
[PROFILE]
[EXPERIENCE]
[EDUCATION]
[SKILLS]
[LANGUAGES]
=== ORIGINAL CV ===
{cv_text}
=== CANDIDATE ANSWERS TO QUESTIONS ===
{answers_text}
=== JOB DESCRIPTION ===
{job_text}"""

CV_PASS2_PROMPT = """You are a ruthless senior recruiter reviewing a tailored CV before it goes to a hiring manager.
Review and improve this CV against ALL of these criteria — fix every issue you find:

{language_check}
2. COMPANY STRUCTURE: Is every employer kept as its own separate block? If bullet points from different companies or roles have been merged — restore the original per-company structure immediately.
3. PROFILE AUTHENTICITY: Does the profile sound like the candidate speaking from their real experience? If it echoes the job description's language — rewrite it.
4. SENIORITY CHECK: Remove any Senior/Lead/Staff/Principal or inflated domain title not supported by actual held job titles. A subtle orientation suffix is acceptable if backed by real projects or courses.
5. BOLD FORMATTING: Are 3–6 key terms per section bolded with **double asterisks**? Bold specific technologies, measurable results, and role-critical skills.
6. SPECIFICITY: Remove vague buzzwords. Replace with concrete examples or remove entirely.
7. LENGTH: Must fit ONE page. Cut filler first. Core tech, key metrics, and the profile must be preserved.
8. HUMAN TONE: Should not sound AI-generated. Adjust phrasing if needed.
9. CORE TECH & METRICS PRESERVATION: Are all core programming languages still present? Are high-value data points (grades, honors, achievements) visible? Restore if removed.
10. HONESTY: Do not add anything not in the original CV. Do not present freelance work as full-time employment.
11. URLs: Are all URLs from the draft present verbatim in [CONTACT]? GitHub, LinkedIn, portfolio, and personal site URLs must not be removed or shortened. Restore any missing URLs exactly as they appear in the draft. If the draft contains [LINK:display|url] tokens, copy them unchanged — do not unwrap or reformat them.

Output ONLY the improved CV using the same section markers.
CRITICAL FORMAT RULES — any violation breaks the Word document:
- Write each marker on its own line exactly: [NAME], [HEADLINE], [CONTACT], [PROFILE], [EXPERIENCE], [EDUCATION], [SKILLS], [LANGUAGES]
- Do NOT prefix markers with #, ##, **, or any other character
- Do NOT add explanations, comments, or labels outside the CV content
=== CV TO REVIEW ===
{cv_draft}
=== JOB DESCRIPTION ===
{job_text}"""


# ── Diff-screen constants & prompt ────────────────────────────────────────────

DIFF_SECTIONS = ['[PROFILE]', '[EXPERIENCE]', '[EDUCATION]', '[SKILLS]', '[LANGUAGES]']
SECTION_LABELS = {
    '[PROFILE]':    'פרופיל',
    '[EXPERIENCE]': 'ניסיון תעסוקתי',
    '[EDUCATION]':  'השכלה',
    '[SKILLS]':     'כישורים',
    '[LANGUAGES]':  'שפות',
}

CV_DIFF_PROMPT = """You are a CV comparison assistant.

I provide you with 5 sections from an AI-ADAPTED CV and the full text of the ORIGINAL CV.
For each section: find the matching content in the ORIGINAL CV, then compare it to the adapted version.

Return ONLY a valid JSON array — no markdown fences, no extra text, just the raw JSON array.

Each element must have exactly these fields:
{{"id":<integer>,"section_name":"<marker>","label":"<Hebrew label>","original_text":"<matched text from ORIGINAL CV — copy verbatim>","updated_text":"<the adapted text provided below>","changed":<true|false>,"explanation_hebrew":"<≤12-word Hebrew sentence — why this helps for the job; empty string if not changed>"}}

Sections from the ADAPTED CV:
{sections_block}

Rules:
- original_text: find the relevant paragraph(s) in the ORIGINAL CV by meaning — copy verbatim from it
- changed: true only when there is a meaningful semantic difference (ignore punctuation/whitespace)
- explanation_hebrew: mention specific keywords or technologies added; empty string if changed is false
- If a section exists in ADAPTED but has no equivalent in ORIGINAL, set original_text to ""

=== ORIGINAL CV ===
{original_cv}

=== JOB CONTEXT (first 200 chars) ===
{job_context}"""


# ── Request / Response models ─────────────────────────────────────────────────

class VerifyLicenseRequest(BaseModel):
    licenseKey: str

class AnalyzeRequest(BaseModel):
    licenseKey: Optional[str] = None
    cvText: str
    jobText: str
    answers: list = []
    preflight: bool = False

class GenerateCVRequest(BaseModel):
    licenseKey: Optional[str] = None
    cvText: str
    jobText: str
    jobLanguage: str = "english"
    answers: list[dict] = []
    cvUrls: list[str] = []
    userConstraints: str = ""

class RankJobsRequest(BaseModel):
    licenseKey: Optional[str] = None
    cvText: str
    jobs: list[dict]

async def _rank_single_job(cv_summary: str, job: dict) -> Optional[dict]:
    """Score one job against the CV with a focused single-job prompt. Returns None on failure."""
    title = job.get("title") or "Unknown"
    url = job.get("url") or ""
    text = (job.get("text") or "")[:2000]
    job_block = f"{title}\n{url}\n\n{text}"
    prompt = RANK_SINGLE_JOB_PROMPT.format(cv_summary=cv_summary, job_text=job_block)
    try:
        raw = await call_claude(prompt, max_tokens=120)
        item = parse_json_response(raw)
        if isinstance(item, dict) and "score" in item:
            return {
                "job": job,
                "score": max(0, min(100, int(item["score"]))),
                "pro": str(item.get("pro", "")),
                "con": str(item.get("con", "")),
            }
    except Exception:
        pass
    return None


class ScrapeJobRequest(BaseModel):
    url: str
    text: str
    title: str = ""

class ImportJobsRequest(BaseModel):
    cvText: str
    minScore: int = 70
    timeRange: str = "3days"  # "3days" | "since_last"

RANK_SINGLE_JOB_PROMPT = """You are a strict senior engineering hiring manager. Score this single job posting against the candidate's CV.

SCORING — start from 100 and deduct:
- Experience shortfall: (required_yrs - actual_yrs) / required_yrs × 35 pts
- Missing required tech: -15 to -25 per item (proportional to how central it is)
- Seniority mismatch (Senior/Lead/Staff/Principal not in CV): cap at 65
- Domain mismatch (e.g. embedded vs web): cap at 55
- Missing preferred/nice-to-have: -3 to -8 each
Partial offsets (secondary gaps only): strong academics +5, adjacent skills +5, relevant projects +5

CALIBRATION: 85+ shortlist | 70-84 interview | 55-69 real gaps | <40 wrong fit

Return ONLY valid JSON — no markdown, no explanation:
{{"score": <0-100>, "pro": "<max 10 words — strongest match signal>", "con": "<max 10 words — biggest gap>"}}

=== CANDIDATE CV ===
{cv_summary}

=== JOB POSTING ===
{job_text}"""

RANK_JOBS_PROMPT = """You are a strict but fair senior engineering hiring manager.
Score how well THIS candidate's CV matches each job listing. Be honest and realistic.

STEP 1 — READ THE JOB TEXT AND CLASSIFY EACH REQUIREMENT:
- "required" / "must" / "mandatory" / listed first → CRITICAL
- "preferred" / "advantage" / "nice to have" / listed later → SECONDARY
- When the job is vague, infer criticality from position and emphasis in the text

STEP 2 — SCORE BASED ON ACTUAL FIT:
Start from 100 and deduct based on what is missing:

CRITICAL gaps (each deduction is proportional to how critical the requirement appears):
- Years of experience shortfall: required N yrs, CV shows M yrs → deduct ~(N-M)/N × 35 pts
  (e.g. 4yr req, 2yr CV → -17; 5yr req, 0yr CV → -35)
- Missing core tech listed as "required": -15 to -25 per item depending on how central it is
- Seniority mismatch: Senior/Lead/Staff title with no evidence of that level in CV → cap score at 65
- Domain mismatch (e.g. embedded vs web): cap score at 55

SECONDARY gaps: -3 to -8 per missing item

POSITIVE signals that can partially offset secondary gaps (not critical ones):
- Strong relevant academic background: +5
- Closely adjacent skills that transfer: +5
- Relevant projects or open source: +5

CALIBRATION:
- 85+: Strong match — would shortlist immediately
- 70-84: Good match — worth an interview despite minor gaps
- 55-69: Partial match — real gaps exist
- 40-54: Significant blocker — not ready for this role level
- <40: Wrong domain or severe experience shortfall

OUTPUT — return ONLY a valid JSON array, no markdown, no explanation:
[{{"index":0,"score":72,"pro":"...","con":"..."}}]
- pro: one sentence max 10 words — strongest signal in this candidate's favor
- con: one sentence max 10 words — single most serious gap for THIS specific job

=== CANDIDATE CV ===
{cv_summary}

=== JOBS TO RANK ===
{jobs_list}"""


# ── App ───────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    if not ANTHROPIC_API_KEY:
        print("WARNING: ANTHROPIC_API_KEY is not set")
    if not GUMROAD_PRODUCT_ID:
        print("WARNING: GUMROAD_PRODUCT_ID is not set")
    yield

app = FastAPI(title="Job Match AI Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/verify-license")
async def verify_license(body: VerifyLicenseRequest):
    info = await verify_gumroad_license(body.licenseKey)
    usage_count = get_usage_count(body.licenseKey)
    return {
        "success": True,
        "usageCount": usage_count,
        "monthlyLimit": MONTHLY_USAGE_LIMIT,
        "email": info["email"],
        "isPremium": info.get("isPremium", False),
    }


@app.post("/api/analyze")
async def analyze(body: AnalyzeRequest, x_license_key: Optional[str] = Header(None)):
    license_key = x_license_key or body.licenseKey or ""
    print(f"[JMA:analyze] cv_len={len(body.cvText)} job_len={len(body.jobText)} preflight={body.preflight} answers={len(body.answers)}")

    if body.preflight:
        # Lightweight: return questions only, verify license but don't count usage
        await verify_gumroad_license(license_key)
        prompt = QUESTIONS_PROMPT.format(cv_text=body.cvText[:1500], job_text=body.jobText[:2000])
        try:
            raw = await call_claude(prompt, max_tokens=600)
            print(f"[JMA:preflight] raw_len={len(raw)} raw_start={raw[:200]!r}")
            result = parse_json_response(raw)
            q_count = len(result.get("questions", []))
            print(f"[JMA:preflight] parsed ok, questions={q_count}")
            return {"result": result, "preflight": True}
        except Exception as e:
            print(f"[JMA:preflight] error: {type(e).__name__}: {e}")
            return {"result": {"questions": []}, "preflight": True}

    await require_license(license_key)

    answers_text = "\n".join(
        f"- {a.get('skill', '')}: {a.get('answer', '')}"
        for a in (body.answers or [])
        if a.get('answer') and a.get('answer') not in ('לא ענה', '')
    )
    answers_section = (
        f"=== CANDIDATE'S ANSWERS TO SCREENING QUESTIONS ===\n{answers_text}\n"
        if answers_text else ""
    )

    prompt = ANALYZE_PROMPT.format(cv_text=body.cvText, job_text=body.jobText, answers_section=answers_section)

    last_error: Exception | None = None
    for attempt in range(3):
        try:
            print(f"[JMA:analyze] attempt {attempt+1}/3")
            raw = await call_claude(prompt, max_tokens=1200)
            result = parse_json_response(raw)
            increment_usage(license_key)
            print(f"[JMA:analyze] SUCCESS score={result.get('score','?') if isinstance(result,dict) else '?'}")
            return {"result": result}
        except json.JSONDecodeError as e:
            print(f"[JMA:analyze] attempt {attempt+1} JSON error: {e}")
            last_error = e
        except Exception as e:
            print(f"[JMA:analyze] attempt {attempt+1} error: {type(e).__name__}: {e}")
            last_error = e
            if "401" in str(e) or "429" in str(e):
                break

    print(f"[JMA:analyze] FAILED after retries: {last_error}")
    raise HTTPException(status_code=500, detail=str(last_error) or "Analysis failed.")


@app.post("/api/generate-cv")
async def generate_cv(body: GenerateCVRequest, x_license_key: Optional[str] = Header(None)):
    license_key = x_license_key or body.licenseKey or ""
    await require_license(license_key)

    is_hebrew = body.jobLanguage == "hebrew"
    language = "Hebrew" if is_hebrew else "English"
    language_rule = _CV_LANG_RULE_HE if is_hebrew else _CV_LANG_RULE_EN
    language_check = _CV_LANG_CHECK_HE if is_hebrew else _CV_LANG_CHECK_EN
    answers_text = (
        "\n".join(f"{a.get('skill', '')}: {a.get('answer', '')}" for a in body.answers)
        if body.answers
        else "No additional information provided."
    )

    # Build explicit URL instruction — ensures Claude puts hyperlink URLs in [CONTACT]
    # even if it doesn't parse the raw URL embedded in the CV text.
    url_instruction = ""
    if body.cvUrls:
        url_list = "\n".join(f"  - {u}" for u in body.cvUrls)
        url_instruction = (
            f"\n\nMANDATORY CONTACT URLS — the original CV contained these hyperlinks."
            f" Every one of them MUST appear verbatim as its own line in [CONTACT]:\n{url_list}"
        )

    constraints_block = ""
    if body.userConstraints and body.userConstraints.strip():
        constraints_block = (
            f"\n\n<user_constraints>\n"
            f"These are the user's personal hard rules. They MUST be followed without exception, "
            f"even if they conflict with general CV best practices or the job description:\n"
            f"{body.userConstraints.strip()}\n"
            f"</user_constraints>"
        )

    pass1_prompt = CV_PASS1_PROMPT.format(
        language=language,
        language_rule=language_rule,
        cv_text=body.cvText,
        answers_text=answers_text,
        job_text=body.jobText,
    ) + url_instruction + constraints_block
    cv_draft = await call_claude(pass1_prompt, max_tokens=2000)

    pass2_prompt = CV_PASS2_PROMPT.format(
        language_check=language_check,
        cv_draft=cv_draft,
        job_text=body.jobText,
    ) + url_instruction + constraints_block
    cv_final = await call_claude(pass2_prompt, max_tokens=2000)

    # Inject tracking links only when original CV had GitHub/LinkedIn URLs
    app_id = str(uuid.uuid4())[:8]
    cv_final = inject_tracking_links(cv_final, app_id)

    # ── Diff pass: compare original CV to adapted CV, generate Hebrew explanations ──
    sections: list = []
    try:
        adapted_secs = parse_cv_sections_py(cv_final)
        sections_block_parts = []
        for idx, marker in enumerate(DIFF_SECTIONS, start=1):
            content = adapted_secs.get(marker, '').strip()
            if not content:
                continue
            label = SECTION_LABELS[marker]
            # Truncate very long sections to keep prompt size reasonable
            truncated = content[:600] + ('…' if len(content) > 600 else '')
            sections_block_parts.append(
                f"Section {idx} — {marker} (label: {label}, id: {idx}):\n{truncated}"
            )
        if sections_block_parts:
            diff_prompt = CV_DIFF_PROMPT.format(
                sections_block='\n\n'.join(sections_block_parts),
                original_cv=body.cvText[:3000],
                job_context=body.jobText[:200],
            )
            raw_diff = await call_claude(diff_prompt, max_tokens=1800)
            sections = parse_json_array(raw_diff)
            print(f"[JMA:diff] parsed {len(sections)} sections")
    except Exception as e:
        print(f"[JMA:diff] diff pass failed — {type(e).__name__}: {e}")
        sections = []

    increment_usage(license_key)
    return {"cvText": cv_final, "appId": app_id, "sections": sections}


@app.get("/api/v1/clicks")
async def get_clicks(app_ids: str = ""):
    """Return click events for the given comma-separated app_ids."""
    ids = {i.strip() for i in app_ids.split(",") if i.strip()}
    try:
        all_clicks: list = json.loads(CLICKS_FILE.read_text()) if CLICKS_FILE.exists() else []
    except (json.JSONDecodeError, OSError):
        all_clicks = []
    result: dict = {}
    for c in all_clicks:
        aid = c.get("app_id", "")
        if aid in ids:
            result.setdefault(aid, []).append({
                "target": c.get("target"),
                "url": c.get("url"),
                "ts": c.get("ts"),
            })
    return {"clicks": result}


@app.get("/api/analytics/market-compare")
async def market_compare(years_exp: int = 3, title: str = "Software Engineer"):
    """
    Return anonymised market-benchmark data for the requesting developer's profile.
    Currently returns a stable mock; will be backed by aggregated opt-in telemetry.
    """
    # Tier buckets so the mock feels context-sensitive
    if years_exp <= 1:
        percentile, avg_days = 45, 14
        companies = [
            {"name": "WalkMe", "openings": 5},
            {"name": "Fiverr", "openings": 4},
            {"name": "IronSource", "openings": 3},
        ]
    elif years_exp <= 3:
        percentile, avg_days = 63, 10
        companies = [
            {"name": "Monday.com", "openings": 14},
            {"name": "Wix", "openings": 11},
            {"name": "Amdocs", "openings": 9},
        ]
    elif years_exp <= 6:
        percentile, avg_days = 79, 6
        companies = [
            {"name": "Microsoft IL", "openings": 31},
            {"name": "Google IL", "openings": 26},
            {"name": "Checkpoint", "openings": 22},
        ]
    else:
        percentile, avg_days = 93, 3
        companies = [
            {"name": "Amazon IL", "openings": 48},
            {"name": "Meta IL", "openings": 41},
            {"name": "Nvidia IL", "openings": 37},
        ]

    return {
        "percentile": percentile,
        "avg_response_days": avg_days,
        "top_trending_companies": companies,
        "week_activity": {
            "applications_avg_peers": 4,
        },
        "response_rate": {
            "market_avg_pct": 21,
        },
        "profile": {"years_exp": years_exp, "title": title},
    }


@app.get("/api/v1/track")
async def track_click(app_id: str, target: str, url: str):
    """Log a link click and redirect to the original URL."""
    try:
        clicks: list = json.loads(CLICKS_FILE.read_text()) if CLICKS_FILE.exists() else []
    except (json.JSONDecodeError, OSError):
        clicks = []
    clicks.append({
        "app_id": app_id,
        "target": target,
        "url": url,
        "ts": datetime.utcnow().isoformat(),
    })
    try:
        CLICKS_FILE.write_text(json.dumps(clicks, indent=2))
    except OSError:
        pass
    return RedirectResponse(url=url, status_code=302)


@app.post("/api/rank-jobs")
async def rank_jobs(body: RankJobsRequest, x_license_key: Optional[str] = Header(None)):
    license_key = x_license_key or body.licenseKey or ""
    print(f"[JMA:rank] jobs={len(body.jobs)} cv_len={len(body.cvText)}")
    await require_license(license_key)

    def job_text(j, i):
        detail = j.get('fullText') or j.get('snippet') or ''
        company = f" at {j.get('company')}" if j.get('company') else ''
        return f"{j.get('index', i)}. {j.get('title', '?')}{company}: {detail[:1500]}"

    jobs_list = "\n\n".join(job_text(j, i) for i, j in enumerate(body.jobs[:12]))
    cv_summary = body.cvText[:800]
    prompt = RANK_JOBS_PROMPT.format(cv_summary=cv_summary, jobs_list=jobs_list)
    print(f"[JMA:rank] prompt_len={len(prompt)} jobs_included={min(len(body.jobs),12)}")

    last_error: Exception | None = None
    for attempt in range(2):
        try:
            print(f"[JMA:rank] attempt {attempt+1}/2")
            raw = await call_claude(prompt, max_tokens=1200)
            ranked = parse_json_response(raw)
            if not isinstance(ranked, list):
                print(f"[JMA:rank] response is not a list: {type(ranked)} val={str(ranked)[:100]}")
                raise ValueError(f"Expected JSON array, got {type(ranked).__name__}: {str(ranked)[:80]}")

            jobs_map = {j.get('index', i): j for i, j in enumerate(body.jobs)}
            result = []
            for item in ranked:
                idx = item.get('index', 0)
                original = jobs_map.get(idx) or (body.jobs[idx] if idx < len(body.jobs) else {})
                result.append({
                    "index": idx,
                    "title": original.get('title', ''),
                    "company": original.get('company', ''),
                    "score": max(0, min(100, int(item.get('score', 50)))),
                    "pro": item.get('pro', ''),
                    "con": item.get('con', ''),
                })
            increment_usage(license_key)
            print(f"[JMA:rank] SUCCESS returned {len(result)} ranked jobs")
            return {"rankedJobs": result}
        except Exception as e:
            print(f"[JMA:rank] attempt {attempt+1} error: {type(e).__name__}: {e}")
            last_error = e

    print(f"[JMA:rank] FAILED: {last_error}")
    raise HTTPException(status_code=500, detail=str(last_error) or "Ranking failed.")


@app.post("/api/scrape-job")
async def scrape_job(body: ScrapeJobRequest):
    """Crowdsourced silent job scraping — no auth, no AI. Just dedup + store."""
    url = body.url.strip()
    if not url or not url.startswith("http"):
        raise HTTPException(status_code=400, detail="Invalid URL")

    jobs = _load_raw_jobs()
    existing_urls = {j["url"] for j in jobs}
    if url in existing_urls:
        return {"status": "duplicate"}

    jobs.append({
        "url": url,
        "text": body.text[:5000],
        "title": (body.title or "")[:200],
        "ts": datetime.utcnow().isoformat(),
    })

    if len(jobs) > MAX_RAW_JOBS:
        jobs = jobs[-MAX_RAW_JOBS:]

    _save_raw_jobs(jobs)
    return {"status": "saved"}


@app.post("/api/import-jobs")
async def import_jobs(body: ImportJobsRequest, x_license_key: Optional[str] = Header(None)):
    """Premium: 2-stage filtering of scraped jobs → Excel download."""
    license_key = x_license_key or ""

    # Real-time Gumroad premium check (TEST_LICENSE_KEY bypasses instantly)
    if not await _verify_premium(license_key):
        raise HTTPException(status_code=403, detail="דרוש רישיון פרימיום לפיצ'ר זה.")

    all_jobs = _load_raw_jobs()
    if not all_jobs:
        raise HTTPException(
            status_code=404,
            detail="עדיין לא נאספו משרות. המשיכי לגלוש — כל משרה שתבקרי בה תיאסף אוטומטית.",
        )

    # Time filter
    if body.timeRange == "since_last":
        usage = _load_usage()
        cutoff = usage.get(license_key, {}).get("last_import_ts", "")
        if not cutoff:
            cutoff = (datetime.utcnow() - timedelta(days=30)).isoformat()
    else:
        cutoff = (datetime.utcnow() - timedelta(days=3)).isoformat()

    time_filtered = [j for j in all_jobs if (j.get("ts") or "") >= cutoff]
    if not time_filtered:
        raise HTTPException(status_code=404, detail="לא נמצאו משרות חדשות בטווח הזמן שנבחר.")

    # Step 1: fast keyword filter — no AI, no cost
    step1 = _quick_filter(time_filtered, body.cvText)
    if not step1:
        raise HTTPException(status_code=404, detail="לא נמצאו משרות רלוונטיות לאחר סינון ראשוני.")

    step1 = step1[:100]  # cost cap before Claude

    # Step 2: concurrent per-job Claude scoring (semaphore limits to 5 parallel calls)
    cv_summary = body.cvText[:800]
    sem = asyncio.Semaphore(5)

    async def rank_with_sem(job: dict):
        async with sem:
            return await _rank_single_job(cv_summary, job)

    results = await asyncio.gather(*[rank_with_sem(j) for j in step1], return_exceptions=True)

    ranked: list[dict] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        if result["score"] >= body.minScore:
            job = result["job"]
            ranked.append({
                "Title": job.get("title", ""),
                "URL": job.get("url", ""),
                "Score": result["score"],
                "Pro": result["pro"],
                "Con": result["con"],
                "Date": (job.get("ts") or "")[:10],
            })

    if not ranked:
        raise HTTPException(
            status_code=404,
            detail=f"לא נמצאו משרות שעוברות את אחוז ההתאמה המינימלי ({body.minScore}%). נסי להוריד את הסף.",
        )

    ranked.sort(key=lambda x: x["Score"], reverse=True)

    # Save last import timestamp
    usage = _load_usage()
    usage.setdefault(license_key, {})["last_import_ts"] = datetime.utcnow().isoformat()
    _save_usage(usage)

    # Generate Excel
    try:
        import pandas as pd
        from openpyxl.styles import Alignment, Font, PatternFill

        df = pd.DataFrame(ranked, columns=["Title", "URL", "Score", "Pro", "Con", "Date"])
        output = BytesIO()
        with pd.ExcelWriter(output, engine="openpyxl") as writer:
            df.to_excel(writer, index=False, sheet_name="Matched Jobs")
            ws = writer.sheets["Matched Jobs"]
            for cell in ws[1]:
                cell.font = Font(bold=True, color="FFFFFF")
                cell.fill = PatternFill(fill_type="solid", fgColor="7C3AED")
                cell.alignment = Alignment(horizontal="center")
            for col in ws.columns:
                max_len = max((len(str(c.value or "")) for c in col), default=10)
                ws.column_dimensions[col[0].column_letter].width = min(max_len + 4, 60)
        output.seek(0)
    except ImportError:
        raise HTTPException(status_code=500, detail="Excel generation unavailable on this server.")

    filename = f"JobMatchAI_{datetime.utcnow().strftime('%Y%m%d')}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
