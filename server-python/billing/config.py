"""Billing settings. Read from the environment on every call, like
daily_matches.config.mode(), so a change in Render applies on its restart
without a code change."""
import os
from datetime import timedelta

KEY_PREFIX = "JMA-"
# A subscriber can hold a key on this many installs; "send my key again"
# issues a new one until the cap.
MAX_KEYS_PER_SUBSCRIPTION = 3
# Mock checkouts and providers that don't report a period end renew monthly.
DEFAULT_PERIOD = timedelta(days=31)
# A renewal webhook can arrive after the period ends; access holds this long.
RENEWAL_GRACE = timedelta(days=3)
CHECKOUT_TTL = timedelta(hours=6)
RESEND_COOLDOWN = timedelta(minutes=10)
VERIFY_CACHE_SECONDS = 60


def provider_name() -> str:
    """BILLING_PROVIDER: '' (default, billing off), 'mock' (test payments on
    our own page, admins only) or 'polar'."""
    return (os.getenv("BILLING_PROVIDER", "") or "").strip().lower()


_CURRENCY_SIGNS = {"USD": "$", "ILS": "₪", "EUR": "€"}


def price() -> float:
    """BILLING_PRICE: the monthly price shown on the "subscribe" button, e.g.
    5.90. Display only: the processor's product holds the price actually
    charged, so the two must be kept equal. Unset or 0 keeps billing hidden."""
    try:
        return max(0.0, float(os.getenv("BILLING_PRICE", "") or 0))
    except ValueError:
        return 0.0


def price_label() -> str:
    """"$5.90" or "18 ₪", the way the button shows it."""
    amount = price()
    currency = (os.getenv("BILLING_CURRENCY", "") or "USD").strip().upper()
    text = f"{amount:.2f}" if amount % 1 else f"{amount:.0f}"
    sign = _CURRENCY_SIGNS.get(currency)
    if sign == "₪":
        return f"{text} ₪"
    return f"{sign}{text}" if sign else f"{text} {currency}"


def public_base_url() -> str:
    """Where the processor sends people back and posts webhooks to."""
    return (os.getenv("PUBLIC_BASE_URL", "") or "https://job-match-ai-extension.onrender.com").rstrip("/")
