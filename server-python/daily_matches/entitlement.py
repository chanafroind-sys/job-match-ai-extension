"""Who may run Daily Matches, and as which subject.

Order of decisions on every request (client checks are only for messaging):
  1. A valid Gumroad license → subscriber. The subject is the license hash, so
     the daily run is shared by every device on that license.
  2. Otherwise a free trial, if this install and this CV never had one, the
     caller's IP is under its cap, and the server-wide daily trial budget isn't
     spent. Trials run on the server's key.
  3. Otherwise locked. A personal Claude key doesn't unlock the feature: like
     the community features, it's what the subscription buys.

The install ID can be reset by reinstalling, so the CV fingerprint, the IP cap
and the daily budget back it up. Each fake trial still costs only one run.
"""
import importlib
import re
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from daily_matches import config
from daily_matches.models import DmTrial
from daily_matches.text_prep import salted_hash

_INSTALL_RE = re.compile(r"^[A-Za-z0-9-]{16,64}$")

MSG_DISABLED = "ההתאמות היומיות עדיין לא זמינות."
MSG_TRIAL_USED = ("ההרצה החינמית שלך כבר נוצלה. ההתאמות היומיות זמינות למנויים: "
                  "אפשר לרכוש מנוי ולהזין את המפתח בהגדרות ⚙️.")
MSG_TRIAL_LIMIT = ("הניסיונות החינמיים מוגבלים כרגע מהרשת שלך או להיום. "
                   "נסה/י שוב מחר, או הצטרף/י כמנוי.")
MSG_NO_INSTALL = "לא זוהה מזהה התקנה. רענן/י את התוסף ונסה/י שוב."
MSG_LICENSE_DOWN = "לא הצלחנו לאמת את המנוי מול Gumroad כרגע. נסה/י שוב בעוד דקה."


