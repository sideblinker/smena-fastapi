"""Shift clock, corrections, reporting and audit trail.

The database dependency holds one transaction for the whole request. SQLite
write requests acquire their write lock before authentication and validation,
so changing a shift, its breaks and its audit entry is one atomic operation.
"""

import json
import re
import secrets
from datetime import date, datetime, time, timedelta, timezone as datetime_timezone
from uuid import uuid4
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy import delete, func, select

from backend.common import (
    audit,
    fail,
    get_schedule,
    get_user,
    now_ms,
    public_shift,
    public_user,
    require_admin,
    require_own,
    require_permission,
)
from backend.attendance import OFFSET
from backend.dependencies import CurrentActor, Db
from backend.models import AuditLog, Break, Shift
from backend.schemas.common import Ok
from backend.schemas.shifts import (
    AuditResponse,
    DashboardResponse,
    EmptyAction,
    ReportResponse,
    ShiftCreate,
    ShiftDelete,
    ShiftResponse,
    ShiftListResponse,
    ShiftRecord,
    ShiftStart,
    ShiftUpdate,
)
from backend.schemas.query import (AuditListQuery, DateString, Identifier, PageNumber, PageSize,
                                  ReportRange, ShiftListQuery, validated_query)
from backend.services.lists import list_shifts, list_audit

router = APIRouter(prefix="/api", tags=["Смены и отчёты"])
MAX_TIME = 8640000000000000
VERSION_MESSAGE = "Смена уже изменена в другом окне. Обновите данные."


def _shift(db, shift_id: str):
    row = db.get(Shift, shift_id)
    if row is None:
        fail(404, "NOT_FOUND", "Смена не найдена.")
    return row


def _overlaps(db, user_id, start, end, exclude_id=None):
    query = select(Shift.id).where(
        Shift.user_id == user_id,
        Shift.started_at < (MAX_TIME if end is None else end),
        func.coalesce(Shift.ended_at, MAX_TIME) > start,
    )
    if exclude_id is not None:
        query = query.where(Shift.id != exclude_id)
    return db.scalar(query.limit(1)) is not None


def _validated_values(values, now):
    """Validate the complete record after a PATCH has been merged with storage."""
    data = {key: values[key] for key in ("startedAt", "endedAt", "breaks", "note") if key in values}
    try:
        return ShiftRecord.model_validate(data, context={"now": now}).model_dump()
    except ValidationError as error:
        errors = [{**entry, "loc": ("body", *entry["loc"])} for entry in error.errors()]
        raise RequestValidationError(errors) from None


def _insert_breaks(db, shift_id, breaks):
    for pause in breaks:
        db.add(Break(id=str(uuid4()), shift_id=shift_id,
                     started_at=pause["startedAt"], ended_at=pause.get("endedAt")))


@router.get("/dashboard", response_model=DashboardResponse, summary="Смены и график сотрудника")
def dashboard(request: Request, db: Db, actor: CurrentActor, userId: Identifier | None = None):
    user_id = userId or actor.user["id"]
    require_own(actor, user_id)
    user = get_user(db, user_id)
    rows = db.scalars(select(Shift).where(Shift.user_id == user_id)
                      .order_by(Shift.started_at.desc(), Shift.id.desc()).limit(2000)).all()
    return {"user": public_user(db, user), "schedule": get_schedule(db, user_id),
            "shifts": [public_shift(db, row) for row in rows], "serverNow": now_ms(request)}


@router.get("/shifts", response_model=ShiftListResponse, summary="История смен: фильтры и пагинация")
def shift_list(request: Request, db: Db, actor: CurrentActor, query: Annotated[ShiftListQuery, Query()]):
    return list_shifts(db, actor, query, now_ms(request))


@router.get("/shifts/{shift_id}", response_model=ShiftResponse, summary="Подробности смены и её перерывов")
def read_shift(shift_id: Identifier, db: Db, actor: CurrentActor):
    shift = _shift(db, shift_id)
    require_own(actor, shift.user_id)
    return {"shift": public_shift(db, shift)}


