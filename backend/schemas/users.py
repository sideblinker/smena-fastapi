"""Pydantic models for account administration, self-service profiles and schedules."""

from typing import Annotated, Literal

from pydantic import Field, StrictBool, field_validator, model_validator

from backend.common import DEFAULT_PERMISSIONS
from backend.schemas.common import ApiModel, Pagination, ReadSchedule, ReadUser

Permission = Literal["track_time", "edit_own_profile", "edit_own_shifts", "view_reports", "export_reports"]
Weekday = Annotated[int, Field(strict=True, ge=1, le=7)]


class UserCreate(ApiModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=100)
    position: str = Field(default="", max_length=100)
    department: str = Field(default="", max_length=100)
    password: str = Field(min_length=10, max_length=128)
    permissions: list[Permission] = Field(default_factory=lambda: DEFAULT_PERMISSIONS[:], max_length=5)

    @field_validator("username", "name", "position", "department", mode="before")
    @classmethod
    def trim_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("permissions")
    @classmethod
    def unique_permissions(cls, value):
        return list(dict.fromkeys(value))


class ProfileUpdate(ApiModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    position: str | None = Field(default=None, max_length=100)
    department: str | None = Field(default=None, max_length=100)

    @field_validator("name", "position", "department", mode="before")
    @classmethod
    def trim_text(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def reject_explicit_null(self):
        for name in self.model_fields_set:
            if getattr(self, name) is None:
                raise ValueError(f"Поле {name} не может быть null.")
        return self


class UserUpdate(ProfileUpdate):
    username: str | None = Field(default=None, min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    active: StrictBool | None = None
    archived: StrictBool | None = None
    permissions: list[Permission] | None = Field(default=None, max_length=5)
    password: str | None = Field(default=None, min_length=10, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def trim_username(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("permissions")
    @classmethod
    def unique_permissions(cls, value):
        return list(dict.fromkeys(value)) if value is not None else value


class UserResponse(ApiModel):
    user: ReadUser


class UsersResponse(ApiModel):
    users: list[ReadUser]
    pagination: Pagination | None = None
    serverNow: int | None = None


class ScheduleUpdate(ApiModel):
    startTime: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    endTime: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    breakMinutes: Annotated[int, Field(strict=True, ge=0, le=720)]
    weekdays: list[Weekday] = Field(max_length=7)
    timezone: Literal["Asia/Qyzylorda"] = "Asia/Qyzylorda"

    @field_validator("weekdays")
    @classmethod
    def unique_days(cls, value):
        return sorted(set(value))

    @model_validator(mode="after")
    def positive_work_duration(self):
        sh, sm = map(int, self.startTime.split(":"))
        eh, em = map(int, self.endTime.split(":"))
        duration = (eh * 60 + em - sh * 60 - sm) % 1440
        if duration == 0:
            raise ValueError("Укажите разное время начала и окончания рабочего дня.")
        if self.breakMinutes >= duration:
            raise ValueError("Перерыв должен быть короче рабочего дня.")
        return self


class ScheduleResponse(ApiModel):
    schedule: ReadSchedule
