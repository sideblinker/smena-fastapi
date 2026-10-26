"""Administration of employees and schedules, preserving the protected master account."""

import json
from uuid import uuid4
from typing import Annotated

from fastapi import APIRouter, Query, Request
from sqlalchemy import delete, select

from backend.common import (
    ADMIN_LOGIN,
    ADMIN_NAME,
    audit,
    fail,
    get_schedule,
    get_user,
    now_ms,
    public_user,
    require_admin,
    require_own,
    require_permission,
)
from backend.dependencies import CurrentActor, Db
from backend.models import Schedule, SessionRecord, User, UserPermission
from backend.schemas.common import Ok
from backend.schemas.users import (
    ProfileUpdate,
    ScheduleResponse,
    ScheduleUpdate,
    UserCreate,
    UserResponse,
    UsersResponse,
    UserUpdate,
)
from backend.security import hash_password
from backend.schemas.query import Identifier, UserListQuery, UserLookupQuery
from backend.services.lists import list_users as paged_users, user_conditions

router = APIRouter(prefix="/api", tags=["Сотрудники и графики"])


def _revoke_sessions(db, user_id):
    db.execute(delete(SessionRecord).where(SessionRecord.user_id == user_id))


@router.get("/users", response_model=UsersResponse, response_model_exclude_none=True, summary="Сотрудники: поиск и постраничный список")
def list_users(request: Request, db: Db, actor: CurrentActor, query: Annotated[UserLookupQuery, Query()]):
    require_admin(actor)
    if query.page is not None:
        return paged_users(db, actor, UserListQuery.model_validate(query.model_dump()), now_ms(request))
    statement = select(User).where(*user_conditions(query)).order_by(User.master.desc(), User.name, User.id)
    return {"users": [public_user(db, user) for user in db.scalars(statement).all()]}


@router.get("/users/{user_id}", response_model=UserResponse, summary="Профиль сотрудника с проверкой прав")
def read_user(user_id: Identifier, db: Db, actor: CurrentActor):
    require_own(actor, user_id)
    return {"user": public_user(db, get_user(db, user_id))}


@router.post("/users", response_model=UserResponse, status_code=201, summary="Создать аккаунт сотрудника")
def create_user(body: UserCreate, request: Request, db: Db, actor: CurrentActor):
    require_admin(actor)
    now = now_ms(request)
    user = User(id=str(uuid4()), username=body.username, name=body.name,
                password_hash=hash_password(body.password), position=body.position, department=body.department,
                role="employee", active=1, archived=0, master=0, created_at=now)
    db.add(user)
    db.flush()
    db.add(Schedule(user_id=user.id))
    for permission in body.permissions:
        db.add(UserPermission(user_id=user.id, permission=permission))
    db.flush()
    audit(db, actor, "user_created", "user", user.id,
          {"name": body.name, "username": body.username, "permissions": body.permissions}, now)
    return {"user": public_user(db, user)}


@router.patch("/users/{user_id}", response_model=UserResponse, summary="Изменить профиль, пароль и права сотрудника")
def update_user(user_id: Identifier, body: UserUpdate, request: Request, db: Db, actor: CurrentActor):
    require_admin(actor)
    user = get_user(db, user_id)
    fields = body.model_fields_set
    username = body.username if "username" in fields else user.username
    name = body.name if "name" in fields else user.name
    archived = body.archived if "archived" in fields else bool(user.archived)
    active = False if archived else body.active if "active" in fields else bool(user.active)
    if user.master and (username != ADMIN_LOGIN or name != ADMIN_NAME or not active or archived or "permissions" in fields):
        fail(403, "MASTER_ADMIN", "Логин, имя, статус и полные права главного администратора защищены.")

    # Only explicitly supplied profile fields are changed. The request-wide
    # transaction ensures an edit cannot resurrect a disabled account or reset
    # a password based on stale data read by a concurrent request.
    for field in ("username", "name", "position", "department"):
        if field in fields:
            setattr(user, field, getattr(body, field))
    if "archived" in fields:
        user.archived = int(archived)
    if archived or "active" in fields:
        user.active = int(active)
    if "password" in fields:
        user.password_hash = hash_password(body.password)
    if "permissions" in fields:
        db.execute(delete(UserPermission).where(UserPermission.user_id == user.id))
        for permission in body.permissions:
            db.add(UserPermission(user_id=user.id, permission=permission))
    if "password" in fields or body.active is False or body.archived is True:
        _revoke_sessions(db, user.id)
    db.flush()

    details = {"passwordReset": "password" in fields}
    for field in ("username", "name", "position", "department", "active", "archived", "permissions"):
        if field in fields:
            details[field] = active if field == "active" else archived if field == "archived" else getattr(body, field)
    audit(db, actor, "user_updated", "user", user.id, details, now_ms(request))
    return {"user": public_user(db, user)}


@router.delete("/users/{user_id}", response_model=Ok, summary="Архивировать сотрудника, сохранив историю")
def archive_user(user_id: Identifier, request: Request, db: Db, actor: CurrentActor):
    require_admin(actor)
    user = get_user(db, user_id)
    if user.master:
        fail(403, "MASTER_ADMIN", "Главного администратора нельзя удалить.")
    user.archived, user.active = 1, 0
    _revoke_sessions(db, user.id)
    db.flush()
    audit(db, actor, "user_archived", "user", user.id, {"name": user.name}, now_ms(request))
    return {"ok": True}


@router.patch("/profile", response_model=UserResponse, summary="Изменить свой профиль")
def update_profile(body: ProfileUpdate, request: Request, db: Db, actor: CurrentActor):
    require_permission(actor, "edit_own_profile")
    if actor.row.master and "name" in body.model_fields_set and body.name != ADMIN_NAME:
        fail(403, "MASTER_ADMIN", "Имя главного администратора защищено.")
    values = body.model_dump(exclude_unset=True)
    for field, value in values.items():
        setattr(actor.row, field, value)
    db.flush()
    audit(db, actor, "profile_updated", "user", actor.row.id, values, now_ms(request))
    return {"user": public_user(db, actor.row)}


@router.get("/schedules/{user_id}", response_model=ScheduleResponse, summary="Просмотреть рабочий график")
def read_schedule(user_id: Identifier, db: Db, actor: CurrentActor):
    require_own(actor, user_id)
    get_user(db, user_id)
    return {"schedule": get_schedule(db, user_id)}


@router.put("/schedules/{user_id}", response_model=ScheduleResponse, summary="Назначить рабочий график сотруднику")
def update_schedule(user_id: Identifier, body: ScheduleUpdate, request: Request, db: Db, actor: CurrentActor):
    require_admin(actor)
    get_user(db, user_id)
    schedule = db.get(Schedule, user_id)
    if schedule is None:
        schedule = Schedule(user_id=user_id)
        db.add(schedule)
    schedule.start_time = body.startTime
    schedule.end_time = body.endTime
    schedule.break_minutes = body.breakMinutes
    schedule.weekdays = json.dumps(body.weekdays)
    schedule.timezone = body.timezone
    db.flush()
    audit(db, actor, "schedule_updated", "user", user_id, body.model_dump(), now_ms(request))
    return {"schedule": get_schedule(db, user_id)}
