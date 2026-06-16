import json
import os
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from anthropic import AsyncAnthropic
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

ANTHROPIC_API_KEY: str = os.environ["ANTHROPIC_API_KEY"]
GUMROAD_PRODUCT_ID: str = os.environ["GUMROAD_PRODUCT_ID"]
MAX_DEVICES_PER_KEY: int = int(os.getenv("MAX_DEVICES_PER_KEY", "3"))
MONTHLY_USAGE_LIMIT: int = int(os.getenv("MONTHLY_USAGE_LIMIT", "100"))
USAGE_FILE = Path(__file__).parent / "usage.json"

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

async def verify_gumroad_license(license_key: str) -> dict:
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

    if not data.get("success"):
        raise HTTPException(status_code=403, detail="Invalid or expired license key.")

    uses: int = (data.get("purchase") or {}).get("uses", 0)
    if uses > MAX_DEVICES_PER_KEY:
        raise HTTPException(
            status_code=403,
            detail=f"This license key is active on {uses} devices, which exceeds the maximum allowed ({MAX_DEVICES_PER_KEY}). Please purchase a separate license.",
        )

    return {"email": (data.get("purchase") or {}).get("email", ""), "uses": uses}


async def require_license(license_key: str) -> str:
    """Validate license and check monthly usage. Returns the license key on success."""
    await verify_gumroad_license(license_key)
    count = get_usage_count(license_key)
    if count >= MONTHLY_USAGE_LIMIT:
        raise HTTPException(
            status_code=429,
            detail=f"Monthly usage limit reached ({MONTHLY_USAGE_LIMIT} analyses). Resets on the 1st of next month.",
        )
    return license_key


# ── Claude API ────────────────────────────────────────────────────────────────

async def call_claude(prompt: str, max_tokens: int = 1200) -> str:
    message = await anthropic_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(block.text for block in message.content if hasattr(block, "text"))


def parse_json_response(text: str) -> dict:
    import re
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    return json.loads(match.group(1).strip() if match else text.strip())


# ── Prompts ───────────────────────────────────────────────────────────────────

ANALYZE_PROMPT = """You are a senior recruitment expert. Analyze the fit between the candidate's CV and the job posting.
Rules:
- Score 0-100 based on how well the real experience matches the requirements
- Identify missing mandatory requirements (hard_gaps)
- Identify missing "nice to have" requirements — these will be asked of the candidate (questions)
- Questions: only about things that could change the hiring decision, maximum 3 questions
- Detect the language of the job posting
Return JSON only (no markdown, no explanations):
{{
  "score": <0-100>,
  "jobTitle": "<job title>",
  "company": "<company name>",
  "jobLanguage": "hebrew" | "english",
  "summary": "<2 sentences: why this is or isn't a good fit>",
  "strengths": ["<short strength>", ...],
  "hard_gaps": ["<missing mandatory requirement>", ...],
  "questions": [
    {{
      "id": "q1",
      "skill": "<skill name>",
      "question": "<short question in the job's language>",
      "why": "<why this matters for the role>"
    }}
  ]
}}
=== CV ===
{cv_text}
=== JOB DESCRIPTION ===
{job_text}"""

CV_PASS1_PROMPT = """You are a senior CV writer and recruiter expert.
Create a tailored CV in {language} based on the original CV and job requirements.

ABSOLUTE RULES — never break these:
1. ONE PAGE MAXIMUM — the final CV must fit on a single printed page, no exceptions. Cut the least relevant bullet points or shorten descriptions to stay within one page. Never sacrifice core tech, key metrics, or the profile to save space — cut filler first.
2. NEVER invent experience, skills, dates, or company names
3. Do not reorder major sections — always: Profile → Experience → Education → Skills → Languages
4. Languages section is ALWAYS last
5. Do NOT present freelance or independent projects as full-time employment positions
6. Do NOT change the chronological order of work experience entries

LANGUAGE RULE — 100% ENGLISH ONLY:
- The entire CV must be written in English from start to finish — no exceptions
- The candidate's name must always appear in English only — never translate it to Hebrew or any other language
- Do not mix any Hebrew words or characters anywhere in the document

COMPANY STRUCTURE IS SACRED — never break this:
- Keep every employer as its own separate block with its own company name, job title, and dates
- NEVER merge bullet points from different companies or roles into a single thematic list
- You may reorder bullet points WITHIN a single role to highlight the most relevant ones first
- You may NOT move bullets across roles or companies under any circumstances

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
- Use **double asterisks** around 3–6 key terms per section
- Bold: specific technologies, measurable achievements, and role-critical skills
- Do NOT bold generic words (e.g. "team player", "motivated", "experience")

OUTPUT FORMAT — use these exact section markers:
[NAME]
Full name here
[HEADLINE]
Job title here
[CONTACT]
Contact details here
[PROFILE]
Profile text here
[EXPERIENCE]
Experience entries here
[EDUCATION]
Education entries here
[SKILLS]
Skills here
[LANGUAGES]
Languages here (always last)
=== ORIGINAL CV ===
{cv_text}
=== CANDIDATE ANSWERS TO QUESTIONS ===
{answers_text}
=== JOB DESCRIPTION ===
{job_text}"""

