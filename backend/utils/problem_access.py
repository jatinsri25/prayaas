"""Shared report visibility rules for reads, search, and source citations."""
from fastapi import HTTPException
from sqlalchemy import or_, select
import models


def visible_problems(db, user):
    query = db.query(models.Problem)
    if user.role in ("society_admin", "superadmin"):
        return query
    public = select(models.Group.id).where(models.Group.is_public.is_(True))
    memberships = select(models.GroupMember.group_id).where(models.GroupMember.user_id == user.id)
    return query.filter(or_(models.Problem.group_id.is_(None), models.Problem.group_id.in_(public),
                            models.Problem.group_id.in_(memberships), models.Problem.author_id == user.id))


def require_group_member(db, user, group_id):
    if group_id is None:
        return
    if not db.get(models.Group, group_id):
        raise HTTPException(404, "Group not found")
    if user.role in ("society_admin", "superadmin"):
        return
    member = db.query(models.GroupMember).filter_by(user_id=user.id, group_id=group_id).first()
    if member is None:
        raise HTTPException(403, "Join this group before posting to it")
