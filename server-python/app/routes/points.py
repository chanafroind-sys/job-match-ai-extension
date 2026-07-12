from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.models import User
from app.services import points_service

router = APIRouter()


@router.get("/api/points/balance")
async def get_points_balance(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    balance = await points_service.get_balance(db, user.id)
    return {"balance": balance}
