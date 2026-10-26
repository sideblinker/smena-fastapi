"""Calendar, monthly attendance, approved absences and employee requests."""
from collections import defaultdict
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, Query, Request
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ..attendance import build_attendance_month, local_date, month_bounds
from ..common import (audit, fail, get_schedule, get_user, now_ms, public_shift,
                      public_user, require_admin, require_own, require_permission)
from ..dependencies import CurrentActor, Db
from ..models import Absence, AbsenceRequest, Shift, User
from ..schemas.common import Ok
from ..schemas.planning import (AbsenceCreate, AbsenceList, AbsenceResponse,
                                CalendarResponse, Identifier, RequestCreate,
                                RequestDecision, RequestList, RequestResponse,
                                TeamResponse, TimesheetResponse, VersionInput)
from ..schemas.query import (DateRangeQuery, DateString, MonthString, PageNumber, PageSize,
                             RequestStatus, validated_query)
from ..services.lists import pagination

router = APIRouter(prefix="/api", tags=["Календарь и отсутствия"])


def attendance_month(value: str | None, now: int) -> dict:
    month = value or local_date(now)[:7]
    bounds = month_bounds(month)
    return {"month": month, **bounds, "firstDate": month + "-01", "lastDate": local_date(bounds["to"] - 1)}


def absence_range(start: str, end: str) -> tuple[str, str]:
    period = validated_query(DateRangeQuery, {"from": start, "to": end})
    return period.from_date, period.to


def absence_public(row: Absence) -> dict:
    return {"id": row.id, "userId": row.user_id, "startDate": row.start_date,
            "endDate": row.end_date, "type": row.type, "note": row.note,
            "createdAt": row.created_at, "version": row.version}


def request_public(db: Session, row: AbsenceRequest) -> dict:
    owner = db.get(User, row.user_id)
    decider = db.get(User, row.decided_by) if row.decided_by else None
    return {"id": row.id, "userId": row.user_id,
            "user": {"id": owner.id, "name": owner.name, "department": owner.department, "position": owner.position},
            "startDate": row.start_date, "endDate": row.end_date, "type": row.type,
            "note": row.note, "status": row.status, "createdAt": row.created_at,
            "decidedAt": row.decided_at, "decidedBy": {"id": decider.id, "name": decider.name} if decider else None,
            "decisionNote": row.decision_note, "absenceId": row.absence_id, "version": row.version}


def get_request(db: Session, request_id: str) -> AbsenceRequest:
    row = db.get(AbsenceRequest, request_id)
    if row is None:
        fail(404, "NOT_FOUND", "Заявка не найдена.")
    return row


def overlapping_absence(db: Session, user_id: str, start: str, end: str) -> bool:
    return db.scalar(select(Absence.id).where(Absence.user_id == user_id,
                                            Absence.start_date <= end,
                                            Absence.end_date >= start).limit(1)) is not None


def attendance_inputs(db: Session, period: dict, user_id: str | None, include_active: bool = False):
    starts_in_month = and_(Shift.started_at >= period["from"], Shift.started_at < period["to"])
    shift_query = select(Shift).where(or_(starts_in_month, Shift.ended_at.is_(None)) if include_active else starts_in_month)
    absence_query = select(Absence).where(Absence.start_date <= period["lastDate"], Absence.end_date >= period["firstDate"])
    if user_id:
        shift_query = shift_query.where(Shift.user_id == user_id)
        absence_query = absence_query.where(Absence.user_id == user_id)
    shifts, absences = defaultdict(list), defaultdict(list)
    for row in db.scalars(shift_query.order_by(Shift.started_at, Shift.id)):
        shifts[row.user_id].append(public_shift(db, row))
    for row in db.scalars(absence_query.order_by(Absence.start_date, Absence.id)):
        absences[row.user_id].append(absence_public(row))

    def inputs(selected_id: str):
        return {"schedule": get_schedule(db, selected_id), "shifts": shifts[selected_id], "absences": absences[selected_id]}

    return inputs


