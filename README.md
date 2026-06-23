# Job Match AI — Chrome Extension

> AI-powered job application assistant: analyze job fit, generate tailored one-page CVs, rank job listing pages, and track applications — all from a single browser extension.

[![Version](https://img.shields.io/badge/version-3.4.0-7c3aed)](https://github.com/chanafroind-sys/job-match-ai-extension)
[![Manifest](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/)
[![Backend](https://img.shields.io/badge/Backend-FastAPI%20on%20Render-green)](https://render.com)

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Key Features](#key-features)
- [Technical Deep-Dives](#technical-deep-dives)
- [File Structure](#file-structure)
- [Installation (Development)](#installation-development)
- [Backend Deployment](#backend-deployment)
- [Environment Variables](#environment-variables)

---

## Overview

Job Match AI is a Chrome Extension (Manifest V3) that helps job seekers:

1. **Analyze fit** — paste a job posting, get a score (0–100) with strengths and gaps vs. your CV
2. **Generate tailored CVs** — two-pass Claude pipeline produces a polished one-page Word document
3. **Rank listing pages** — detects job listing pages on any site, extracts all job cards, ranks them by fit in one shot
4. **Track applications** — local tracker with status management and CSV export

The extension communicates with a Python/FastAPI backend hosted on Render (free tier). No CV data is stored server-side — all persistence is `chrome.storage.local`.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Chrome Extension (Manifest V3)                      │
│                                                      │
│  popup.html/js   ←→  background.js (Service Worker) │
│  content.js           │                              │
│  docx-builder.js      │  fetchWithRetry + timeout    │
│  tracker.js           ↓                              │
└───────────────────────┬─────────────────────────────┘
                        │ HTTPS (host_permissions)
                        ▼
┌─────────────────────────────────────────────────────┐
│  FastAPI backend — Render free tier                  │
│                                                      │
│  POST /api/analyze          → Claude Haiku           │
│  POST /api/generate-cv      → 2×Claude Haiku         │
│  POST /api/rank-jobs        → Claude Haiku           │
│  POST /api/verify-license   → Gumroad API            │
│  GET  /api/v1/track         → redirect + log         │
│  GET  /health               → wake-up ping           │
└─────────────────────────────────────────────────────┘
```

**Key architectural decisions:**

- **No API key in the extension** — all Claude calls go through the backend; the API key lives in a Render environment variable
- **Gumroad license gating** — `x-license-key` header on every request; usage capped at 100 analyses/month per key
- **Pure-JS DOCX builder** — no npm, no bundler; builds valid `.docx` (ZIP + Office Open XML) entirely in the browser using `DecompressionStream`
- **On-demand script injection** — `content.js` is declared in `content_scripts` for all `https://*/*` but activates UI only when job content is detected

---

## Key Features

### Job Fit Analysis
Sends CV text + job description to Claude Haiku. Returns structured JSON with `score`, `jobTitle`, `company`, `strengths`, `hard_gaps`, and clarifying `questions`. Scores above 40 unlock CV generation.

### Two-Pass CV Generation
**Pass 1** — tailors the CV to the job with strict rules: one page max, no invented experience, 100% English, company structure sacred, bold key terms.  
**Pass 2** — ruthless review pass: checks English compliance, seniority accuracy, profile authenticity, and bold formatting. Returns the final CV text with `[NAME]`, `[HEADLINE]`, etc. markers that `docx-builder.js` parses into styled Word XML.

### Job Listing Sidebar
`content.js` detects job listing pages using a three-tier strategy:
1. Platform-specific CSS selectors (LinkedIn, Indeed, Glassdoor, etc.)
2. Generic structural patterns (`[class*="job-card"]`, `[data-job-id]`, etc.)
3. Keyword heuristic + repeated-element pattern (Hebrew + English job keywords)

On detection, injects a glassmorphism FAB button. On click, fetches full HTML of each job page in parallel via `background.js`, extracts job descriptions, then calls `/api/rank-jobs` for a single-shot ranking.

### Conditional Link Tracking
When generating a CV, the backend scans for GitHub/LinkedIn URLs in the output. If found, replaces them with `[LINK:display|tracking_url]` tokens. `docx-builder.js` converts these into real Word hyperlinks (`<w:hyperlink r:id="...">`) that point to `/api/v1/track`, which logs the click and redirects.

---

## Technical Deep-Dives

### Dynamic Scoring Algorithm

The `/api/rank-jobs` prompt instructs Claude to:
- **Classify each requirement** from the job text as CRITICAL or SECONDARY based on language and position
- **Apply proportional experience penalties**: `(required_years - actual_years) / required_years × 35`
- **Hard caps**: seniority mismatch → max 65; domain mismatch → max 55
- **Calibration anchors**: 85+ = shortlist now; <40 = wrong domain or severe gap

This avoids fixed deduction tables that misfire on vague or junior postings.

### Render Cold-Start Mitigation (Pre-emptive Background Ping)

Render's free tier sleeps after 15 minutes of inactivity. The first request after sleep takes 30–50 seconds.

**Solution**: `content.js` fires `chrome.runtime.sendMessage({ action: 'pingBackend' })` as soon as `pageHasJobKeywords()` returns `true` — before the user even sees the FAB button. `background.js` fires a fire-and-forget `GET /health`. By the time the user clicks "Rank", the server has been awake for 2–30 seconds.

Additionally, `fetchWithRetry` uses `AbortController` with a 25-second timeout per attempt and retries up to 4 times with 12-second gaps.

### URL-keyed Result Cache (`chrome.storage.local`)

Ranking 12 jobs costs one Claude call (~$0.002). Ranking the same page twice wastes that.

`content.js` uses `location.origin + location.pathname` as a cache key. After a successful ranking, results are saved:
```js
chrome.storage.local.set({ [cacheKey]: { jobs: rankedJobs, ts: Date.now() } });
```
On subsequent opens within **20 minutes**, results are served from cache with a "⚡ תוצאות שמורות" indicator. Cache is invalidated on SPA navigation (URL change detected via 1.2s polling interval).

### Popup State Persistence

The popup is a transient browser window — closing it destroys all JavaScript state. If a user closes the popup mid-analysis, they previously had to wait ~30 seconds again.

**Solution**: After `showMainResult()`, the analysis is persisted:
```js
chrome.storage.local.set({ lastAnalysis: { url, analysis, jobText, jobLanguage, ts } });
```
On popup open, if `tab.url === lastAnalysis.url` and age < 30 minutes, the result screen is restored instantly without any API call.

### DOCX Builder — Pure Browser Implementation

`docx-builder.js` constructs a valid `.docx` file (ZIP archive containing Office Open XML) entirely in the browser:
- **ZIP**: custom implementation with CRC-32, local file headers, central directory, and EOCD record
- **Bold**: `makeRichRuns()` parses `**term**` markdown into `<w:b/>` runs
- **Hyperlinks**: `[LINK:display|url]` tokens become `<w:hyperlink r:id="...">` with relationships in `word/_rels/document.xml.rels`
- **Section markers**: `parseCVSections()` strips `#`, `**`, and other decorations Claude might add before `[NAME]`, `[PROFILE]`, etc.

---

## File Structure

```
├── manifest.json          # MV3 manifest — permissions, content_scripts, service worker
├── background.js          # Service worker — API proxy, fetchWithRetry, rankJobs, fetchJobDetails
├── content.js             # Injected into pages — job text extraction, FAB, sidebar
├── popup.html/js          # Extension popup — all screens (license, ready, analysis, CV, tracker)
├── docx-builder.js        # Pure-JS DOCX/ZIP builder
├── tracker.js             # Application tracker — CRUD + CSV export
└── server-python/
    ├── main.py            # FastAPI app — all endpoints, prompts, license gate, link tracking
    └── requirements.txt   # fastapi, uvicorn, anthropic, httpx, python-dotenv
```

---

## Installation (Development)

1. Clone the repo
2. Open `chrome://extensions/` → Enable Developer Mode → Load Unpacked → select the repo root
3. Set up the backend (see below)
4. Activate a license key in the extension popup

---

## Backend Deployment

The backend runs on [Render](https://render.com) (free tier):

1. Create a new **Web Service** from this repo, root directory `server-python/`
2. Build command: `pip install -r requirements.txt`
3. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Set environment variables (see below)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `GUMROAD_PRODUCT_ID` | ✅ | Gumroad product permalink |
| `MAX_DEVICES_PER_KEY` | optional | Max devices per license (default: 3) |
| `MONTHLY_USAGE_LIMIT` | optional | Max analyses per key/month (default: 100) |
| `BACKEND_URL` | optional | Public URL of this service (default: Render URL) |

---

*Built with Claude Haiku · FastAPI · Chrome Extension Manifest V3 · Pure-JS DOCX*
