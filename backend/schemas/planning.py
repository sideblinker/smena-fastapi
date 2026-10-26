"""Validated inputs and documented responses for leave and attendance."""
from datetime import date
from typing import Annotated, Literal

from pydantic import AfterValidator, BeforeValidator, Field, model_validator

from .common import ApiModel, Pagination, ReadSchedule, ReadShift, ReadUser
from .query import DateString, Identifier, valid_date


def strip_text(value):
    return value.strip() if isinstance(value, str) else value


Version = Annotated[int, Field(strict=True, ge=1)]
Note = Annotated[str, BeforeValidator(strip_text), Field(max_length=2000)]


class DateRange(ApiModel):
    startDate: DateString
    endDate: DateString

    @model_validator(mode="after")
    def check_range(self):
        count = (date.fromisoformat(self.endDate) - date.fromisoformat(self.startDate)).days + 1
        if not 1 <= count <= 366:
            raise ValueError("Период отсутствия должен составлять от 1 до 366 дней.")
        return self


class AbsenceCreate(DateRange):
    userId: Identifier
    type: Literal["vacation", "day_off", "other"]
    note: Note = ""


class RequestCreate(DateRange):
    type: Literal["vacation", "day_off"]
    note: Note = ""


class VersionInput(ApiModel):
    version: Version


class RequestDecision(VersionInput):
    status: Literal["approved", "rejected"]
    decisionNote: Annotated[str, BeforeValidator(strip_text), Field(max_length=500)] = ""

    @model_validator(mode="after")
    def rejection_requires_reason(self):
        if self.status == "rejected" and len(self.decisionNote) < 3:
            raise ValueError("Укажите причину отказа: от 3 до 500 символов.")
        return self


class AbsenceRead(ApiModel):
    id: str
    userId: str
    startDate: str
    endDate: str
    type: Literal["vacation", "day_off", "other"]
    note: str
    createdAt: int
    version: int


class RequestOwner(ApiModel):
    id: str
    name: str
    department: str
    position: str


class RequestDecider(ApiModel):
    id: str
    name: str


class RequestRead(ApiModel):
    id: str
    userId: str
    user: RequestOwner
    startDate: str
    endDate: str
    type: Literal["vacation", "day_off"]
    note: str
    status: Literal["pending", "approved", "rejected", "cancelled"]
    createdAt: int
    decidedAt: int | None
    decidedBy: RequestDecider | None
    decisionNote: str
    absenceId: str | None
    version: int


class AbsenceResponse(ApiModel):
    absence: AbsenceRead


class AbsenceList(ApiModel):
    absences: list[AbsenceRead]
    serverNow: int


class RequestResponse(ApiModel):
    request: RequestRead


class RequestCounts(ApiModel):
    pending: int = 0
    approved: int = 0
    rejected: int = 0
    cancelled: int = 0


class RequestList(ApiModel):
    requests: list[RequestRead]
    counts: RequestCounts
    serverNow: int
    pagination: Pagination | None = None


class AttendanceDay(ApiModel):
    date: str
    plannedStart: int | None
    plannedEnd: int | None
    plannedMs: int
    workMs: int
    breakMs: int
    lateMs: int
    overtimeMs: int
    kind: Literal["absence", "workday", "day_off"]
    state: Literal["break", "working", "finished", "upcoming", "missed", "not_started"]
    absence: AbsenceRead | None
    shiftIds: list[str]
    firstStart: int | None
    lastEnd: int | None


class CalendarResponse(ApiModel):
    user: ReadUser
    schedule: ReadSchedule
    month: str
    days: list[AttendanceDay]
    shifts: list[ReadShift]
    absences: list[AbsenceRead]
    serverNow: int


class TeamMember(ApiModel):
    user: ReadUser
    status: Literal["break", "working", "finished", "absence", "day_off", "not_started"]
    activeShift: ReadShift | None
    day: AttendanceDay


class TeamResponse(ApiModel):
    members: list[TeamMember]
    serverNow: int


class TimesheetRow(ApiModel):
    user: ReadUser
    days: list[AttendanceDay]
    plannedMs: int
    workMs: int
    breakMs: int
    lateMs: int
    overtimeMs: int


class TimesheetResponse(ApiModel):
    month: str
    days: list[str]
    rows: list[TimesheetRow]
    serverNow: int
