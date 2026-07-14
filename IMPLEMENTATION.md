# Single-flow streaming fit-analysis with conditional strategic questions

## State machine

```
[Tailor CV click] (btnContinueToCV)
        │
        ├─ collectAnswers() + saveJobState()
        ├─ showCVOptionsScreen()  (language/format/model/coverLetter — unchanged UI)
        └─ startDeepAnalysisOverlay(answers)
                │
                ▼
        STREAMING_ANALYSIS ── POST /api/stream-deep-analysis (SSE)
                │  live prose tokens render in the injected
                │  .jma-fit-block (popup, cv-options screen) AND
                │  mirror to the page-side panel (content.js, unmodified)
                │
                │  20s watchdog running in parallel ──────────────┐
                │                                                  │
                ▼                                                  │
      final `strategy` SSE event received?                         │
        │                          │                               │
       yes                         no (timeout)                    │
        │                          └──────────────────────────────►│
        ▼                                                          │
  fit_type?                                                        │
   ├─ high_fit  ─────────────────────────────► triggerGeneration([]) ◄─ watchdog fires
   │                                                   │
   └─ niche_fit + questions[] ── render chips           │
        (recommended pre-selected,                      │
         "המשך עם ההמלצות ✓" chip)                       │
        │                                                │
        user selects every question                      │
        (default counts; needs ≥1 interaction)            │
        │                                                │
        ▼                                                ▼
                triggerGeneration(strategyChoices)
                   [state._cvGenTriggered guard: fires exactly once]
                        │
                        ▼
                startCVGeneration(..., strategyChoices)
                        │
                        ▼
        chrome.runtime.sendMessage({action:'generateCV', ..., strategyChoices})
                        │
                        ▼
        background.js → POST /api/generate-cv (main.py generate_cv())
                        │
                        ▼
                screen-generating → diff/result screen (unchanged)

  stream fetch/read throws at any point ──► catch block ──► triggerGeneration([])  (fail-open)
```

Also see [popup.js](popup.js) for the runnable version of this diagram.

## What changed, per file

### [server-python/main.py](server-python/main.py)

