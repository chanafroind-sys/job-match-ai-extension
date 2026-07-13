"""Shared visual language for the small set of public, non-SPA HTML pages this
backend serves directly (referral accept/decline, employee opt-in
accept/decline). Self-registration and the admin console have materially
different layouts and stay as their own self-contained f-strings, but reuse
CARD_STYLE for a consistent look.
"""

from fastapi.responses import HTMLResponse

CARD_STYLE = """
body { font-family: Arial, sans-serif; background: #f7f7f8; display: flex; align-items: center;
  justify-content: center; height: 100vh; margin: 0; }
.card { background: #fff; padding: 32px 40px; border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center; max-width: 420px; }
h1 { font-size: 20px; margin: 0 0 12px; }
p { color: #555; margin: 0; }
"""


def render_landing_page(title: str, message: str) -> HTMLResponse:
    html = f"""<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><title>{title}</title>
<style>{CARD_STYLE}</style></head>
<body><div class="card"><h1>{title}</h1><p>{message}</p></div></body></html>"""
    return HTMLResponse(content=html)
