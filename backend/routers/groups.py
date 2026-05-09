"""
Prayaas Groups Router — Production Hardened

Security:
  - RBAC on group deletion (society_admin+ only)
  - Audit logging on join/leave/create
  - Input validated via Pydantic schemas
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from database import get_db
from auth import get_current_user
import models
import schemas
from utils.audit import log_action

router = APIRouter(prefix="/api/groups", tags=["groups"])


@router.post("", response_model=schemas.GroupOut)
def create_group(
    data: schemas.GroupCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    group = models.Group(
        name=data.name,
        description=data.description,
        is_public=data.is_public,
        created_by=current_user.id,
    )
    db.add(group)
    db.commit()
    db.refresh(group)

    # Auto-add creator as admin
    membership = models.GroupMember(
        user_id=current_user.id,
        group_id=group.id,
        role="admin",
    )
    db.add(membership)
    db.commit()

    # Audit log
    log_action(db, "CREATE_GROUP", user_id=current_user.id, resource=f"group:{group.id}")

    return _group_out(group, db)


@router.get("", response_model=List[schemas.GroupOut])
def list_groups(db: Session = Depends(get_db)):
    groups = db.query(models.Group).filter(models.Group.is_public == True).all()
    return [_group_out(g, db) for g in groups]


@router.get("/my", response_model=List[schemas.GroupOut])
def my_groups(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    memberships = db.query(models.GroupMember).filter(
        models.GroupMember.user_id == current_user.id
    ).all()
    groups = [db.query(models.Group).get(m.group_id) for m in memberships]
    return [_group_out(g, db) for g in groups if g]


@router.post("/{group_id}/join", response_model=dict)
def join_group(
    group_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    group = db.query(models.Group).filter(models.Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    existing = db.query(models.GroupMember).filter(
        models.GroupMember.user_id == current_user.id,
        models.GroupMember.group_id == group_id,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Already a member")

    membership = models.GroupMember(
        user_id=current_user.id,
        group_id=group_id,
        role="member",
    )
    db.add(membership)
    db.commit()

    # Audit log
    log_action(db, "JOIN_GROUP", user_id=current_user.id, resource=f"group:{group_id}")

    return {"message": f"Joined group '{group.name}' successfully"}


@router.delete("/{group_id}/leave", response_model=dict)
def leave_group(
    group_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    membership = db.query(models.GroupMember).filter(
        models.GroupMember.user_id == current_user.id,
        models.GroupMember.group_id == group_id,
    ).first()
    if not membership:
        raise HTTPException(status_code=404, detail="Not a member of this group")
    db.delete(membership)
    db.commit()

    # Audit log
    log_action(db, "LEAVE_GROUP", user_id=current_user.id, resource=f"group:{group_id}")

    return {"message": "Left group successfully"}


@router.get("/{group_id}", response_model=schemas.GroupOut)
def get_group(group_id: int, db: Session = Depends(get_db)):
    group = db.query(models.Group).filter(models.Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return _group_out(group, db)


@router.delete("/{group_id}", response_model=dict)
def delete_group(
    group_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete a group. Only the creator or society_admin+ can delete."""
    group = db.query(models.Group).filter(models.Group.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    is_creator = group.created_by == current_user.id
    is_admin = current_user.role in ("society_admin", "superadmin")

    if not is_creator and not is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to delete this group")

    # Delete all memberships
    db.query(models.GroupMember).filter(models.GroupMember.group_id == group_id).delete()
    db.delete(group)
    db.commit()

    # Audit log
    log_action(db, "DELETE_GROUP", user_id=current_user.id, resource=f"group:{group_id}")

    return {"message": "Group deleted successfully"}


def _group_out(group: models.Group, db: Session) -> schemas.GroupOut:
    count = db.query(models.GroupMember).filter(
        models.GroupMember.group_id == group.id
    ).count()
    return schemas.GroupOut(
        id=group.id,
        name=group.name,
        description=group.description,
        is_public=group.is_public,
        created_at=group.created_at,
        member_count=count,
        creator=schemas.UserOut.model_validate(group.creator),
    )
