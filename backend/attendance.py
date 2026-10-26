"""Monthly attendance calculations, independent of HTTP and the database.

The application's schedule uses Kazakhstan's fixed UTC+5 offset. All hours of a
shift, including the next morning, belong to the local date on which it began.
"""
from __future__ import annotations

import calendar
import re
import time
from datetime import date

MINUTE = 60_000
DAY = 86_400_000
OFFSET = 5 * 60 * MINUTE
EPOCH_ORDINAL = date(1970, 1, 1).toordinal()


def month_bounds(month: str) -> dict[str, int]:
    if not isinstance(month, str) or not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", month):
        raise ValueError("Месяц должен быть указан в формате ГГГГ-ММ.")
    year, number = map(int, month.split("-"))
    if year < 1:
        raise ValueError("Год должен быть от 0001 до 9999.")
    first = (date(year, number, 1).toordinal() - EPOCH_ORDINAL) * DAY - OFFSET
    return {"from": first, "to": first + calendar.monthrange(year, number)[1] * DAY}


def local_date(timestamp: int) -> str:
    return date.fromordinal((timestamp + OFFSET) // DAY + EPOCH_ORDINAL).isoformat()


def clock_minutes(value: str) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value):
        raise ValueError("Время графика должно быть указано в формате ЧЧ:ММ.")
    hour, minute = map(int, value.split(":"))
    return hour * 60 + minute


def schedule_parts(schedule: dict) -> dict:
    if not schedule or not isinstance(schedule.get("weekdays"), list) or any(
        type(day) is not int or not 1 <= day <= 7 for day in schedule["weekdays"]
    ):
        raise ValueError("Дни графика должны быть числами от 1 до 7.")
    start = clock_minutes(schedule.get("startTime"))
    duration = (clock_minutes(schedule.get("endTime")) - start) % 1440
    pause = schedule.get("breakMinutes")
    if not duration or type(pause) is not int or not 0 <= pause < duration:
        raise ValueError("Плановый перерыв должен быть короче смены.")
    return {"start": start, "duration": duration, "workMs": (duration - pause) * MINUTE}


def shift_metrics(shift: dict, now: int) -> dict:
    finish = shift["endedAt"] if shift["endedAt"] is not None else now
    end = max(shift["startedAt"], min(finish, now))
    break_ms = sum(max(0, min(pause["endedAt"] if pause["endedAt"] is not None else end, end)
                       - max(pause["startedAt"], shift["startedAt"])) for pause in shift.get("breaks", []))
    ongoing = shift["endedAt"] is None or shift["endedAt"] > now
    on_break = ongoing and any(pause["startedAt"] <= now and
                               (pause["endedAt"] is None or pause["endedAt"] > now)
                               for pause in shift.get("breaks", []))
    return {"workMs": max(0, end - shift["startedAt"] - break_ms), "breakMs": break_ms,
            "ongoing": ongoing, "onBreak": on_break}


def build_attendance_month(*, month: str, schedule: dict, shifts: list | None = None,
                           absences: list | None = None, now: int | None = None,
                           created_at: int | None = None) -> list[dict]:
    now = int(time.time() * 1000) if now is None else now
    bounds = month_bounds(month)
    plan = schedule_parts(schedule)
    today = local_date(now)
    created_date = None if created_at is None else local_date(created_at)
    by_date: dict[str, list] = {}
    for shift in shifts or []:
        if shift["startedAt"] > now or not bounds["from"] <= shift["startedAt"] < bounds["to"]:
            continue
        by_date.setdefault(local_date(shift["startedAt"]), []).append(shift)
    days = []
    for day_start in range(bounds["from"], bounds["to"], DAY):
        day_date = local_date(day_start)
        weekday = date.fromisoformat(day_date).isoweekday()
        absence = next((item for item in absences or [] if item["startDate"] <= day_date <= item["endDate"]), None)
        employed = created_date is None or day_date >= created_date
        kind = "absence" if absence else "workday" if employed and weekday in schedule["weekdays"] else "day_off"
        planned_start = day_start + plan["start"] * MINUTE if kind == "workday" else None
        planned_end = None if planned_start is None else planned_start + plan["duration"] * MINUTE
        planned_ms = plan["workMs"] if kind == "workday" else 0
        daily_shifts = sorted(by_date.get(day_date, []), key=lambda shift: shift["startedAt"])
        actual = [shift_metrics(shift, now) for shift in daily_shifts]
        work_ms = sum(item["workMs"] for item in actual)
        break_ms = sum(item["breakMs"] for item in actual)
        first_start = daily_shifts[0]["startedAt"] if daily_shifts else None
        ongoing = next((item for item in actual if item["ongoing"]), None)
        last_end = None if not daily_shifts or ongoing else max(shift["endedAt"] for shift in daily_shifts)
        if ongoing:
            state = "break" if ongoing["onBreak"] else "working"
        elif daily_shifts:
            state = "finished"
        elif day_date > today or (planned_start is not None and now < planned_start):
            state = "upcoming"
        elif planned_end is not None:
            state = "missed" if now >= planned_end else "not_started"
        else:
            state = "finished"
        days.append({"date": day_date, "plannedStart": planned_start, "plannedEnd": planned_end,
                     "plannedMs": planned_ms, "workMs": work_ms, "breakMs": break_ms,
                     "lateMs": max(0, first_start - planned_start) if first_start is not None and planned_start is not None else 0,
                     "overtimeMs": max(0, work_ms - planned_ms), "kind": kind, "state": state,
                     "absence": absence, "shiftIds": [shift["id"] for shift in daily_shifts],
                     "firstStart": first_start, "lastEnd": last_end})
    return days
