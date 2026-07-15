"""V2 API router — every V2 endpoint hangs off this /api/v2 prefix.

Isolation contract: this module (and every module under v2/) must not import
flow logic from main.py. V1 endpoints keep serving from main.py untouched;
V2 endpoints are physical copies modified only inside the v2/ namespace.

Mounting: main.py itself imports this router and calls app.include_router()
at its own bottom (added directly to main.py outside this codebase's normal
edit path — not by any v2/ module). That means /api/v2/* is live on whatever
entrypoint already serves main:app, with no separate wrapper/deploy step.
A previous server-python/v2/app.py wrapper that duplicated this same
include_router() call was removed to avoid double-registering every route.
"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/v2", tags=["v2"])

V2_VERSION = "2.0.0-beta.1"


@router.get("/health")
async def v2_health():
    """Liveness stub proving the /api/v2 surface is mounted and isolated."""
    return {"ok": True, "version": V2_VERSION, "flow": "v2-isolated"}


# Endpoint modules register themselves on `router` — imported after the router
# object exists so the decorator can attach routes.
from v2 import stream_questions  # noqa: E402,F401
from v2 import semantic_map      # noqa: E402,F401