- **`GenerateCVRequest`** ([main.py:907](server-python/main.py#L907)): added `strategyChoices: list[dict] = []`.
- **`STREAM_FIT_STRATEGY_PROMPT`** ([main.py:1566-1621](server-python/main.py#L1566)): new prompt constant, replaces the old `DEEP_ANALYSIS_PROMPT` (deleted — it was only used by this one endpoint, so no dead code left behind). Produces free-flowing prose (why it fits / where tailoring is needed) followed by a machine-readable `###STRATEGY###{...}` line, per the fit-classification and question rules from the spec.
- **`_split_strategy_stream()`** ([main.py:1638-1657](server-python/main.py#L1638)): new pure helper — splits accumulated stream text into `(prose, strategy_dict)`. Fails open to `{"fit_type": "high_fit", "questions": []}` on a missing marker or malformed JSON. Fully unit-testable without mocking the Anthropic SDK.
- **`/api/stream-deep-analysis`** ([main.py:1669-1717](server-python/main.py#L1669)): same route, same `StreamingResponse`/SSE framing (`data: {...}\n\n`, terminated by `data: [DONE]\n\n`). Internals swapped from `[SCORE]...[/SCORE]` detection to `###STRATEGY###` detection — tokens are flushed live (holding back only the last `len(marker)` chars so the marker is never split across two SSE events), and a final `{"strategy": {...}}` event is emitted once the stream ends, whether or not the marker was found. Wrapped in try/except so a stream error also degrades to the fail-open strategy rather than dropping the connection uncleanly.
- **`generate_cv()`** ([main.py:2023-2065](server-python/main.py#L2023)): the *only* change (see proof below) — two local variables (`strategy_block`, `strategy_checklist_line`) built once from `body.strategyChoices`, then string-appended to the already-built `pass1_prompt` / `pass2_prompt`, exactly as `constraints_block` already was. No other line inside this function changed.

### [popup.js](popup.js)

- **`let state = {...}`** ([popup.js:3](popup.js#L3)): pre-existing bug fix, unrelated to this feature but blocking — the prior commit split `state` into `stateG`/`stateQ` without keeping `state` itself defined, so all 195 other `state.x` references in the file threw `ReferenceError`. Restored the single unified `state` object (see note below).
- **`_renderFitStrategyBlock()`** ([popup.js:1259-1352](popup.js#L1259)): new — dynamically injects a `.jma-fit-block` into `#screen-cv-options` (same `insertBefore(..., btnStartCvGen)` pattern already used for the model/tracking extras), hides `btnStartCvGen`, and returns `{appendProse, showGeneratingStatus, renderQuestions}`. `renderQuestions` builds one radio-chip row per question (recommended chip pre-highlighted and labeled "מומלץ", muted `context` line), plus a "המשך עם ההמלצות ✓" chip, and calls `onReady(choices)` once every question has a selection *and* the user has interacted at least once.
- **`startDeepAnalysisOverlay(answers)`** ([popup.js:1354-1429](popup.js#L1354)): rewritten stream consumer. Still forwards `openAnalysisPanel`/`analysisEvent` messages to content.js (unmodified) so the page-side panel keeps working as a visual mirror. Reads `evt.token`/`evt.strategy` from the new SSE shape, feeds tokens into the popup's own `.jma-fit-block`, sets `state.tailoringStrategy`, and drives `triggerGeneration()` — either immediately (high_fit), after questions are answered (niche_fit), on stream error (catch block), or via a 20s `setTimeout` watchdog. `state._cvGenTriggered` guards against double-firing.
- **`btnContinueToCV` click handler** ([popup.js:1431-1446](popup.js#L1431)): unchanged apart from no longer needing an explicit "next" step — `showCVOptionsScreen()` + `startDeepAnalysisOverlay()` are still the two calls, but the latter now owns the entire rest of the flow instead of being fire-and-forget.
- **`startCVGeneration()`** ([popup.js:1765](popup.js#L1765), payload at [popup.js:1800](popup.js#L1800)): added `strategyChoices` parameter, forwarded as `strategyChoices: strategyChoices || []` in the `generateCV` message.
- **`btnStartCvGen` click listener** ([popup.js:1752-1754](popup.js#L1752)): left untouched (per spec) as a dead-but-harmless safety net; the button itself is hidden (`display:none`) by `_renderFitStrategyBlock()` so this flow never depends on it being clicked.

### [background.js](background.js)

- **`generateCV` handler** ([background.js:264](background.js#L264)): added `strategyChoices: req.strategyChoices || []` to the `backendPost('/api/generate-cv', {...})` body. Nothing else in the handler changed.

## Proof of `generate_cv()` preservation

Full isolated diff of the function (everything else in the file, including the two `.format(...)` prompt templates `CV_PASS1_PROMPT`/`CV_PASS2_PROMPT`, is byte-identical):

```diff
@@ generate_cv() @@
         constraints_block = (
             f"\n\n<user_constraints>\n"
             f"These are the user's personal hard rules. They MUST be followed without exception, "
             f"even if they conflict with general CV best practices or the job description:\n"
             f"{body.userConstraints.strip()}\n"
             f"</user_constraints>"
         )

+    strategy_block = ""
+    strategy_checklist_line = ""
+    if body.strategyChoices:
+        decision_lines = "\n".join(
+            f"- {c.get('question', '')} → user chose: {c.get('chosen', '')}"
+            for c in body.strategyChoices
+        )
+        strategy_block = (
+            f"\n\nUSER STRATEGY DECISIONS — these override default tailoring behavior, follow exactly:\n"
+            f"{decision_lines}"
+        )
+        strategy_checklist_line = "\n\nVerify the USER STRATEGY DECISIONS were followed exactly."
+
     pass1_prompt = CV_PASS1_PROMPT.format(
         language=language,
         language_rule=language_rule,
         cv_text=body.cvText,
         answers_text=answers_text,
         job_text=body.jobText,
-    ) + url_instruction + constraints_block
+    ) + url_instruction + constraints_block + strategy_block
     cv_draft = await call_claude(pass1_prompt, max_tokens=2000)

     pass2_prompt = CV_PASS2_PROMPT.format(
         language_check=language_check,
         cv_draft=cv_draft,
         job_text=body.jobText,
-    ) + url_instruction + constraints_block
+    ) + url_instruction + constraints_block + strategy_checklist_line
     cv_final = await call_claude(pass2_prompt, max_tokens=2000)

     # Inject tracking links only when original CV had GitHub/LinkedIn URLs and tracking is enabled
     app_id = str(uuid.uuid4())[:8]
     ...unchanged from here on...
```

When `body.strategyChoices` is empty (the default), `strategy_block == "" and strategy_checklist_line == ""`, so `pass1_prompt`/`pass2_prompt` are string-identical to today — same call sequence, same models (`claude-haiku-4-5-20251001` inside `call_claude`), same `max_tokens`, same prompt-caching (none was used here before, none is used now), same diff pass, same docx path. Verified by `TestGenerateCVStrategyInjection::test_no_strategy_choices_prompt_unchanged` in [server-python/tests/test_stream_fit_strategy.py](server-python/tests/test_stream_fit_strategy.py).

`grep -n "strategyChoices\|strategy_block\|strategy_checklist" server-python/main.py` shows every reference confined to `GenerateCVRequest` and these two blocks — no other function touches strategy data.

## Fail-open behaviors

| Trigger | Where | Result |
|---|---|---|
| `###STRATEGY###` marker never appears before stream ends | `_split_strategy_stream()` (backend) | returns `{"fit_type": "high_fit", "questions": []}` |
| JSON after the marker doesn't parse | `_split_strategy_stream()` (backend) | same fail-open dict, prose before the marker is preserved |
| `fit_type` present but not `"high_fit"`/`"niche_fit"` | `_split_strategy_stream()` (backend) | coerced to `"high_fit"` |
| `questions` present but not a list | `_split_strategy_stream()` (backend) | coerced to `[]` |
| Anthropic stream call raises | `stream_deep_analysis()` generate() (backend) | caught, prints `[JMA:stream_fit_strategy]`, still emits the fail-open `strategy` event + `[DONE]` |
| `fetch`/reader throws in the popup | `startDeepAnalysisOverlay()` catch block (frontend) | `triggerGeneration([])` |
| No resolved strategy within 20s | `setTimeout` watchdog (frontend) | `triggerGeneration([])` |
| Any of the above race each other | `state._cvGenTriggered` guard (frontend) | generation fires exactly once regardless of order |

CV generation is never blocked on the analysis stream in any failure mode.

## Calibration outputs

Fixtures: [server-python/fixtures/backend_cv.txt](server-python/fixtures/backend_cv.txt) + 4 synthetic job postings. Runner: [server-python/fixtures/run_calibration.py](server-python/fixtures/run_calibration.py) (real Anthropic API call, `claude-haiku-4-5-20251001` — the cheapest model, same one the endpoint hardcodes). Result: **4/4 scenarios classified as expected.**

### (a) Matching backend job → expected `high_fit` — got `high_fit` ✅
> John's experience is a direct match for this payments platform role. He has 5 years of backend development across Python (FastAPI, Django, Flask), PostgreSQL and MySQL, Docker, and AWS — the exact stack listed in requirements. Most tellingly, his current role at Acme Tech involved designing microservices architecture handling 2M+ daily requests, optimizing API latency by 40%, and leading the payments infrastructure rewrite, which is nearly identical to the responsibilities described here. [...]
>
> The CV needs minimal tailoring: emphasize the payments-specific work at Acme [...] and call out the scale of traffic handled (2M+ requests/day) as evidence of production-grade reliability. [...]

`STRATEGY: {'fit_type': 'high_fit', 'questions': []}`

### (b) Job targeting one narrow CV section (D3.js dashboard) → expected `niche_fit` — got `niche_fit` ✅
> John's CV shows genuine alignment with this Data Visualization Engineer role. His early project at StartUp Inc directly matches the job's core responsibilities [...] The tailoring challenge here is that John's CV currently buries his visualization and analytics experience under a narrative of backend infrastructure and microservices scaling. [...]

`STRATEGY: {'fit_type': 'niche_fit', 'questions': [{'id': 'q1', 'question': 'How should John position the balance between his data visualization / analytics roots (StartUp Inc project, ETL work) and his later backend infrastructure focus?', ..., 'recommended': 'opt1'}]}`

### (c) High keyword overlap but narrow focus (Python ETL) → expected `niche_fit` — got `niche_fit` ✅
Tests the conceptual-not-keyword rule directly: the job text repeats "Python" and "API" heavily, matching CV keywords densely, yet the model correctly identified it as narrow.
> John's CV demonstrates genuine ETL and data pipeline experience [...] However, the CV currently positions John as a senior backend/microservices architect, not a data pipeline specialist. [...] A hiring manager skimming this CV will see a mid-to-senior engineer overqualified for and pivoting away from backend work, rather than recognizing his genuine pipeline expertise buried in the Junior Developer section.

`STRATEGY: {'fit_type': 'niche_fit', 'questions': [{'id': 'q1', ..., 'recommended': 'opt2'}]}`

### (d) Same discipline, different vocabulary (Platform Engineer) → expected `high_fit` — got `high_fit` ✅
Tests the reverse rule: the job never says "Python"/"FastAPI"/"PostgreSQL"/"Docker" — it says "modern scripting language," "relational data stores," "container orchestration" — yet was correctly classified as a global fit.
> John's experience is a direct match for this platform engineering role. His 5 years as a backend developer building scalable REST APIs with FastAPI and PostgreSQL directly addresses the core responsibilities [...] The CV needs only light tailoring to maximize impact for this specific role. [...]

`STRATEGY: {'fit_type': 'high_fit', 'questions': []}`

(Full untruncated transcripts are reproducible via `.venv/Scripts/python.exe fixtures/run_calibration.py` from `server-python/`.)

## Pytest results

`server-python/tests/test_stream_fit_strategy.py` — 10/10 passed:
- `_split_strategy_stream`: valid marker, high_fit with empty questions, malformed JSON (fail-open), missing marker (fail-open), invalid `fit_type` (coerced), non-list `questions` (coerced).
- `GenerateCVRequest`: `strategyChoices` defaults to `[]`, accepts a populated list.
- `generate_cv()`: with empty `strategyChoices` neither prompt contains the decisions/checklist text; with populated `strategyChoices` the decisions block is in pass1 only, the checklist line is in pass2 only.

## Architecture note — why the interactive questions live in the popup, not the page panel

The spec describes rendering questions "in the existing panel" (the content.js floating page-side panel). Strict scope forbids editing `content.js`, and `content.js`'s current `_handleAnalysisEvent` only understands `token`/`score`/`done` — it has no click-handling or chip-rendering support, and popup.js cannot attach working listeners into another script's DOM (separate JS execution contexts). The interactive chips, recommended pre-selection, and auto-trigger logic were therefore built inside popup.js's own `#screen-cv-options` (dynamically injected, same technique as the existing model/tracking `.cv-extra-opts` block), while prose tokens are still mirrored to the page-side panel unmodified for visual continuity. This was a forced choice under the "don't touch content.js" constraint, not a deviation from the spec's intent.
