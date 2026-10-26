from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def parse_timestamp(value):
    if isinstance(value, str) and "T" in value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                raise ValueError("Укажите часовой пояс даты.")
            value = int(parsed.timestamp() * 1000)
        except (ValueError, OverflowError, OSError) as error:
            raise ValueError("Некорректная дата или время.") from error
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("Ожидается целое число миллисекунд или дата ISO 8601 с часовым поясом.")
    return value


EpochMs = Annotated[int, Field(ge=0, le=253402300799999), BeforeValidator(parse_timestamp)]


class ReadUser(ApiModel):
    id: str
    username: str
    name: str
    position: str
    department: str
    role: Literal["admin", "employee"]
    active: bool
    archived: bool
    permissions: list[str]
    createdAt: int


class ReadBreak(ApiModel):
    startedAt: int
    endedAt: int | None


class ReadShift(ApiModel):
    id: str
    userId: str
    startedAt: int
    endedAt: int | None
    note: str
    version: int
    breaks: list[ReadBreak]


class ReadSchedule(ApiModel):
    userId: str
    startTime: str
    endTime: str
    breakMinutes: int
    weekdays: list[int]
    timezone: str


class Ok(ApiModel):
    ok: bool = True


class Pagination(ApiModel):
    page: int
    pageSize: int
    total: int
    pages: int
