"""Общие проверки прав, сериализация и журнал действий."""
from dataclasses import dataclass
import json
from uuid import UUID

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AuditLog, Break, Schedule, Shift, User, UserPermission

ALL_PERMISSIONS = ["track_time", "edit_own_profile", "edit_own_shifts", "view_reports", "export_reports"]
DEFAULT_PERMISSIONS = ["track_time", "edit_own_profile", "view_reports"]
ADMIN_LOGIN = "Adilium"
ADMIN_NAME = "Адиль Кубентаев"


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def fail(status: int, code: str, message: str):
    raise ApiError(status, code, message)


@dataclass
class Actor:
    row: User
    user: dict
    csrf: str
    token_hash: str
    bearer: bool = False


def now_ms(request: Request) -> int:
    return int(request.app.state.clock())


def require_admin(actor: Actor):
    if actor.user["role"] != "admin":
        fail(403, "FORBIDDEN", "Действие доступно только администратору.")


def require_permission(actor: Actor, permission: str):
    if actor.user["role"] != "admin" and permission not in actor.user["permissions"]:
        fail(403, "FORBIDDEN", "Администратор не предоставил право на это действие.")


def require_own(actor: Actor, user_id: str):
    if actor.user["role"] != "admin" and actor.user["id"] != user_id:
        fail(403, "FORBIDDEN", "Доступ к данным другого сотрудника запрещён.")


def get_user(db: Session, user_id: str) -> User:
    try:
        UUID(user_id)
    except (TypeError, ValueError, AttributeError):
        fail(400, "VALIDATION", "Некорректный идентификатор.")
    user = db.get(User, user_id)
    if user is None:
        fail(404, "NOT_FOUND", "Сотрудник не найден.")
    return user


def public_user(db: Session, user: User) -> dict:
    permissions = ALL_PERMISSIONS[:] if user.role == "admin" else list(db.scalars(
        select(UserPermission.permission).where(UserPermission.user_id == user.id).order_by(UserPermission.permission)
    ))
    return dict(id=user.id, username=user.username, name=user.name, position=user.position,
                department=user.department, role=user.role, active=bool(user.active), archived=bool(user.archived),
                permissions=permissions, createdAt=user.created_at)


def public_shift(db: Session, shift: Shift) -> dict:
    breaks = db.scalars(select(Break).where(Break.shift_id == shift.id).order_by(Break.started_at, Break.id))
    return dict(id=shift.id, userId=shift.user_id, startedAt=shift.started_at, endedAt=shift.ended_at,
                note=shift.note, version=shift.version,
                breaks=[dict(startedAt=p.started_at, endedAt=p.ended_at) for p in breaks])


def get_schedule(db: Session, user_id: str) -> dict:
    row = db.get(Schedule, user_id)
    return dict(userId=user_id, startTime=row.start_time if row else "09:00",
                endTime=row.end_time if row else "18:00", breakMinutes=row.break_minutes if row else 60,
                weekdays=json.loads(row.weekdays) if row else [1, 2, 3, 4, 5],
                timezone=row.timezone if row else "Asia/Qyzylorda")


def audit(db: Session, actor: Actor, action: str, target_type: str, target_id: str, details: dict, now: int):
    db.add(AuditLog(actor_id=actor.user["id"], actor_name=actor.user["name"], action=action,
                    target_type=target_type, target_id=target_id,
                    details=json.dumps(details, ensure_ascii=False), created_at=now))
