"""Daily Matches: once-a-day personalized job matches from daily_job_pool.

Isolation contract (same rules V2 follows): everything lives in this package,
under the /api/daily-matches prefix and the dm_* tables. Existing endpoints,
services, models and tables are read, never modified. main.py only mounts the
router. Infra helpers from main.py (license verification, the Anthropic client
resolver, error mapping) are imported lazily inside functions so this package
can be imported before or after main without a circular import.

Pipeline:
  sync cron   → scripts/run_job_embeddings.py → dm_job_embeddings (Voyage)
  user click  → POST /run → CV vectors (lazy, cached by text hash)
              → Stage 1: cosine search, top 15 (retrieval.py, store.py)
              → Stage 2: 15 parallel Haiku calls, strict JSON (reasoning.py)
              → deck stored in dm_runs / dm_run_results, reopened for free
"""
