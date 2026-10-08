"""Which site hosts a job, and the URL of its application form.

The extension words Apply from `ats` (daily/dm-apply.js): the ATSes whose
form was tested live get "auto-fill", Workday a sign-in note, LinkedIn a note
about Easy Apply versus the company's site. It fills any application form the
user reaches either way.

The apply URL points at the ATS-hosted form where one exists, rather than a
company page that embeds it in an iframe, so the form is top-level and on a
host the extension already has permission for.
"""
import re
from urllib.parse import urlparse

from app.services.israel_job_sources import COMPANIES

_BY_NAME = {c["name"].strip().lower(): c for c in COMPANIES}

# Host suffix -> ats. Job boards first: a LinkedIn or Indeed listing is never
# "the company's Greenhouse job", even when the company has a Greenhouse board.
_HOSTS = (
    ("linkedin.com", "linkedin"), ("indeed.com", "indeed"), ("glassdoor.com", "glassdoor"),
    ("lever.co", "lever"), ("ashbyhq.com", "ashby"), ("smartrecruiters.com", "smartrecruiters"),
    ("smartr.me", "smartrecruiters"), ("myworkdayjobs.com", "workday"), ("workdayjobs.com", "workday"),
    ("greenhouse.io", "greenhouse"), ("comeet.co", "comeet"), ("comeet.com", "comeet"),
    ("workable.com", "workable"), ("teamtailor.com", "teamtailor"), ("bamboohr.com", "bamboohr"),
    ("breezy.hr", "breezy"), ("recruitee.com", "recruitee"), ("jobvite.com", "jobvite"),
    ("icims.com", "icims"),
)
_JOB_BOARDS = {"linkedin", "indeed", "glassdoor"}
_GH_HOSTED = re.compile(r"^https?://(?:job-)?boards(?:\.eu)?\.greenhouse\.io/(?!embed/)([\w-]+)/jobs/(\d+)")


def ats_for(company: str, url: str) -> str:
    host = urlparse(url or "").netloc.lower()
    for suffix, ats in _HOSTS:
        if host == suffix or host.endswith("." + suffix):
            return ats
    if "gh_jid=" in (url or ""):
        return "greenhouse"
    # A company's own careers page: its known ATS.
    entry = _BY_NAME.get((company or "").strip().lower())
    return entry["ats"] if entry else "other"


def greenhouse_form(board: str, job_id) -> str:
    """Greenhouse's own copy of the application form. Unlike the hosted job
    page, it never redirects to a company careers site (Wiz's, say), where the
    form sits in an iframe on a host the extension can't reach."""
    return f"https://job-boards.greenhouse.io/embed/job_app?for={board}&token={job_id}"


def apply_url_for(ats: str, url: str, company: str, external_job_id: str | None) -> str:
    url = (url or "").strip()
    if ats == "lever":
        base = url.split("?")[0].rstrip("/")
        return base if base.endswith("/apply") else base + "/apply"
    if ats == "ashby":
        base = url.split("?")[0].rstrip("/")
        return base if base.endswith("/application") else base + "/application"
    if ats == "greenhouse":
        hosted = _GH_HOSTED.match(url)
        if hosted:
            return greenhouse_form(hosted.group(1), hosted.group(2))
        entry = _BY_NAME.get((company or "").strip().lower())
        ext = str(external_job_id or "")
        if entry and entry.get("ats") == "greenhouse" and ext.isdigit():
            return greenhouse_form(entry["params"]["board"], ext)
    if ats == "workable":
        base = url.split("?")[0].rstrip("/")
        if re.search(r"/j/[\w-]+$", base):
            return base + "/apply/"
    return url
