"""Minimal in-process rate limiter for public, unauthenticated endpoints.

In-memory only — fine for a single-instance Render deployment, matching the
rest of this codebase's "no extra infra" approach (see sync_service.py's
lazy-sync design for the same philosophy). Not shared across processes.
"""

import time
from collections import defaultdict

_hits: dict[str, list[float]] = defaultdict(list)


def check_and_record(bucket: str, key: str, max_calls: int, window_seconds: int) -> bool:
    """Returns True if this call is allowed (and records it), False if the
    caller has exceeded `max_calls` within the trailing `window_seconds`."""
    now = time.monotonic()
    cutoff = now - window_seconds
    full_key = f"{bucket}:{key}"

    hits = [t for t in _hits[full_key] if t > cutoff]
    if len(hits) >= max_calls:
        _hits[full_key] = hits
        return False

    hits.append(now)
    _hits[full_key] = hits
    return True