CV_PASS2_PROMPT = """You are a ruthless senior recruiter reviewing a tailored CV before it goes to a hiring manager.
Review and improve this CV against ALL of these criteria — fix every issue you find:

1. LANGUAGE: Is the entire CV in 100% English? If any Hebrew words or characters appear anywhere — translate or remove them. The candidate's name must remain in English exactly as written.
2. COMPANY STRUCTURE: Is every employer kept as its own separate block? If bullet points from different companies or roles have been merged — restore the original per-company structure immediately.
3. PROFILE AUTHENTICITY: Does the profile sound like the candidate speaking from their real experience? If it echoes the job description's language — rewrite it.
4. SENIORITY CHECK: Remove any Senior/Lead/Staff/Principal or inflated domain title not supported by actual held job titles. A subtle orientation suffix is acceptable if backed by real projects or courses.
5. BOLD FORMATTING: Are 3–6 key terms per section bolded with **double asterisks**? Bold specific technologies, measurable results, and role-critical skills.
6. SPECIFICITY: Remove vague buzzwords. Replace with concrete examples or remove entirely.
7. LENGTH: Must fit ONE page. Cut filler first. Core tech, key metrics, and the profile must be preserved.
8. HUMAN TONE: Should not sound AI-generated. Adjust phrasing if needed.
9. CORE TECH & METRICS PRESERVATION: Are all core programming languages still present? Are high-value data points (grades, honors, achievements) visible? Restore if removed.
10. HONESTY: Do not add anything not in the original CV. Do not present freelance work as full-time employment.

Output ONLY the improved CV with the same section markers:
[NAME], [HEADLINE], [CONTACT], [PROFILE], [EXPERIENCE], [EDUCATION], [SKILLS], [LANGUAGES]
Do NOT add explanations, comments, or notes outside the CV.
=== CV TO REVIEW ===
{cv_draft}
=== JOB DESCRIPTION ===
{job_text}"""


# ── Request / Response models ─────────────────────────────────────────────────

class VerifyLicenseRequest(BaseModel):
    licenseKey: str

class AnalyzeRequest(BaseModel):
    licenseKey: Optional[str] = None
    cvText: str
    jobText: str

class GenerateCVRequest(BaseModel):
    licenseKey: Optional[str] = None
    cvText: str
    jobText: str
    jobLanguage: str = "english"
    answers: list[dict] = []


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
    }


@app.post("/api/analyze")
async def analyze(body: AnalyzeRequest, x_license_key: Optional[str] = Header(None)):
    license_key = x_license_key or body.licenseKey or ""
    await require_license(license_key)

    prompt = ANALYZE_PROMPT.format(cv_text=body.cvText, job_text=body.jobText)

    last_error: Exception | None = None
    for _ in range(3):
        try:
            raw = await call_claude(prompt, max_tokens=1200)
            result = parse_json_response(raw)
            increment_usage(license_key)
            return {"result": result}
        except json.JSONDecodeError as e:
            last_error = e
        except Exception as e:
            last_error = e
            if "401" in str(e) or "429" in str(e):
                break

    raise HTTPException(status_code=500, detail=str(last_error) or "Analysis failed.")


@app.post("/api/generate-cv")
async def generate_cv(body: GenerateCVRequest, x_license_key: Optional[str] = Header(None)):
    license_key = x_license_key or body.licenseKey or ""
    await require_license(license_key)

    language = "Hebrew" if body.jobLanguage == "hebrew" else "English"
    answers_text = (
        "\n".join(f"{a.get('skill', '')}: {a.get('answer', '')}" for a in body.answers)
        if body.answers
        else "No additional information provided."
    )

    pass1_prompt = CV_PASS1_PROMPT.format(
        language=language,
        cv_text=body.cvText,
        answers_text=answers_text,
        job_text=body.jobText,
    )
    cv_draft = await call_claude(pass1_prompt, max_tokens=2000)

    pass2_prompt = CV_PASS2_PROMPT.format(cv_draft=cv_draft, job_text=body.jobText)
    cv_final = await call_claude(pass2_prompt, max_tokens=2000)

    increment_usage(license_key)
    return {"cvText": cv_final}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
