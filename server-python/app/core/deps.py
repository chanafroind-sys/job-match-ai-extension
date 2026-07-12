from typing import Optional

from fastapi import Depends, Header
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_db
from .models import User


def _hash_license_key(license_key: str) -> str:
    # Deferred import: main.py imports app.routes.points at module load time, so a
    # top-level "from main import _ws_user_id" here would be circular. Importing
    # inside the function body runs only at request time, after main has finished
    # loading. We reuse main's hash function rather than reimplementing sha256(...)[:16]
    # so the two can never drift apart.
    from main import _ws_user_id

    return _ws_user_id(license_key)


async def _backfill_email(db: AsyncSession, user: User, license_key: str) -> None:
    """users.email is never set at signup (there's no signup) — opportunistically
    fill it in from the Gumroad license lookup, which already has it and is
    cached, so this costs nothing extra on the common path. Needed so referral
    accept/decline can email the candidate without the client sending its own
    email address on every request."""
    if user.email:
        return
    from main import verify_gumroad_license

    try:
        data = await verify_gumroad_license(license_key)
    except Exception:
        return
    email = (data or {}).get("email") or ""
    if not email or "@" not in email:
        return
    user.email = email
    await db.commit()
    await db.refresh(user)


async def get_current_user(
    x_license_key: Optional[str] = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    from main import require_license

    license_key = await require_license(x_license_key or "")
    key_hash = _hash_license_key(license_key)

    result = await db.execute(select(User).where(User.license_key_hash == key_hash))
    user = result.scalar_one_or_none()
    if user is not None:
        await _backfill_email(db, user, license_key)
        return user

    user = User(license_key_hash=key_hash)
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        # Lost the get-or-create race to a concurrent request — fetch what it created.
        await db.rollback()
        result = await db.execute(select(User).where(User.license_key_hash == key_hash))
        user = result.scalar_one_or_none()
        if user is None:
            raise
    else:
        await db.refresh(user)
    await _backfill_email(db, user, license_key)
    return user
