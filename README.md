# Job Match AI

> **Enterprise-grade Chrome Extension for contextual CV personalisation, recruiter-engagement analytics, and parallel application tracking.**

---

## Project Vision

Modern job applications fail not because of talent gaps, but because of signal gaps — a strong candidate submitting a generic CV to a role they're 80 % qualified for, losing out to a weaker candidate who happened to mirror the job description's exact language.

**Job Match AI** closes that gap. It runs directly inside the browser, on the job listing page itself, extracts the live job description, scores it against the candidate's CV in real time, guides them through a structured competency-assessment flow, and generates a tailored, ATS-optimised document — all before the recruiter even opens their inbox.

The system is designed around three non-negotiable engineering constraints:

1. **Zero perceived latency** — analysis begins the moment the candidate lands on the job page, not when they click a button.
2. **Minimal LLM cost** — aggressive caching and a two-pass architecture cut token spend by an order of magnitude compared to a naïve single-call design.
3. **Full offline resilience** — every critical state is persisted to `chrome.storage.local`; the extension degrades gracefully when the backend is cold-starting on Render's free tier.

---

## Architecture

### 2-Pass LLM Pipeline

```
Job page load
     │
     ▼
Pass 1 — Preflight (background.js, fire-and-forget)
  • Lightweight prompt: CV + job text → base_score + gap analysis + weighted questions
  • Result cached in chrome.storage.local with a 10-minute TTL keyed by URL hash
  • FAB arc animates from 5 % to ~87 % while this runs (fake progress, real timing)
     │
     ▼ preflightDone message → content.js → FAB snaps to real score
     │
Pass 2 — Full CV Generation (on user action)
  • User answers competency questions (button-selected 0 / 40 / 100 % per skill)
  • Pass-2 prompt includes weighted answers, CV, job text, output-language selection
  • Backend assembles the adapted CV text, then compiles it into a .docx binary
  • Tracking links (GitHub / LinkedIn / Portfolio) are injected before the docx build
```

The separation of concerns between the two passes is intentional: Pass 1 is stateless and cheap (no document generation, no diff computation, no cover-letter optionality), which allows it to run speculatively during normal browsing without ever blocking the UI thread.

### Smart Prompt Caching

The candidate's CV is submitted with `cache_control: { type: "ephemeral" }` on the Anthropic Messages API. On Render's free tier with a warm process, this reduces the cost of repeated analyses of the same CV against different jobs by **~70 %** and shaves latency from the 2–3 s range down to under 500 ms for the preflight call.

Cache keys on the client side are derived from a deterministic polynomial hash of the page URL (`Math.imul(31, h) + charCode`) so the same job listing always hits the same storage slot across browser sessions, and stale entries expire after a configurable TTL without any LRU eviction overhead.

### Asynchronous Request Concurrency

When the user confirms their answers and requests a CV, three operations are dispatched **simultaneously**:

| Concurrent task | Mechanism |
|---|---|
| CV text generation (LLM call) | `await backendPost('/api/generate-cv', …)` inside background service worker |
| Typewriter animation on analysis summary | `setInterval` at 16 ms tick, character-by-character, non-blocking |
| DOCX binary assembly | `python-docx` running inside the FastAPI request handler, returns base64-encoded bytes |

The popup's "Download CV" button is armed via `_armCvButton()`, which monitors `state.cvGenPromise` (a `Promise` stored on the shared state object) and transitions the button from spinner → green check mark the instant the promise resolves — without requiring any user interaction or polling loop.

### Event-Driven UI: FAB State Machine & SPA Navigation

The floating action button is a state machine with three explicit states:

```
idle ──(click)──► loading ──(preflightDone)──► ready
  ▲                  │                           │
  └──(preflightError)┘                           └──(click)──► panel toggle
```

State transitions are driven by Chrome's message-passing system (`chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`) rather than shared memory, which makes the FAB's lifecycle fully decoupled from the popup iframe and the background service worker.

LinkedIn's SPA navigation (pushState URL changes without full page reloads) is handled by a `chrome.tabs.onUpdated` listener in `background.js` that stamps a navigation timestamp in storage; the popup reads this stamp on open and forces a fresh analysis rather than displaying stale cached results.

### Recruiter Engagement Analytics

Every CV generated gets a random 8-character `app_id`. All hyperlinks in the document (GitHub profile, LinkedIn, portfolio) are rewritten through a redirect endpoint on the backend (`/api/v1/track?app_id=…&target=…&url=…`), which logs the click event with a UTC timestamp before issuing a `302` to the original URL.

