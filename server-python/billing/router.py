"""HTTP surface: /api/billing/*.

The extension never sees which processor is behind this: it asks /config
whether to show "subscribe", opens the URL /checkout returns in a tab, and
polls /checkout/{id} until the key arrives.
"""
import html
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from billing import config, providers, service
from billing.providers import Event
from daily_matches import config as dm_config
from daily_matches.entitlement import client_ip

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/billing", tags=["billing"])

_CHECKOUT_ID = Path(..., pattern=r"^[0-9a-f]{32}$")
NOT_AVAILABLE = "המנוי עדיין לא זמין לרכישה."


def _is_admin(license_key: Optional[str]) -> bool:
    import main
    return bool(license_key) and license_key.strip() in main.STATIC_ADMIN_KEYS


def visible_to(license_key: Optional[str]) -> bool:
    """Billing follows the Daily Matches rollout switch, and needs a ready
    processor and a price. A test processor is for admins only, always."""
    provider = providers.current()
    if provider is None or config.price() <= 0:
        return False
    admin = _is_admin(license_key)
    if provider.test_only:
        return admin
    mode = dm_config.mode()
    return mode == "on" or (mode == "admins" and admin)


def _key_or_401(x_license_key: Optional[str]) -> str:
    if not service.is_own_key(x_license_key):
        raise HTTPException(status_code=401, detail="אין מפתח מנוי בתוסף.")
    return x_license_key.strip()


@router.get("/config")
async def billing_config(x_license_key: Optional[str] = Header(None)):
    if not visible_to(x_license_key):
        return {"enabled": False}
    provider = providers.current()
    return {"enabled": True, "price_label": config.price_label(), "test": provider.test_only}


@router.post("/checkout")
async def start_checkout(request: Request, x_license_key: Optional[str] = Header(None),
                         db: AsyncSession = Depends(get_db)):
    if not visible_to(x_license_key):
        raise HTTPException(status_code=403, detail=NOT_AVAILABLE)
    try:
        ip = client_ip(request)
        checkout_id, url = await service.create_checkout(db, providers.current(), None if ip == "unknown" else ip)
    except Exception as exc:  # noqa: BLE001  the processor is down or refused
        logger.warning("billing: checkout failed: %s", exc)
        raise HTTPException(status_code=502, detail="לא הצלחנו לפתוח את דף התשלום. נסי שוב בעוד רגע.")
    return {"checkout_id": checkout_id, "url": url}


@router.get("/checkout/{checkout_id}")
async def checkout_status(checkout_id: str = _CHECKOUT_ID, db: AsyncSession = Depends(get_db)):
    return await service.claim(db, checkout_id)


@router.post("/webhook/{provider_name}")
async def webhook(provider_name: str, request: Request, db: AsyncSession = Depends(get_db)):
    provider = providers.by_name(provider_name)
    if provider is None or not provider.webhooks or not provider.ready():
        raise HTTPException(status_code=404, detail="unknown provider")
    try:
        events = await provider.parse_webhook(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)[:200])
    for ev in events:
        await service.apply_event(db, provider.name, ev)
    return {"ok": True}


@router.get("/subscription")
async def my_subscription(x_license_key: Optional[str] = Header(None), db: AsyncSession = Depends(get_db)):
    info = await service.describe(db, _key_or_401(x_license_key))
    if info is None:
        raise HTTPException(status_code=404, detail="המפתח הזה לא שייך למנוי.")
    return info


@router.post("/cancel")
async def cancel_subscription(x_license_key: Optional[str] = Header(None), db: AsyncSession = Depends(get_db)):
    try:
        info = await service.cancel(db, _key_or_401(x_license_key))
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001  the processor refused or is down; nothing changed here
        logger.warning("billing: cancel failed: %s", exc)
        raise HTTPException(status_code=502, detail="הביטול לא הצליח. נסי שוב בעוד רגע.")
    if info is None:
        raise HTTPException(status_code=404, detail="המפתח הזה לא שייך למנוי.")
    return info


class ResendIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)


@router.post("/resend-key")
async def resend_key(body: ResendIn, db: AsyncSession = Depends(get_db)):
    await service.resend_key(db, body.email)
    return {"ok": True}


# ── pages a person lands on ───────────────────────────────────────────────────

def _page(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(f"""<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>
<style>body{{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#F8FAFC;color:#0F172A;
margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}}
main{{background:#fff;border:1px solid #E2E8F0;border-radius:14px;padding:28px;max-width:420px;width:100%;
box-shadow:0 4px 18px rgba(15,23,42,.06)}}h1{{font-size:20px;margin:0 0 8px}}p{{color:#475569;line-height:1.6}}
input{{width:100%;box-sizing:border-box;padding:10px;border:1px solid #CBD5E1;border-radius:8px;font-size:15px}}
button{{width:100%;margin-top:10px;padding:12px;border:0;border-radius:8px;background:#4F46E5;color:#fff;
font-size:15px;font-weight:600;cursor:pointer}}button.alt{{background:#E2E8F0;color:#0F172A}}
.tag{{display:inline-block;background:#FEF3C7;color:#92400E;border-radius:6px;padding:2px 8px;font-size:12px}}</style>
</head><body><main>{body}</main></body></html>""")


@router.get("/return", response_class=HTMLResponse)
async def returned():
    """Where the processor sends the payer back to."""
    return _page("תודה!", "<h1>✅ תודה!</h1><p>המנוי מופעל אוטומטית בתוסף. אפשר לסגור את הלשונית ולחזור לתוסף.</p>")


def _mock_or_404() -> None:
    if config.provider_name() != "mock":
        raise HTTPException(status_code=404, detail="Not found")


@router.get("/mock/pay/{checkout_id}", response_class=HTMLResponse)
async def mock_pay_page(checkout_id: str = _CHECKOUT_ID):
    _mock_or_404()
    return _page("תשלום בדיקה", f"""<span class="tag">סביבת בדיקה · לא מחויב כסף</span>
<h1>מנוי Job Match AI</h1><p>{html.escape(config.price_label())} לחודש</p>
<input id="email" type="email" placeholder="אימייל" dir="ltr" autocomplete="email">
<button id="pay">תשלום בדיקה</button>
<p id="msg"></p>
<script>
document.getElementById('pay').onclick = async () => {{
  const r = await fetch(location.pathname, {{method: 'POST', headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify({{email: document.getElementById('email').value}})}});
  document.getElementById('msg').textContent = r.ok ? '✅ התשלום התקבל. אפשר לחזור לתוסף.' : 'משהו השתבש.';
}};
</script>""")


class MockPayIn(BaseModel):
    email: str = Field("", max_length=254)


@router.post("/mock/pay/{checkout_id}")
async def mock_pay(body: MockPayIn, checkout_id: str = _CHECKOUT_ID, db: AsyncSession = Depends(get_db)):
    _mock_or_404()
    await service.apply_event(db, "mock", Event(kind="paid", provider_ref="mock-" + checkout_id,
                                                checkout_id=checkout_id, email=body.email))
    return {"ok": True}


class MockEventIn(BaseModel):
    kind: Literal["renewed", "failed", "cancelled"]
    provider_ref: str = Field(..., max_length=120)


@router.post("/mock/event")
async def mock_event(body: MockEventIn, x_license_key: Optional[str] = Header(None),
                     db: AsyncSession = Depends(get_db)):
    """A renewal, failed charge or cancellation, the way a processor would
    report it. Admins only, mock provider only."""
    _mock_or_404()
    if not _is_admin(x_license_key):
        raise HTTPException(status_code=403, detail="admins only")
    await service.apply_event(db, "mock", Event(kind=body.kind, provider_ref=body.provider_ref))
    return {"ok": True}
