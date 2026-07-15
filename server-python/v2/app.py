"""V2 ASGI entry point — the single place V1 and V2 backend code meet.

Run with:   uvicorn v2.app:app   (from the server-python directory)

main.py stays byte-identical: this wrapper imports its FastAPI app object and
mounts the /api/v2 router on top. Classic-mode clients keep hitting the V1
routes exactly as before; Interactive-mode clients hit /api/v2/* only.
Reverting to pure V1 is a one-line change back to:  uvicorn main:app
"""
from main import app  # frozen V1 application, imported as-is

from v2.router import router as v2_router

app.include_router(v2_router)
