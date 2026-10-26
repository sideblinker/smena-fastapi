"""Validated request and response models for shifts and calendar-day reports."""

from typing import Annotated, Any

from pydantic import Field, ValidationInfo, field_validator, model_validator

from backend.schemas.common import ApiModel, EpochMs, Pagination, ReadSchedule, ReadShift, ReadUser
from backend.schemas.query import Identifier


class EmptyAction(ApiModel):
    """Timer actions deliberately accept no client-provided timestamp or owner."""


class ShiftStart(ApiModel):
    userId: Identifier | None = None


class BreakInput(ApiModel):
    startedAt: EpochMs
    endedAt: EpochMs | None = None

    @model_validator(mode="after")
    def chronological(self):
        if self.endedAt is not None and self.endedAt < self.startedAt:
            raise ValueError("Конец перерыва не может быть раньше его начала.")
        return self


class ShiftCreate(ApiModel):
    userId: Identifier | None = None
    startedAt: EpochMs
    endedAt: EpochMs | None = None
    breaks: list[BreakInput] = Field(default_factory=list, max_length=100)
    note: str = Field(default="", max_length=2000)

    @field_validator("note", mode="before")
    @classmethod
    def trim_note(cls, value):
        return value.strip() if isinstance(value, str) else value


class ShiftRecord(ApiModel):
    """Validate the complete state after a partial edit is merged with SQL data."""
    startedAt: EpochMs
    endedAt: EpochMs | None = None
    breaks: list[BreakInput] = Field(default_factory=list, max_length=100)
    note: str = Field(default="", max_length=2000)

    @model_validator(mode="after")
    def intervals(self, info: ValidationInfo):
        now = info.context["now"]
        if self.startedAt > now or (self.endedAt is not None and not self.startedAt < self.endedAt <= now):
            raise ValueError("Смена должна начинаться раньше окончания. Будущие отметки недопустимы.")
        end = self.endedAt if self.endedAt is not None else now
        self.breaks.sort(key=lambda pause: pause.startedAt)
        previous_end = self.startedAt
        for i, pause in enumerate(self.breaks):
            if (pause.startedAt < self.startedAt or pause.startedAt > end
                    or (pause.endedAt is not None and pause.endedAt > end)
                    or pause.startedAt < previous_end
                    or (pause.endedAt is None and (self.endedAt is not None or i != len(self.breaks) - 1))):
                raise ValueError("Перерывы должны находиться внутри смены и не пересекаться. Открытым может быть только последний перерыв активной смены.")
            previous_end = pause.endedAt if pause.endedAt is not None else 8640000000000000
        return self


class ShiftUpdate(ApiModel):
    version: Annotated[int, Field(strict=True, ge=1)]
    reason: str = Field(min_length=3, max_length=500)
    startedAt: EpochMs | None = None
    endedAt: EpochMs | None = None
    breaks: list[BreakInput] | None = Field(default=None, max_length=100)
    note: str | None = Field(default=None, max_length=2000)

    @field_validator("reason", "note", mode="before")
    @classmethod
    def trim_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def reject_explicit_null(self):
        for name in ("startedAt", "breaks", "note"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"Поле {name} не может быть null.")
        return self


class ShiftDelete(ApiModel):
    version: Annotated[int, Field(strict=True, ge=1)]


class ShiftResponse(ApiModel):
    shift: ReadShift


class ShiftListResponse(ApiModel):
    shifts: list[ReadShift]
    pagination: Pagination
    serverNow: int


class DashboardResponse(ApiModel):
    user: ReadUser
    schedule: ReadSchedule
    shifts: list[ReadShift]
    serverNow: int


class ReportDay(ApiModel):
    date: str
    workMs: int
    breakMs: int


class ReportTotals(ApiModel):
    workMs: int
    breakMs: int
    completedShifts: int
    averageMs: int


class ReportResponse(ApiModel):
    days: list[ReportDay]
    totals: ReportTotals
    serverNow: int


class AuditEntry(ApiModel):
    id: str
    actorName: str
    action: str
    targetType: str
    targetId: str
    details: dict[str, Any]
    createdAt: int


class AuditResponse(ApiModel):
    entries: list[AuditEntry]
    pagination: Pagination | None = None
    serverNow: int | None = None