@router.get("/calendar", response_model=CalendarResponse, summary="Личный календарь план/факт")
def calendar(request: Request, db: Db, actor: CurrentActor,
             user_id: Annotated[Identifier | None, Query(alias="userId")] = None, month: MonthString | None = None):
    now = now_ms(request)
    user_id = user_id or actor.user["id"]
    require_own(actor, user_id)
    user = get_user(db, user_id)
    period = attendance_month(month, now)
    inputs = attendance_inputs(db, period, user_id)(user_id)
    days = build_attendance_month(month=period["month"], **inputs, now=now, created_at=user.created_at)
    return {"user": public_user(db, user), "month": period["month"], **inputs, "days": days, "serverNow": now}


@router.get("/team-status", response_model=TeamResponse, summary="Текущее состояние команды")
def team_status(request: Request, db: Db, actor: CurrentActor):
    require_admin(actor)
    now = now_ms(request)
    period, today = attendance_month(None, now), local_date(now)
    users = db.scalars(select(User).where(User.active == 1, User.archived == 0).order_by(User.master.desc(), User.name)).all()
    inputs_for = attendance_inputs(db, period, None, include_active=True)
    members = []
    for user in users:
        inputs = inputs_for(user.id)
        day = next(day for day in build_attendance_month(month=period["month"], **inputs, now=now,
                                                        created_at=user.created_at) if day["date"] == today)
        active = next((shift for shift in inputs["shifts"] if shift["endedAt"] is None), None)
        if active:
            status = "break" if any(pause["endedAt"] is None for pause in active["breaks"]) else "working"
        else:
            status = "finished" if day["shiftIds"] else day["kind"] if day["kind"] in ("absence", "day_off") else "not_started"
        members.append({"user": public_user(db, user), "status": status, "activeShift": active, "day": day})
    return {"members": members, "serverNow": now}


@router.get("/timesheet", response_model=TimesheetResponse, summary="Месячный табель")
def timesheet(request: Request, db: Db, actor: CurrentActor,
              user_id: Annotated[Identifier | Literal["all"] | None, Query(alias="userId")] = None, month: MonthString | None = None):
    require_permission(actor, "view_reports")
    now = now_ms(request)
    user_id = user_id or actor.user["id"]
    period = attendance_month(month, now)
    if user_id == "all":
        require_admin(actor)
        has_shift = select(Shift.id).where(Shift.user_id == User.id, Shift.started_at >= period["from"],
                                           Shift.started_at < period["to"]).exists()
        has_absence = select(Absence.id).where(Absence.user_id == User.id, Absence.start_date <= period["lastDate"],
                                              Absence.end_date >= period["firstDate"]).exists()
        users = db.scalars(select(User).where(or_(User.archived == 0, has_shift, has_absence))
                           .order_by(User.master.desc(), User.name)).all()
    else:
        require_own(actor, user_id)
        users = [get_user(db, user_id)]
    inputs_for = attendance_inputs(db, period, None if user_id == "all" else user_id)
    rows = []
    for user in users:
        days = build_attendance_month(month=period["month"], **inputs_for(user.id), now=now, created_at=user.created_at)
        totals = {key: sum(day[key] for day in days) for key in ("plannedMs", "workMs", "breakMs", "lateMs", "overtimeMs")}
        rows.append({"user": public_user(db, user), "days": days, **totals})
    days = rows[0]["days"] if rows else build_attendance_month(month=period["month"], schedule=get_schedule(db, ""), now=now)
    return {"month": period["month"], "days": [day["date"] for day in days], "rows": rows, "serverNow": now}


