"""Text preparation shared by both stages: CV normalization and hashing,
contact-detail redaction, and requirement-focused job excerpts."""
import hashlib
import re

from daily_matches import config

PDF_PREFIX = "[PDF_BASE64:"


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def salted_hash(value: str) -> str:
    return sha256(f"{config.HASH_SALT}:{value}")


# ── CVs ───────────────────────────────────────────────────────────────────────

def is_pdf_blob(text: str | None) -> bool:
    """V1's popup stores an uploaded PDF as "[PDF_BASE64:<data>]" instead of
    text (popup.js readCVFile). Nothing can embed that, so it is extracted
    first (cv_text.py)."""
    return bool(text) and text.lstrip().startswith(PDF_PREFIX)


def pdf_b64_from_blob(text: str) -> str:
    body = text.strip()[len(PDF_PREFIX):]
    return body[:-1] if body.endswith("]") else body


def normalize_cv_text(text: str) -> str:
    """Whitespace-normalized CV text; the basis for the cache hash, so trailing
    spaces or Windows line endings don't count as a new CV version."""
    lines = [re.sub(r"[ \t ]+", " ", ln).strip() for ln in (text or "").replace("\r", "").split("\n")]
    out = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return out[: config.MAX_CV_CHARS]


def cv_hash(text: str) -> str:
    return sha256(normalize_cv_text(text))


def cv_fingerprint(text: str) -> str:
    """Looser than cv_hash: letters and digits only (Hebrew included), so a
    reinstall with the same CV and edited punctuation still matches."""
    core = re.sub(r"[^0-9a-z֐-׿]+", "", (text or "").lower())
    return sha256(core[:20_000])


_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL = re.compile(r"(?:https?://|www\.)\S+|\b(?:linkedin\.com|github\.com|gitlab\.com)/\S*", re.I)
_PHONE_CANDIDATE = re.compile(r"(?<![\w+])\+?\(?\d[\d\s().\-]{6,18}\d(?!\w)")
_YEAR_RANGE = re.compile(r"^\s*(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\s*$")


def _phone_or_keep(match: re.Match) -> str:
    raw = match.group(0)
    digits = re.sub(r"\D", "", raw)
    if not 9 <= len(digits) <= 15 or _YEAR_RANGE.match(raw):
        return raw  # dates and year ranges matter for scoring; only phone-shaped runs go
    return "[phone]"


def redact_contacts(text: str) -> str:
    """Drops email addresses, phone numbers and URLs before a CV goes to the
    embedding provider or the LLM. Neither needs them to judge fit."""
    text = _EMAIL.sub("[email]", text or "")
    text = _URL.sub("[link]", text)
    return _PHONE_CANDIDATE.sub(_phone_or_keep, text)


# ── Jobs ──────────────────────────────────────────────────────────────────────

_KEEP_SECTION = re.compile(
    r"requirement|qualification|what you('|’)?ll (need|bring|do)|what we('|’)?re looking for|"
    r"about you|you have|you bring|you will|must[- ]?have|nice[- ]to[- ]have|advantage|bonus|"
    r"skills|experience|responsibilit|the role|your role|what you('|’)?ll be doing|"
    r"דרישות|כישורים|תחומי אחריות|יתרון|ניסיון|תיאור התפקיד|מה תעשו",
    re.I,
)
_SKIP_SECTION = re.compile(
    r"about (us|the company)|who we are|benefits|perks|why join|equal opportunit|\beeo\b|"
    r"privacy|our culture|life at|our story|הטבות|מי אנחנו|על החברה",
    re.I,
)


def _is_heading(line: str) -> bool:
    if len(line) > 70 or line.startswith(("•", "-", "*")):
        return False
    if line.endswith(":"):
        return True
    return len(line.split()) <= 8 and bool(_KEEP_SECTION.search(line) or _SKIP_SECTION.search(line))


def focus_excerpt(description: str | None, max_chars: int) -> str:
    """The parts of a job description that say what the job needs.

    ATS descriptions open with company marketing and close with benefits and
    legal text; both blur an embedding and spend LLM tokens without changing a
    match. Sections are split on heading-like lines (html_to_text in the
    aggregator keeps line breaks and bullets for exactly this). With no
    recognizable sections, the description is kept minus obvious boilerplate.
    """
    sections: list[tuple[str, list[str]]] = []
    head, body = "", []
    for raw in (description or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if _is_heading(line):
            if head or body:
                sections.append((head, body))
            head, body = line, []
        else:
            body.append(line)
    if head or body:
        sections.append((head, body))

    keep = [s for s in sections if s[0] and _KEEP_SECTION.search(s[0]) and not _SKIP_SECTION.search(s[0])]
    chosen = keep or [s for s in sections if not _SKIP_SECTION.search(s[0])] or sections
    text = "\n".join("\n".join(([h] if h else []) + b) for h, b in chosen)
    return text[:max_chars].strip()


def job_header(title: str, company: str, category: str, seniority: str) -> str:
    return f"Title: {title}\nCompany: {company}\nCategory: {category} · Seniority: {seniority}"


def job_embedding_text(title: str, company: str, category: str, seniority: str,
                       description: str | None) -> str:
    # ~2,500 chars (~600 tokens) of requirements is what retrieval needs; more
    # mostly adds tokens, which count against Voyage's per-minute limits.
    return f"{job_header(title, company, category, seniority)}\n\n{focus_excerpt(description, 2500)}".strip()


def job_llm_text(title: str, company: str, category: str, seniority: str,
                 description: str | None) -> str:
    # ~4,500 chars is ~1.1k tokens: enough for the requirements, not the whole ad.
    return f"JOB POSTING\n{job_header(title, company, category, seniority)}\n\n{focus_excerpt(description, 4500)}"


def card_excerpt(description: str | None) -> str:
    return focus_excerpt(description, 900)


_HEBREW = re.compile(r"[֐-׿]")


def estimate_tokens(text: str) -> int:
    """Rough token count, used only to decide whether a prompt prefix is long
    enough to cache. Hebrew tokenizes far denser than English."""
    hebrew = len(_HEBREW.findall(text))
    return int(hebrew / 2.0 + (len(text) - hebrew) / 3.6)
