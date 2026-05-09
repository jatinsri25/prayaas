"""
Prayaas RBAC Dependencies

Role hierarchy:
  RESIDENT (1) < GROUP_ADMIN (2) < SOCIETY_ADMIN (3) < SUPERADMIN (4)
"""

from enum import IntEnum
from fastapi import Depends, HTTPException
from auth import get_current_user
import models


class Role(IntEnum):
    RESIDENT = 1
    GROUP_ADMIN = 2
    SOCIETY_ADMIN = 3
    SUPERADMIN = 4


def require_role(minimum: Role):
    """
    FastAPI dependency that enforces minimum role level.

    Usage:
        @router.delete("/problems/{id}")
        async def delete_problem(user=Depends(require_role(Role.SOCIETY_ADMIN))):
            ...
    """
    async def checker(current_user: models.User = Depends(get_current_user)):
        user_role = getattr(current_user, "role", None) or "resident"
        role_map = {
            "resident": Role.RESIDENT,
            "group_admin": Role.GROUP_ADMIN,
            "society_admin": Role.SOCIETY_ADMIN,
            "superadmin": Role.SUPERADMIN,
        }
        user_level = role_map.get(user_role.lower(), Role.RESIDENT)

        if user_level < minimum:
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions. Required: {minimum.name}, your role: {user_role}"
            )
        return current_user
    return checker
