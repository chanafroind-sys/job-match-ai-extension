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
    return user