The tracker dashboard polls `/api/v1/clicks?app_ids=…` on load and surfaces:

- **Link Opened** — which destinations (GitHub / LinkedIn / Portfolio) the recruiter clicked
- **Opened At** — the exact local timestamp of the first click

This gives the candidate a passive signal that their application was reviewed, without any action from the recruiter's side.

### Admin Recruiter Bulk Import

License keys listed in the `ADMIN_KEYS` env var (comma-separated, same format as `PREMIUM_KEYS`) can bulk-import recruiters from an Excel file via `POST /api/admin/recruiters/import`. `GET /api/points/balance` returns `isAdmin: true` for those keys, which the popup's settings screen uses to conditionally show the "🔧 אזור ניהול" import block — this is a display-only flag; the server enforces the real authorization check.

**File format** — first row is a header; columns are matched by name (case-insensitive), not position:

| Column | Required |
|---|---|
| `full_name` | yes |
| `email` | yes |
| `company` | yes |
| `phone` | no |

**Limits:** 2 MB max file size (`413` if exceeded), 2,000 data rows max (`422` if exceeded), `.xlsx` only.

Each row runs through the same validation/dedup logic as the regular single-add endpoint (blocked personal-email domains, email format, dedup by email), with three differences: no points are credited, `added_by` is the importing admin, and the recruiter is marked `is_verified = true`. A single bad row (invalid email, blocked domain, missing required field) is recorded in the response's `errors` list without failing the rest of the batch; duplicate emails within the same file are only created once. Response shape:

```json
{ "created": 45, "enriched": 3, "skipped_duplicates": 12, "errors": [{ "row": 7, "reason": "כתובת האימייל אינה תקינה." }] }
```

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Extension runtime | Chrome Extension Manifest V3 | Service worker (`background.js`), content script, iframe-based sidebar |
| Frontend | Vanilla JS + SVG | No framework dependency; zero build step; full RTL + LTR support |
| Backend | Python 3.11 · FastAPI · Uvicorn (ASGI) | Async request handlers throughout; no sync blocking calls |
| LLM | Anthropic Claude (`claude-haiku-4-5-20251001`) | Prompt caching on CV blocks; `json-repair` for robust output parsing |
| Document generation | `python-docx` | Programmatic DOCX construction; base64-encoded binary response |
| License validation | Gumroad `/v2/licenses/verify` | Per-device activation with configurable device limit |
| Hosting | Render (free tier) | Retry loop with exponential back-off handles cold-start 502s transparently |
| Storage | `chrome.storage.local` | URL-hashed keys; TTL-based cache invalidation; no external database |

---

## Key Design Decisions

**Why no framework (React / Vue)?**
A Chrome Extension popup is a constrained, single-page, fast-iteration surface. A framework would add a build pipeline, increase bundle size (impacting content-script injection time), and provide no meaningful benefit over direct DOM manipulation for a UI of this complexity.

**Why a sidebar iframe instead of `default_popup`?**
`default_popup` closes the moment focus leaves the extension icon. A fixed-position iframe injected by the content script persists across interactions, allowing the user to switch tabs, read the job description, and return to the analysis without losing state.

**Why polynomial hash for cache keys rather than UUIDs?**
Deterministic hashing means the same URL always produces the same key, enabling cache hits across popup open/close cycles and page refreshes without any coordination layer.

**Why two-pass instead of one big prompt?**
Pass 1 is speculative and runs without user intent. Running full CV generation speculatively would consume ~2000 tokens per page visit, making the product economically unviable at scale. Pass 1 costs ~300 tokens and produces only a score and structured questions.

---

## Repository Structure

```
.
├── manifest.json          # MV3 manifest — permissions, web_accessible_resources
├── background.js          # Service worker — API relay, preflight orchestration, SPA nav tracking
├── content.js             # FAB gauge, sidebar panel injection, job text extraction
├── popup.js               # Full UI state machine — screens, questions, CV gen, tracker
├── popup.html             # Styles + DOM shell for the sidebar iframe
├── tracker.js             # chrome.storage CRUD + CSV export with click enrichment
├── docx-builder.js        # Client-side DOCX binary construction from base64 sections
└── server-python/
    └── main.py            # FastAPI app — analyze, generate-cv, track, clicks endpoints
```

---

## License

Proprietary. All rights reserved.