class DmError(Exception):
    """A user-facing failure with a machine code, shaped like main.py's
    "message [jma:CODE]" errors so jma-auth.js can read it."""

    def __init__(self, code: str, message: str, http_status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status

    def coded(self) -> str:
        return f"{self.message} [jma:{self.code}]"


@dataclass
class Access:
    kind: str  # subscription | trial | locked | disabled
    subject: str | None = None
    reason: str = ""  # locked: trial_used | trial_limit | no_install · disabled: off | admins_only
    is_admin: bool = False
    install_hash: str | None = None
    ip_hash: str | None = None

    @property
    def can_run(self) -> bool:
        return self.kind in ("subscription", "trial")


def locked_error(reason: str) -> DmError:
    if reason == "no_install":
        return DmError("DM_NO_INSTALL", MSG_NO_INSTALL, 400)
    return DmError("LICENSE_REQUIRED", MSG_TRIAL_LIMIT if reason == "trial_limit" else MSG_TRIAL_USED, 402)


def client_ip(request: Request) -> str:
    """Render's proxy appends the caller's address to X-Forwarded-For, so the
    last entry is the one a client can't forge."""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def _header(value) -> str:
    # Header params are FastAPI sentinels, not None, when a route is called directly.
    return value.strip() if isinstance(value, str) else ""


async def resolve_access(session: AsyncSession, license_key, install_id, ip: str,
                         cv_fingerprint: str | None = None) -> Access:
    mode = config.mode()
    if mode == "off":
        return Access("disabled", reason="off")
    main = importlib.import_module("main")

    lic = _header(license_key)
    if lic:
        try:
            await main.verify_gumroad_license(lic)
        except HTTPException as exc:
            if exc.status_code == 503:  # Gumroad unreachable: don't downgrade a paying user
                raise DmError("DM_LICENSE_UNAVAILABLE", MSG_LICENSE_DOWN, 503)
            # Expired, refunded or mistyped: continue as a non-subscriber.
        else:
            is_admin = lic in main.STATIC_ADMIN_KEYS
            if mode == "admins" and not is_admin:
                return Access("disabled", reason="admins_only")
            return Access("subscription", subject="lic:" + main._ws_user_id(lic), is_admin=is_admin)

    if mode == "admins":
        return Access("disabled", reason="admins_only")

    install = _header(install_id)
    if not _INSTALL_RE.match(install):
        return Access("locked", reason="no_install")
    install_hash = salted_hash("install:" + install)
    access = Access("trial", subject="inst:" + install_hash[:40],
                    install_hash=install_hash, ip_hash=salted_hash("ip:" + ip))
    reason = await trial_block_reason(session, access.install_hash, access.ip_hash, cv_fingerprint)
    if reason:
        access.kind, access.reason = "locked", reason
    return access


_last_cleanup = {"at": 0.0}
CLEANUP_EVERY_S = 60


def _live():
    return or_(DmTrial.status != "reserved",
               DmTrial.created_at >= config.utcnow() - config.TRIAL_RESERVATION_TTL)


async def _drop_abandoned(session: AsyncSession, *where) -> None:
    await session.execute(delete(DmTrial).where(
        DmTrial.status == "reserved",
        DmTrial.created_at < config.utcnow() - config.TRIAL_RESERVATION_TTL, *where,
    ))


async def trial_block_reason(session: AsyncSession, install_hash: str, ip_hash: str,
                             cv_fingerprint: str | None) -> str:
    """'' when a trial is available, else why not."""
    # A reservation outlives its run only if the process died mid-run; let it go.
    # Every popup opening asks this, so the cleanup (a write) runs once a minute
    # at most, not on every call; a reservation is minutes old by then anyway.
    if time.monotonic() - _last_cleanup["at"] >= CLEANUP_EVERY_S:
        _last_cleanup["at"] = time.monotonic()
        await _drop_abandoned(session)
        await session.commit()
    live = _live()  # an abandoned reservation never counts, cleaned up yet or not

    same = [DmTrial.install_hash == install_hash]
    if cv_fingerprint:
        same.append(DmTrial.cv_fingerprint == cv_fingerprint)
    if (await session.execute(select(func.count()).select_from(DmTrial).where(or_(*same), live))).scalar():
        return "trial_used"
    per_ip = (await session.execute(select(func.count()).select_from(DmTrial).where(
        DmTrial.ip_hash == ip_hash,
        DmTrial.created_at >= config.utcnow() - config.TRIAL_IP_WINDOW, live,
    ))).scalar()
    if per_ip >= config.TRIAL_IP_MAX:
        return "trial_limit"
    today = (await session.execute(select(func.count()).select_from(DmTrial).where(
        DmTrial.created_at >= config.il_day_start_utc(), live,
    ))).scalar()
    if today >= config.TRIAL_DAILY_BUDGET:
        return "trial_limit"
    return ""


async def reserve_trial(session: AsyncSession, access: Access, cv_fingerprint: str, run_id: int) -> None:
    """Atomic claim of the one free run. The unique install and CV columns make
    a second, parallel claim fail here even if both passed the checks above."""
    # An abandoned reservation for this install or CV would hold the unique columns.
    await _drop_abandoned(session, or_(DmTrial.install_hash == access.install_hash,
                                       DmTrial.cv_fingerprint == cv_fingerprint))
    session.add(DmTrial(install_hash=access.install_hash, cv_fingerprint=cv_fingerprint,
                        ip_hash=access.ip_hash, run_id=run_id, status="reserved"))
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise locked_error("trial_used")


async def consume_trial(session: AsyncSession, install_hash: str) -> None:
    """Part of the run's final commit, so a deck and a used trial go together."""
    await session.execute(update(DmTrial).where(DmTrial.install_hash == install_hash)
                          .values(status="consumed").execution_options(synchronize_session=False))


async def release_trial(session: AsyncSession, install_hash: str) -> None:
    await session.execute(delete(DmTrial).where(DmTrial.install_hash == install_hash,
                                                DmTrial.status == "reserved"))
