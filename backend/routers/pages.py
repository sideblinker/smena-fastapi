"""Primary HTML routes: data is queried on the server and rendered by Jinja2."""
from datetime import date
from typing import Annotated, Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import Field, field_validator, model_validator
from sqlalchemy import func, select

from ..common import ADMIN_LOGIN, Actor, get_user, now_ms, public_user, require_admin, require_own, require_permission
from ..config import ROOT
from ..dependencies import Db, optional_actor
from ..models import AbsenceRequest, User
from ..schemas.common import ApiModel
from ..schemas.query import AuditListQuery, DateString, Identifier, MonthString, ShiftListQuery, UserListQuery
from ..services.lists import list_audit, list_shifts, list_users
from ..services import presentation as fmt
from .auth import setup_allowed
from . import planning, shifts

router = APIRouter(tags=["HTML-страницы"])
templates = Jinja2Templates(directory=str(ROOT / "backend" / "templates"))
VIEWS = {"overview": "Обзор", "history": "История смен", "employees": "Сотрудники", "calendar": "Календарь", "requests": "Заявки", "reports": "Отчёты", "timesheet": "Табель", "audit": "Журнал действий"}


class PageQuery(ApiModel):
    view: Literal["overview", "history", "employees", "calendar", "requests", "reports", "timesheet", "audit"] = "overview"
    userId: Identifier | None = None
    month: MonthString | None = None
    from_date: DateString | None = Field(default=None, alias="from")
    to: DateString | None = None
    status: str | None = None
    search: str = Field(default="", max_length=100)
    includeArchived: Literal["0", "1"] = "0"
    scope: Literal["selected", "all"] = "selected"
    page: int = Field(default=1, ge=1, le=1_000_000)
    pageSize: int = Field(default=20, ge=1, le=100)

    @field_validator("month", "from_date", "to", "userId", mode="before")
    @classmethod
    def empty_is_missing(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def consistent_filters(self):
        if self.from_date and self.to and self.to < self.from_date:
            raise ValueError("Дата начала должна быть не позже даты окончания.")
        allowed = {"all", "finished", "active"} if self.view == "history" else {"all", "pending", "approved", "rejected", "cancelled"}
        if self.status is not None and self.status not in allowed:
            raise ValueError("Неизвестный статус для выбранного раздела.")
        if self.view == "reports" and self.from_date and self.to and (date.fromisoformat(self.to) - date.fromisoformat(self.from_date)).days >= 366:
            raise ValueError("Выберите период от 1 до 366 дней.")
        return self


@router.get("/", response_class=HTMLResponse, include_in_schema=False)
@router.get("/index.html", response_class=HTMLResponse, include_in_schema=False)
def home(request: Request, db: Db, query: Annotated[PageQuery, Query()], actor: Annotated[Actor | None, Depends(optional_actor)]):
    now = now_ms(request)
    today = fmt.local_datetime(now).date().isoformat()
    is_admin = bool(actor and actor.user["role"] == "admin")
    can = lambda permission: bool(actor and (is_admin or permission in actor.user["permissions"]))
    empty = db.scalar(select(User.id).limit(1)) is None
    session = {"setupRequired": empty and setup_allowed(request), "adminLogin": ADMIN_LOGIN, "user": actor.user if actor else None, "csrfToken": actor.csrf if actor else None, "serverNow": now}
    selected_id = query.userId or (actor.user["id"] if actor else None)
    values = {"view": query.view, "userId": selected_id, "page": query.page, "pageSize": query.pageSize, "month": query.month or today[:7], "from": query.from_date or (today[:7] + "-01" if query.view == "reports" else ""), "to": query.to or (today if query.view == "reports" else ""), "status": query.status or ("pending" if query.view == "requests" and is_admin else "all"), "search": query.search, "includeArchived": query.includeArchived, "scope": query.scope}
    context = {"request": request, "session": session, "is_admin": is_admin, "can": can, "view": query.view, "view_names": VIEWS, "userId": selected_id, "filters": values, "now": now, "today": today, "fmt": fmt, "users": [], "dashboard": None, "overview": None, "history": None, "employees": None, "calendar": None, "requests": None, "timesheet": None, "team": None, "report": None, "audit": None, "pending_count": 0}

    def navigation(target):
        params = {"view": target}
        if selected_id:
            params["userId"] = selected_id
        return "/?" + urlencode(params)

    def page_url(page):
        params = {key: value for key, value in values.items() if value not in (None, "")}
        params["page"] = page
        return "/?" + urlencode(params)

    context.update(nav_url=navigation, page_url=page_url)
    if actor:
        require_own(actor, selected_id)
        if query.view in {"employees", "audit"}:
            require_admin(actor)
        if query.view in {"reports", "timesheet"}:
            require_permission(actor, "view_reports")
        selected = get_user(db, selected_id)
        context["users"] = [public_user(db, user) for user in db.scalars(select(User).order_by(User.master.desc(), User.name, User.id))] if is_admin else [actor.user]
        context["dashboard"], context["overview"] = fmt.dashboard_context(db, selected, now)
        pending = select(func.count()).select_from(AbsenceRequest).where(AbsenceRequest.status == "pending")
        if not is_admin:
            pending = pending.where(AbsenceRequest.user_id == actor.user["id"])
        context["pending_count"] = db.scalar(pending)
        if query.view == "history":
            filters = ShiftListQuery(userId=selected_id, **{"from": query.from_date}, to=query.to, status=values["status"], page=query.page, pageSize=query.pageSize)
            context["history"] = list_shifts(db, actor, filters, now)
        elif query.view == "employees":
            context["employees"] = list_users(db, actor, UserListQuery(search=query.search, includeArchived=query.includeArchived, page=query.page, pageSize=query.pageSize), now)
            context["team"] = planning.team_status(request, db, actor)
        elif query.view == "calendar":
            context["calendar"] = planning.calendar(request, db, actor, user_id=selected_id, month=values["month"])
        elif query.view == "requests":
            context["requests"] = planning.list_requests(request, db, actor, status=values["status"], page=query.page, pageSize=query.pageSize)
        elif query.view == "timesheet":
            context["timesheet"] = planning.timesheet(request, db, actor, user_id="all" if query.scope == "all" else selected_id, month=values["month"])
        elif query.view == "reports":
            context["report"] = shifts.reports(request, db, actor, userId=selected_id, from_date=values["from"], to=values["to"])
        elif query.view == "audit":
            context["audit"] = list_audit(db, actor, AuditListQuery(page=query.page, pageSize=query.pageSize), now)
    context["bootstrap"] = {key: context[key] for key in ("session", "users", "dashboard", "view", "userId", "history", "employees", "calendar", "requests", "timesheet", "team", "report", "audit", "filters")}
    return templates.TemplateResponse(request=request, name="app.html", context=context, headers={"Cache-Control": "no-store"})
