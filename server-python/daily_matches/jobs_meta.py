"""Which ATS hosts a job, and the URL of its application form.

The extension decides what Apply can do from `ats`: Lever, Greenhouse and
Ashby get auto-fill, Workday a sign-in explanation, everything else
download-and-copy (daily/dm-apply.js). The apply URL
points at the ATS-hosted form where one exists, rather than a company page that
embeds it in an iframe, so the form is top-level and on a host the extension
already has permission for.
"""
from urllib.parse import urlparse

from app.services.israel_job_sources import COMPANIES

_BY_NAME = {c["name"].strip().lower(): c for c in COMPANIES}


def ats_for(company: str, url: str) -> str:
    host = urlparse(url or "").netloc.lower()
    if host.endswith("lever.co"):
        return "lever"
    if host.endswith("ashbyhq.com"):
        return "ashby"
    if host.endswith("smartrecruiters.com"):
        return "smartrecruiters"
    if "myworkdayjobs.com" in host or "workdayjobs.com" in host:
        return "workday"
    if host.endswith("greenhouse.io") or "gh_jid=" in (url or ""):
        return "greenhouse"
    entry = _BY_NAME.get((company or "").strip().lower())
    return entry["ats"] if entry else "other"


def apply_url_for(ats: str, url: str, company: str, external_job_id: str | None) -> str:
    url = (url or "").strip()
    if ats == "lever":
        base = url.split("?")[0].rstrip("/")
        return base if base.endswith("/apply") else base + "/apply"
    if ats == "ashby":
        base = url.split("?")[0].rstrip("/")
        return base if base.endswith("/application") else base + "/application"
    if ats == "greenhouse":
        entry = _BY_NAME.get((company or "").strip().lower())
        ext = str(external_job_id or "")
        if entry and entry.get("ats") == "greenhouse" and ext.isdigit():
            return f"https://job-boards.greenhouse.io/{entry['params']['board']}/jobs/{ext}"
    return url
