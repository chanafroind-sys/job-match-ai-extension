"""Referral notification emails, sent from the system account via plain SMTP.

No vendor assumed — set SMTP_HOST/SMTP_PORT/SMTP_USERNAME/SMTP_PASSWORD/
SMTP_FROM_EMAIL/SMTP_USE_TLS to whatever provider you use (see .env.example).
smtplib has no async API, so the actual send runs in a thread via
asyncio.to_thread so it doesn't block the event loop.

Sending is best-effort: callers wrap these in try/except and treat failure as
non-fatal (there's no retry queue in this codebase — a failed notification
just means the referral sits pending until it expires and refunds).
"""

import asyncio
import os
import smtplib
from email.message import EmailMessage

SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587") or "587")
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", SMTP_USERNAME)
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").strip().lower() not in ("0", "false", "no")


def _send_sync(to_email: str, subject: str, body: str) -> None:
    if not SMTP_HOST:
        raise RuntimeError("SMTP_HOST is not configured — cannot send email")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM_EMAIL
    msg["To"] = to_email
    msg.set_content(body)

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
        if SMTP_USE_TLS:
            server.starttls()
        if SMTP_USERNAME:
            server.login(SMTP_USERNAME, SMTP_PASSWORD)
        server.send_message(msg)


async def _send(to_email: str, subject: str, body: str) -> None:
    await asyncio.to_thread(_send_sync, to_email, subject, body)


async def send_referral_notification(
    employee_email: str,
    employee_name: str,
    job_title: str,
    company: str,
    match_score: int,
    candidate_summary: str,
    accept_url: str,
    decline_url: str,
) -> None:
    """Job details + candidate summary + score only — no candidate name/email.
    Mutual exposure only happens once the employee accepts."""
    subject = f"בקשת הפניה: {job_title or 'משרה'} ב-{company or ''}"
    body = (
        f"שלום {employee_name or ''},\n\n"
        f"מועמד/ת דרך Job Match AI מבקש/ת הפניה למשרת \"{job_title or ''}\" ב-{company or ''}.\n"
        f"התאמה למשרה: {match_score}%.\n\n"
        f"תקציר המועמד/ת:\n{candidate_summary or '(לא סופק תקציר)'}\n\n"
        f"לאישור ההפניה: {accept_url}\n"
        f"לדחיית ההפניה: {decline_url}\n"
    )
    await _send(employee_email, subject, body)


async def send_employee_optin_invitation(
    employee_email: str,
    employee_name: str,
    company: str,
    accept_url: str,
    decline_url: str,
) -> None:
    """Sent once, when a community member adds a new employee row. The
    employee's consent (opt_in_status) stays 'pending' until they click one
    of these links — never re-sent on a later re-add of the same employee."""
    subject = f"נוספת למאגר חבר-מביא-חבר עבור {company or ''}"
    body = (
        f"שלום {employee_name or ''},\n\n"
        f"מישהו מהקהילה שלך ב-Job Match AI ציין/ה אותך כאיש/אשת קשר אפשרי/ת "
        f"למועמדים המחפשים עבודה ב-{company or ''}.\n"
        f"אם תאשר/י, מועמדים מתאימים (עם ציון התאמה גבוה) יוכלו לבקש ממך הפניה — "
        f"פרטי הקשר שלך יישלחו רק לאחר שתאשר/י בקשה ספציפית.\n\n"
        f"לאישור ההצטרפות: {accept_url}\n"
        f"לדחיית ההצטרפות: {decline_url}\n"
    )
    await _send(employee_email, subject, body)


async def send_mutual_exposure_emails(
    employee_email: str,
    employee_name: str,
    candidate_email: str,
    candidate_name: str,
    job_title: str,
    company: str,
) -> None:
    """Fired only after the employee accepts — the one point in the flow
    where the two sides' contact details are exchanged."""
    if candidate_email:
        await _send(
            candidate_email,
            f"הבקשה שלך אושרה! פרטי הקשר של {employee_name or 'העובד/ת'}",
            (
                f"עובד/ת ב-{company or ''} אישר/ה להפנות אותך למשרת \"{job_title or ''}\".\n\n"
                f"שם: {employee_name or ''}\nאימייל: {employee_email}\n"
            ),
        )
    if employee_email:
        await _send(
            employee_email,
            f"תודה שאישרת! פרטי הקשר של המועמד/ת",
            (
                f"תודה שאישרת את בקשת ההפניה למשרת \"{job_title or ''}\" ב-{company or ''}.\n\n"
                f"שם המועמד/ת: {candidate_name or '(לא צוין)'}\nאימייל: {candidate_email or '(לא זמין)'}\n"
            ),
        )