@router.post("/shifts/start", response_model=ShiftResponse, status_code=201, summary="Начать смену")
def start_shift(body: ShiftStart, request: Request, db: Db, actor: CurrentActor):
    require_permission(actor, "track_time")
    user_id = body.userId or actor.user["id"]
    require_own(actor, user_id)
    user = get_user(db, user_id)
    if not user.active or user.archived:
        fail(409, "INACTIVE_USER", "Для отключённого или архивного сотрудника нельзя начать смену.")
    now = now_ms(request)
    if _overlaps(db, user_id, now, None):
        fail(409, "ACTIVE_SHIFT", "У сотрудника уже есть незавершённая или пересекающаяся смена.")
    row = Shift(id=str(uuid4()), user_id=user_id, started_at=now, ended_at=None,
                note="", version=1, revision_token=secrets.token_urlsafe(32))
    db.add(row)
    db.flush()
    audit(db, actor, "shift_started", "shift", row.id, {"userId": user_id}, now)
    return {"shift": public_shift(db, row)}


def _clock_action(action, shift_id, request, db, actor):
    require_permission(actor, "track_time")
    row = _shift(db, shift_id)
    require_own(actor, row.user_id)
    if row.ended_at is not None:
        fail(409, "SHIFT_FINISHED", "Эта смена уже завершена.")
    current_break = db.scalar(select(Break).where(Break.shift_id == row.id, Break.ended_at.is_(None)))
    if action == "pause" and current_break is not None:
        fail(409, "ALREADY_PAUSED", "Перерыв уже начат.")
    if action == "resume" and current_break is None:
        fail(409, "NOT_PAUSED", "Нет открытого перерыва.")
    now = now_ms(request)
    latest_break_end = db.scalar(select(func.max(Break.ended_at)).where(Break.shift_id == row.id))
    if (now < row.started_at or (current_break is not None and now < current_break.started_at)
            or (latest_break_end is not None and now < latest_break_end)
            or (action == "finish" and now <= row.started_at)):
        fail(409, "CLOCK_CONFLICT", "Время сервера изменилось. Повторите действие позже.")
    if action == "pause":
        count = db.scalar(select(func.count()).select_from(Break).where(Break.shift_id == row.id))
        if count >= 100:
            fail(409, "BREAK_LIMIT", "В смене допускается не более 100 перерывов.")
        _insert_breaks(db, row.id, [{"startedAt": now, "endedAt": None}])
    if current_break is not None and action in ("resume", "finish"):
        current_break.ended_at = now
    if action == "finish":
        row.ended_at = now
    row.version += 1
    row.revision_token = secrets.token_urlsafe(32)
    db.flush()
    audit(db, actor, {"pause": "break_started", "resume": "break_finished", "finish": "shift_finished"}[action],
          "shift", row.id, {"userId": row.user_id}, now)
    return {"shift": public_shift(db, row)}


@router.post("/shifts/{shift_id}/pause", response_model=ShiftResponse, summary="Начать перерыв")
def pause_shift(shift_id: Identifier, body: EmptyAction, request: Request, db: Db, actor: CurrentActor):
    return _clock_action("pause", shift_id, request, db, actor)


@router.post("/shifts/{shift_id}/resume", response_model=ShiftResponse, summary="Закончить перерыв")
def resume_shift(shift_id: Identifier, body: EmptyAction, request: Request, db: Db, actor: CurrentActor):
    return _clock_action("resume", shift_id, request, db, actor)


@router.post("/shifts/{shift_id}/finish", response_model=ShiftResponse, summary="Закончить смену")
def finish_shift(shift_id: Identifier, body: EmptyAction, request: Request, db: Db, actor: CurrentActor):
    return _clock_action("finish", shift_id, request, db, actor)


@router.post("/shifts", response_model=ShiftResponse, status_code=201, summary="Добавить смену вручную")
def create_shift(body: ShiftCreate, request: Request, db: Db, actor: CurrentActor):
    require_permission(actor, "edit_own_shifts")
    user_id = body.userId or actor.user["id"]
    require_own(actor, user_id)
    get_user(db, user_id)
    now = now_ms(request)
    values = _validated_values(body.model_dump(), now)
    if _overlaps(db, user_id, values["startedAt"], values["endedAt"]):
        fail(409, "SHIFT_OVERLAP", "Смена пересекается с другой сменой этого сотрудника.")
    row = Shift(id=str(uuid4()), user_id=user_id, started_at=values["startedAt"],
                ended_at=values["endedAt"], note=values["note"], version=1,
                revision_token=secrets.token_urlsafe(32))
    db.add(row)
    db.flush()
    _insert_breaks(db, row.id, values["breaks"])
    db.flush()
    audit(db, actor, "shift_created", "shift", row.id, {"userId": user_id, **values}, now)
    return {"shift": public_shift(db, row)}


