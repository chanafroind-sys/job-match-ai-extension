"""One job, many listings: the same opening shows up on the company's board,
on LinkedIn and on Indeed, each under its own URL (so its own pool id).

job_key() reduces a listing to company + title, without legal suffixes,
locations and punctuation. A listing whose key is already in the pool, or
earlier in today's batch, is a copy and is dropped. Sources are processed
best first (the company's own board, then LinkedIn, JSearch, Indeed), so the
copy kept is the one with an application form auto-fill can use.
"""
import re

from app.services.job_aggregator import _ISRAEL_RE

_COMPANY_NOISE = re.compile(
    r"\b(ltd|inc|llc|corp|corporation|co|company|technologies|technology|tech|group|labs|software|"
    r"israel|il|global|international|בע\"?מ)\b", re.I)
_TITLE_NOISE = re.compile(r"\b(hybrid|remote|on[- ]?site|full[- ]?time|part[- ]?time|m/f|f/m|h/f)\b", re.I)
_PUNCT = re.compile(r"[^0-9a-z֐-׿]+")


def _squash(text: str) -> str:
    return " ".join(_PUNCT.sub(" ", text.lower()).split())


def job_key(company: str | None, title: str | None) -> str:
    company_part = _squash(_COMPANY_NOISE.sub(" ", company or ""))
    title_part = _squash(_TITLE_NOISE.sub(" ", _ISRAEL_RE.sub(" ", title or "")))
    return f"{company_part}|{title_part}"


def drop_copies(records: list[dict], known: dict[str, str]) -> tuple[list[dict], int]:
    """Keeps the first listing per key. known maps keys already in the pool to
    their row id; a record with that same id is an update of the same row,
    not a copy, and is kept. Mutates known. Returns (kept, dropped)."""
    kept, dropped = [], 0
    for rec in records:
        key = job_key(rec.get("company"), rec.get("title"))
        owner = known.get(key)
        if owner is not None and owner != rec["id"]:
            dropped += 1
            continue
        known[key] = rec["id"]
        kept.append(rec)
    return kept, dropped
