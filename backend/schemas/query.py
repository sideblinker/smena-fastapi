"""Typed URL/query inputs shared by JSON endpoints and Jinja2 pages."""
from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from fastapi.exceptions import RequestValidationError
from pydantic import AfterValidator, BeforeValidator, ConfigDict, Field, ValidationError, model_validator

from .common import ApiModel


def canonical_uuid(value: str) -> str:
    return str(UUID(value))


def valid_date(value: str) -> str:
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value:
        raise ValueError("Дата должна быть в формате ГГГГ-ММ-ДД.")
    return value


def valid_month(value: str) -> str:
    date.fromisoformat(value + "-01")
    return value


Identifier = Annotated[str, Field(pattern=r"^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$"), AfterValidator(canonical_uuid)]
DateString = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$"), AfterValidator(valid_date)]
MonthString = Annotated[str, Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"), AfterValidator(valid_month)]
ShiftStatus = Literal["all", "finished", "active"]
RequestStatus = Literal["all", "pending", "approved", "rejected", "cancelled"]
PageNumber = Annotated[int, Field(ge=1, le=1_000_000)]
PageSize = Annotated[int, Field(ge=1, le=100)]


class QueryModel(ApiModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class PaginationQuery(QueryModel):
    page: PageNumber = 1
    pageSize: PageSize = 20


class ShiftListQuery(PaginationQuery):
    userId: Identifier | None = None
    from_date: DateString | None = Field(default=None, alias="from")
    to: DateString | None = None
    status: ShiftStatus = "all"

    @model_validator(mode="after")
    def chronological(self):
        if self.from_date and self.to and self.from_date > self.to:
            raise ValueError("Начало периода не может быть позже окончания.")
        return self


class UserListQuery(PaginationQuery):
    search: Annotated[str, BeforeValidator(lambda value: value.strip() if isinstance(value, str) else value), Field(max_length=100)] = ""
    includeArchived: Literal["0", "1"] = "0"


class UserLookupQuery(UserListQuery):
    # The unpaged shape is retained for the old published client's selector.
    page: PageNumber | None = None


class AuditListQuery(PaginationQuery):
    pass


class DateRangeQuery(QueryModel):
    from_date: DateString = Field(alias="from")
    to: DateString

    @model_validator(mode="after")
    def bounded_period(self):
        start, end = date.fromisoformat(self.from_date), date.fromisoformat(self.to)
        if not 1 <= (end - start).days + 1 <= 366:
            raise ValueError("Выберите период от 1 до 366 дней.")
        return self


class ReportRange(DateRangeQuery):
    @model_validator(mode="after")
    def representable_next_day(self):
        if self.to == "9999-12-31":
            raise ValueError("Дата окончания отчёта должна быть раньше 9999-12-31.")
        return self


def validated_query(model, values):
    """Validate derived/defaulted ranges and keep FastAPI's safe 422 format."""
    try:
        return model.model_validate(values)
    except ValidationError as error:
        errors = [{**entry, "loc": ("query", *entry["loc"])} for entry in error.errors()]
        raise RequestValidationError(errors) from None