@router.patch("/shifts/{shift_id}", response_model=ShiftResponse, summary="Исправить время и перерывы смены")
def update_shift(shift_id: Identifier, body: ShiftUpdate, request: Request, db: Db, actor: CurrentActor):
    row = _shift(db, shift_id)
    # Ownership comes only from storage. Ordinary employees can correct their
    # own records even when manual creation/deletion permissions are disabled.
    require_own(actor, row.user_id)
    if body.version != row.version:
        fail(409, "VERSION_CONFLICT", VERSION_MESSAGE)
    current = public_shift(db, row)
    now = now_ms(request)
    values = _validated_values({**current, **body.model_dump(exclude_unset=True)}, now)
    if _overlaps(db, row.user_id, values["startedAt"], values["endedAt"], row.id):
        fail(409, "SHIFT_CONFLICT", "Смена пересекается с другой сменой этого сотрудника.")
    row.started_at, row.ended_at, row.note = values["startedAt"], values["endedAt"], values["note"]
    row.version += 1
    row.revision_token = secrets.token_urlsafe(32)
    db.execute(delete(Break).where(Break.shift_id == row.id))
    db.flush()
    _insert_breaks(db, row.id, values["breaks"])
    db.flush()
    audit(db, actor, "shift_updated", "shift", row.id,
          {"userId": row.user_id, "reason": body.reason,
           "before": {key: current[key] for key in ("startedAt", "endedAt", "breaks", "note")},
           "after": values, "previousVersion": body.version}, now)
    return {"shift": public_shift(db, row)}


@router.delete("/shifts/{shift_id}", response_model=Ok, summary="Удалить смену")
def delete_shift(shift_id: Identifier, body: ShiftDelete, request: Request, db: Db, actor: CurrentActor):
    require_permission(actor, "edit_own_shifts")
    row = _shift(db, shift_id)
    require_own(actor, row.user_id)
    if body.version != row.version:
        fail(409, "VERSION_CONFLICT", VERSION_MESSAGE)
    details = {"userId": row.user_id, "startedAt": row.started_at, "endedAt": row.ended_at}
    db.delete(row)
    db.flush()  # breaks are removed by their ON DELETE CASCADE foreign key
    audit(db, actor, "shift_deleted", "shift", shift_id, details, now_ms(request))
    return {"ok": True}


def _overlap(start, end, other_start, other_end):
    return max(0, min(end, other_end) - max(start, other_start))


