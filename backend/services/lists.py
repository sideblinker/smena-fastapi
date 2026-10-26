"""Database pagination shared by REST responses and server-rendered HTML."""
from datetime import date
import json

from sqlalchemy import func, or_, select

from ..common import get_user, public_shift, public_user, require_admin, require_own
from ..models import AuditLog, Shift, User
from ..schemas.query import AuditListQuery, ShiftListQuery, UserListQuery

DAY = 86_400_000
OFFSET = 5 * 3_600_000
EPOCH = date(1970, 1, 1).toordinal()


def pagination(total: int, page: int, page_size: int) -> dict:
    pages = max(1, (total + page_size - 1) // page_size)
    return {"page": min(page, pages), "pageSize": page_size, "total": total, "pages": pages}


def list_shifts(db, actor, query: ShiftListQuery, now: int) -> dict:
    user_id = query.userId or actor.user["id"]
    require_own(actor, user_id)
    get_user(db, user_id)
    where = [Shift.user_id == user_id]
    if query.from_date:
        where.append(Shift.started_at >= (date.fromisoformat(query.from_date).toordinal() - EPOCH) * DAY - OFFSET)
    if query.to:
        where.append(Shift.started_at < (date.fromisoformat(query.to).toordinal() + 1 - EPOCH) * DAY - OFFSET)
    if query.status == "finished":
        where.append(Shift.ended_at.is_not(None))
    elif query.status == "active":
        where.append(Shift.ended_at.is_(None))
    total = db.scalar(select(func.count()).select_from(Shift).where(*where))
    meta = pagination(total, query.page, query.pageSize)
    rows = db.scalars(select(Shift).where(*where).order_by(Shift.started_at.desc(), Shift.id.desc())
                      .offset((meta["page"] - 1) * meta["pageSize"]).limit(meta["pageSize"])).all()
    return {"shifts": [public_shift(db, row) for row in rows], "pagination": meta, "serverNow": now}


def user_conditions(query: UserListQuery):
    where = []
    if query.includeArchived != "1":
        where.append(User.archived == 0)
    if query.search:
        # Registered on SQLite connections; unlike SQLite lower(), casefold
        # handles Cyrillic names. contains(autoescape=True) treats %/_ literally.
        needle = query.search.casefold()
        where.append(or_(*(func.unicode_casefold(column).contains(needle, autoescape=True)
                           for column in (User.name, User.username, User.department, User.position))))
    return where


def list_users(db, actor, query: UserListQuery, now: int) -> dict:
    require_admin(actor)
    where = user_conditions(query)
    total = db.scalar(select(func.count()).select_from(User).where(*where))
    meta = pagination(total, query.page, query.pageSize)
    rows = db.scalars(select(User).where(*where).order_by(User.master.desc(), User.name, User.id)
                      .offset((meta["page"] - 1) * meta["pageSize"]).limit(meta["pageSize"])).all()
    return {"users": [public_user(db, row) for row in rows], "pagination": meta, "serverNow": now}


def public_audit(entry):
    return {"id": entry.id, "actorName": entry.actor_name, "action": entry.action,
            "targetType": entry.target_type, "targetId": entry.target_id,
            "details": json.loads(entry.details), "createdAt": entry.created_at}


def list_audit(db, actor, query: AuditListQuery, now: int) -> dict:
    require_admin(actor)
    total = db.scalar(select(func.count()).select_from(AuditLog))
    meta = pagination(total, query.page, query.pageSize)
    entries = db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
                         .offset((meta["page"] - 1) * meta["pageSize"]).limit(meta["pageSize"])).all()
    return {"entries": [public_audit(entry) for entry in entries], "pagination": meta, "serverNow": now}