@router.get("/absences", response_model=AbsenceList, summary="Согласованные отсутствия сотрудника")
def list_absences(request: Request, db: Db, actor: CurrentActor,
                  user_id: Annotated[Identifier | None, Query(alias="userId")] = None,
                  start: Annotated[DateString | None, Query(alias="from")] = None,
                  end: Annotated[DateString | None, Query(alias="to")] = None):
    user_id = user_id or actor.user["id"]
    require_own(actor, user_id)
    get_user(db, user_id)
    now = now_ms(request)
    period = attendance_month(None, now)
    start, end = absence_range(start or period["firstDate"], end or period["lastDate"])
    rows = db.scalars(select(Absence).where(Absence.user_id == user_id, Absence.start_date <= end,
                                           Absence.end_date >= start).order_by(Absence.start_date, Absence.id))
    return {"absences": [absence_public(row) for row in rows], "serverNow": now}


@router.post("/absences", response_model=AbsenceResponse, status_code=201, summary="Добавить отсутствие (администратор)")
def create_absence(body: AbsenceCreate, request: Request, db: Db, actor: CurrentActor):
    require_admin(actor)
    get_user(db, body.userId)
    if overlapping_absence(db, body.userId, body.startDate, body.endDate):
        fail(409, "ABSENCE_OVERLAP", "Выбранный период пересекается с другим отсутствием сотрудника.")
    now = now_ms(request)
    row = Absence(id=str(uuid4()), user_id=body.userId, start_date=body.startDate, end_date=body.endDate,
                  type=body.type, note=body.note, created_at=now, version=1)
    db.add(row)
    db.flush()
    audit(db, actor, "absence_created", "absence", row.id, body.model_dump(), now)
    return {"absence": absence_public(row)}


@router.delete("/absences/{absence_id}", response_model=Ok, summary="Удалить отсутствие (администратор)")
def delete_absence(absence_id: Identifier, body: VersionInput, request: Request, db: Db, actor: CurrentActor):
    require_admin(actor)
    row = db.get(Absence, absence_id)
    if row is None:
        fail(404, "NOT_FOUND", "Отсутствие не найдено.")
    if row.version != body.version:
        fail(409, "VERSION_CONFLICT", "Отсутствие уже изменено. Обновите данные.")
    details = absence_public(row)
    db.delete(row)
    db.flush()  # FK SET NULL keeps the original approval in request history.
    audit(db, actor, "absence_deleted", "absence", absence_id, details, now_ms(request))
    return {"ok": True}


@router.get("/absence-requests", response_model=RequestList, summary="Заявки на отпуск и отгул")
def list_requests(request: Request, db: Db, actor: CurrentActor, status: RequestStatus = "all",
                  page: PageNumber | None = None, pageSize: PageSize = 20):
    statuses = ("pending", "approved", "rejected", "cancelled")
    query = select(AbsenceRequest)
    where = []
    if actor.user["role"] != "admin":
        where.append(AbsenceRequest.user_id == actor.user["id"])
    query = query.where(*where)
    if page is not None:
        counts = {key: 0 for key in statuses}
        for key, count in db.execute(select(AbsenceRequest.status, func.count()).where(*where).group_by(AbsenceRequest.status)):
            counts[key] = count
        if status != "all":
            query = query.where(AbsenceRequest.status == status)
        total = sum(counts.values()) if status == "all" else counts[status]
        meta = pagination(total, page, pageSize)
        rows = db.scalars(query.order_by(AbsenceRequest.created_at.desc(), AbsenceRequest.id.desc())
                          .offset((meta["page"] - 1) * meta["pageSize"]).limit(meta["pageSize"])).all()
        return {"requests": [request_public(db, row) for row in rows], "pagination": meta,
                "counts": counts, "serverNow": now_ms(request)}
    rows = db.scalars(query.order_by(AbsenceRequest.created_at.desc(), AbsenceRequest.id.desc())).all()
    counts = {key: 0 for key in statuses}
    for row in rows:
        counts[row.status] += 1
    return {"requests": [request_public(db, row) for row in rows if status == "all" or row.status == status],
            "counts": counts, "serverNow": now_ms(request)}