def build_report(db, user_id, from_date, to_date, now, timezone):
    """Range reports clip to calendar midnights (the monthly timesheet does not)."""
    # Match the fixed UTC+5 business calendar and editor for historical records
    # as well. IANA's historical offsets would move an old shift to another day.
    zone = datetime_timezone(timedelta(milliseconds=OFFSET))
    today = datetime.fromtimestamp(now / 1000, zone).date()
    period = validated_query(ReportRange, {"from": from_date or today.replace(day=1).isoformat(), "to": to_date or today.isoformat()})
    first, last = date.fromisoformat(period.from_date), date.fromisoformat(period.to)
    day_count = (last - first).days + 1
    dates = [first + timedelta(days=i) for i in range(day_count + 1)]
    # Datetime subtraction supports all validated dates, including dates before
    # 1970, without the platform-specific limits of Windows timestamp().
    epoch = datetime(1970, 1, 1, tzinfo=datetime_timezone.utc)
    bounds = [(datetime.combine(day, time.min, zone) - epoch) // timedelta(milliseconds=1) for day in dates]
    selected = db.scalars(select(Shift).where(
        Shift.user_id == user_id,
        Shift.started_at < bounds[-1],
        func.coalesce(Shift.ended_at, now) > bounds[0],
    ).order_by(Shift.started_at)).all()
    shifts = [public_shift(db, row) for row in selected]
    days, completed_work = [], 0
    for i, day in enumerate(dates[:-1]):
        work_ms, break_ms = 0, 0
        for shift in shifts:
            finish = now if shift["endedAt"] is None else shift["endedAt"]
            duration = _overlap(shift["startedAt"], finish, bounds[i], bounds[i + 1])
            pause_time = sum(_overlap(pause["startedAt"], finish if pause["endedAt"] is None else pause["endedAt"],
                                      bounds[i], bounds[i + 1]) for pause in shift["breaks"])
            work_ms += duration - pause_time
            break_ms += pause_time
            if shift["endedAt"] is not None:
                completed_work += duration - pause_time
        days.append({"date": day.isoformat(), "workMs": work_ms, "breakMs": break_ms})
    completed_count = sum(shift["endedAt"] is not None for shift in shifts)
    return {"days": days, "totals": {
        "workMs": sum(day["workMs"] for day in days), "breakMs": sum(day["breakMs"] for day in days),
        "completedShifts": completed_count,
        "averageMs": (completed_work * 2 + completed_count) // (2 * completed_count) if completed_count else 0,
    }, "serverNow": now}


@router.get("/reports", response_model=ReportResponse, summary="Отчёт за диапазон дат")
def reports(request: Request, db: Db, actor: CurrentActor, userId: Identifier | None = None,
            from_date: Annotated[DateString | None, Query(alias="from")] = None, to: DateString | None = None):
    require_permission(actor, "view_reports")
    user_id = userId or actor.user["id"]
    require_own(actor, user_id)
    get_user(db, user_id)
    schedule = get_schedule(db, user_id)
    return build_report(db, user_id, from_date, to, now_ms(request), schedule["timezone"])


def _csv_quote(value):
    value = str(value)
    if re.match(r"^[\s\ufeff]*[=+\-@]", value) or re.match(r"^[\t\r\n]", value):
        value = "'" + value
    return '"' + value.replace('"', '""') + '"'


@router.get("/export", response_class=Response, summary="Скачать отчёт CSV",
            responses={200: {"content": {"text/csv": {}}, "description": "CSV в UTF-8 с BOM; разделитель — точка с запятой."}})
def export_report(request: Request, db: Db, actor: CurrentActor, userId: Identifier | None = None,
                  from_date: Annotated[DateString | None, Query(alias="from")] = None, to: DateString | None = None):
    require_permission(actor, "export_reports")
    user_id = userId or actor.user["id"]
    require_own(actor, user_id)
    user = get_user(db, user_id)
    schedule = get_schedule(db, user_id)
    now = now_ms(request)
    report = build_report(db, user_id, from_date, to, now, schedule["timezone"])
    lines = [["Сотрудник", "Дата", "Рабочее время (часы)", "Перерывы (часы)"]]
    lines.extend([user.name, day["date"], f'{day["workMs"] / 3600000:.2f}', f'{day["breakMs"] / 3600000:.2f}']
                 for day in report["days"])
    lines.append(["Итого", "", f'{report["totals"]["workMs"] / 3600000:.2f}', f'{report["totals"]["breakMs"] / 3600000:.2f}'])
    csv = "\ufeff" + "\r\n".join(";".join(_csv_quote(cell) for cell in line) for line in lines)
    audit(db, actor, "report_exported", "user", user_id,
          {"from": report["days"][0]["date"], "to": report["days"][-1]["date"]}, now)
    return Response(csv, media_type="text/csv", headers={
        "Content-Disposition": 'attachment; filename="smena-report.csv"', "Cache-Control": "no-store"})


@router.get("/audit", response_model=AuditResponse, response_model_exclude_none=True, summary="Журнал действий — только для администратора")
def audit_log(request: Request, db: Db, actor: CurrentActor, page: PageNumber | None = None, pageSize: PageSize = 20):
    require_admin(actor)
    if page is not None:
        return list_audit(db, actor, AuditListQuery(page=page, pageSize=pageSize), now_ms(request))
    entries = db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).limit(300)).all()
    return {"entries": [{"id": entry.id, "actorName": entry.actor_name, "action": entry.action,
                         "targetType": entry.target_type, "targetId": entry.target_id,
                         "details": json.loads(entry.details), "createdAt": entry.created_at} for entry in entries]}
