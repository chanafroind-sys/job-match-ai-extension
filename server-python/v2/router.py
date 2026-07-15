"""V2 API router — every V2 endpoint hangs off this /api/v2 prefix.

Isolation contract: this module (and every module under v2/) must not import
flow logic from main.py. V1 endpoints keep serving from main.py untouched;
V2 endpoints are physical copies modified only inside the v2/ namespace.
"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/v2", tags=["v2"])

V2_VERSION = "2.0.0-beta.1"


@router.get("/health")
async def v2_health():
    """Liveness stub proving the /api/v2 surface is mounted and isolated."""
    return {"ok": True, "version": V2_VERSION, "flow": "v2-isolated"}