@router.post("/absence-requests", response_model=RequestResponse, status_code=201, summary="Подать свою заявку")
def create_request(body: RequestCreate, request: Request, db: Db, actor: CurrentActor):
    user_id, now = actor.user["id"], now_ms(request)
    pending_overlap = db.scalar(select(AbsenceRequest.id).where(
        AbsenceRequest.user_id == user_id, AbsenceRequest.status == "pending",
        AbsenceRequest.start_date <= body.endDate, AbsenceRequest.end_date >= body.startDate).limit(1))
    if pending_overlap or overlapping_absence(db, user_id, body.startDate, body.endDate):
        fail(409, "REQUEST_OVERLAP", "Период пересекается с ожидающей заявкой или отсутствием.")
    row = AbsenceRequest(id=str(uuid4()), user_id=user_id, start_date=body.startDate, end_date=body.endDate,
                         type=body.type, note=body.note, status="pending", created_at=now,
                         decided_at=None, decided_by=None, decision_note="", absence_id=None, version=1)
    db.add(row)
    db.flush()
    audit(db, actor, "absence_request_created", "absence_request", row.id, {"userId": user_id, **body.model_dump()}, now)
    return {"request": request_public(db, row)}


@router.patch("/absence-requests/{request_id}", response_model=RequestResponse, summary="Одобрить или отклонить заявку")
def decide_request(request_id: Identifier, body: RequestDecision, request: Request, db: Db, actor: CurrentActor):
    require_admin(actor)
    row = get_request(db, request_id)
    if row.status != "pending" or row.version != body.version:
        fail(409, "REQUEST_CONFLICT", "Заявка уже рассмотрена, отменена или изменена. Обновите данные.")
    now = now_ms(request)
    details = {"userId": row.user_id, "decisionNote": body.decisionNote, "previousVersion": body.version}
    if body.status == "approved":
        owner = get_user(db, row.user_id)
        if not owner.active or owner.archived:
            fail(409, "INACTIVE_USER", "Нельзя одобрить заявку отключённого или архивного сотрудника.")
        if overlapping_absence(db, row.user_id, row.start_date, row.end_date):
            fail(409, "REQUEST_CONFLICT", "Даты пересекаются с существующим отсутствием.")
        absence = Absence(id=str(uuid4()), user_id=row.user_id, start_date=row.start_date, end_date=row.end_date,
                          type=row.type, note=row.note, created_at=now, version=1)
        db.add(absence)
        db.flush()
        row.absence_id = absence.id
        details.update(startDate=row.start_date, endDate=row.end_date, type=row.type, absenceId=absence.id)
    row.status = body.status
    row.decided_at = now
    row.decided_by = actor.user["id"]
    row.decision_note = body.decisionNote
    row.version += 1
    db.flush()
    audit(db, actor, "absence_request_" + body.status, "absence_request", row.id, details, now)
    return {"request": request_public(db, row)}


@router.post("/absence-requests/{request_id}/cancel", response_model=RequestResponse, summary="Отменить свою ожидающую заявку")
def cancel_request(request_id: Identifier, body: VersionInput, request: Request, db: Db, actor: CurrentActor):
    row = get_request(db, request_id)
    if row.user_id != actor.user["id"]:
        fail(403, "FORBIDDEN", "Отменить заявку может только её автор.")
    if row.status != "pending" or row.version != body.version:
        fail(409, "REQUEST_CONFLICT", "Отменить можно только свою ожидающую заявку актуальной версии.")
    now = now_ms(request)
    row.status, row.decided_at, row.decided_by = "cancelled", now, actor.user["id"]
    row.decision_note = ""
    row.version += 1
    db.flush()
    audit(db, actor, "absence_request_cancelled", "absence_request", row.id,
          {"userId": row.user_id, "previousVersion": body.version}, now)
    return {"request": request_public(db, row)}
