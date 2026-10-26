"""Presentation helpers for Jinja2; every value remains HTML-escaped by Jinja."""
from datetime import date, datetime, timedelta, timezone
import json

from sqlalchemy import or_, select

from ..common import get_schedule, public_shift, public_user
from ..models import Shift

DAY = 86_400_000
HOUR = 3_600_000
ZONE = timezone(timedelta(hours=5))
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]
MONTH_NAMES = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"]
WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
REQUEST_LABELS = {"pending": "На рассмотрении", "approved": "Одобрена", "rejected": "Отклонена", "cancelled": "Отменена"}
ABSENCE_LABELS = {"vacation": "Отпуск", "day_off": "Отгул", "other": "Другое отсутствие"}
DAY_LABELS = {"upcoming": "По графику", "not_started": "Не начата", "working": "В работе", "break": "Перерыв", "finished": "Завершена", "missed": "Не отмечена"}
TEAM_LABELS = {"working": "На работе", "break": "На перерыве", "finished": "Завершили", "not_started": "Не начали", "absence": "Отсутствуют", "day_off": "Выходной"}
AUDIT_LABELS = {"setup": "Создание администратора", "user_created": "Создан сотрудник", "user_updated": "Изменён сотрудник", "user_archived": "Сотрудник отправлен в архив", "profile_updated": "Обновлён профиль", "password_changed": "Изменён пароль", "schedule_updated": "Изменён график", "shift_started": "Начата смена", "break_started": "Начат перерыв", "break_finished": "Завершён перерыв", "shift_finished": "Завершена смена", "shift_created": "Добавлена смена", "shift_updated": "Изменена смена", "shift_deleted": "Удалена смена", "report_exported": "Скачан отчёт CSV", "absence_created": "Добавлено отсутствие", "absence_deleted": "Удалено отсутствие", "absence_request_created": "Подана заявка", "absence_request_approved": "Заявка одобрена", "absence_request_rejected": "Заявка отклонена", "absence_request_cancelled": "Заявка отменена"}


def local_datetime(value):
    if isinstance(value, str):
        return datetime.fromisoformat(value).replace(tzinfo=ZONE)
    return datetime.fromtimestamp(value / 1000, ZONE)


def full_date(value):
    return "—" if value is None else local_datetime(value).strftime("%d.%m.%Y, %H:%M")


def short_date(value):
    if value is None:
        return "—"
    d = local_datetime(value)
    return f"{d.day} {MONTHS[d.month - 1]}"


def clock_time(value):
    return "—" if value is None else local_datetime(value).strftime("%H:%M")


def readable(value):
    minutes = max(0, int(value or 0)) // 60000
    return f"{minutes // 60} ч {minutes % 60:02d} мин"


def hours_number(value):
    return f"{max(0, value or 0) / HOUR:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def duration(value):
    seconds = max(0, int(value or 0)) // 1000
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}"


def month_label(value):
    year, month = map(int, value.split("-"))
    return f"{MONTH_NAMES[month - 1]} {year}"


def day_label(day):
    if day["kind"] == "absence":
        return ABSENCE_LABELS.get((day.get("absence") or {}).get("type"), "Отсутствие")
    if day["kind"] == "day_off":
        return "Выходной"
    return DAY_LABELS.get(day["state"], "Рабочий день")


def timesheet_cell(day):
    if day["workMs"] or day["shiftIds"] or day["state"] in {"working", "break"}:
        return hours_number(day["workMs"])
    if day["kind"] == "absence":
        return {"vacation": "ОТ", "day_off": "ОГ", "other": "О"}.get(day["absence"]["type"], "О")
    if day["kind"] == "day_off":
        return "В"
    return "·" if day["state"] == "upcoming" else "Н"


def interval(shift, start, end, now):
    finish = min(shift["endedAt"] if shift["endedAt"] is not None else now, now, end)
    elapsed = max(0, finish - max(shift["startedAt"], start))
    paused = sum(max(0, min(p["endedAt"] if p["endedAt"] is not None else finish, finish) - max(p["startedAt"], start)) for p in shift["breaks"])
    return {"workMs": max(0, elapsed - paused), "breakMs": paused}


def shift_metrics(shift, now):
    result = interval(shift, 0, now, now)
    result["status"] = "finished" if shift["endedAt"] is not None else "break" if any(p["endedAt"] is None for p in shift["breaks"]) else "working"
    result["label"] = {"finished": "Завершена", "break": "Перерыв", "working": "В работе"}[result["status"]]
    return result


def dashboard_context(db, user, now):
    current = local_datetime(now)
    midnight = current.replace(hour=0, minute=0, second=0, microsecond=0)
    today = int(midnight.timestamp() * 1000)
    monday = today - current.weekday() * DAY
    month = int(midnight.replace(day=1).timestamp() * 1000)
    lower = min(monday, month)
    query = select(Shift).where(Shift.user_id == user.id).order_by(Shift.started_at.desc(), Shift.id.desc())
    relevant = db.scalars(query.where(or_(Shift.started_at >= lower, Shift.ended_at >= lower, Shift.ended_at.is_(None)))).all()
    recent = db.scalars(query.limit(3)).all()
    rows = {row.id: row for row in relevant + recent}
    shifts = [public_shift(db, row) for row in sorted(rows.values(), key=lambda row: (row.started_at, row.id), reverse=True)]
    dashboard = {"user": public_user(db, user), "schedule": get_schedule(db, user.id), "shifts": shifts, "serverNow": now}
    totals = lambda start, end: {key: sum(interval(s, start, end, now)[key] for s in shifts) for key in ("workMs", "breakMs")}
    active = next((s for s in shifts if s["endedAt"] is None), None)
    events = []
    for shift in shifts:
        marks = [(shift["startedAt"], "Начало работы", "Хорошего рабочего дня!", "play"), (shift["endedAt"], "Смена завершена", "Время сохранено в базе", "check")]
        for pause in shift["breaks"]:
            marks.append((pause["startedAt"], "Начало перерыва", "Немного времени для себя", "coffee"))
            if pause["endedAt"] != shift["endedAt"]:
                marks.append((pause["endedAt"], "Снова за работу", "Перерыв завершён", "play"))
        for instant, title, description, symbol in marks:
            if instant is not None and today <= instant <= now:
                events.append({"time": instant, "title": title, "description": description, "symbol": symbol, "shift": shift})
    events.sort(key=lambda event: event["time"], reverse=True)
    shown = set()
    for event in events[:5]:
        event["actions"] = event["shift"]["id"] not in shown
        shown.add(event["shift"]["id"])
    week = [{"date": monday + i * DAY, "label": label, **totals(monday + i * DAY, monday + (i + 1) * DAY)} for i, label in enumerate(WEEKDAYS)]
    maximum = max([8 * HOUR] + [day["workMs"] for day in week])
    for day in week:
        day["height"] = max(day["workMs"] / maximum * 100, 3)
    start = dashboard["schedule"]["startTime"].split(":")
    end = dashboard["schedule"]["endTime"].split(":")
    planned = ((int(end[0]) * 60 + int(end[1]) - int(start[0]) * 60 - int(start[1])) % 1440 - dashboard["schedule"]["breakMinutes"]) * 60000
    active_metrics = shift_metrics(active, now) if active else {"workMs": 0, "breakMs": 0, "status": "idle", "label": "Не начата"}
    summary = {"today": totals(today, today + DAY), "week": totals(monday, now), "month": totals(month, now), "events": events[:5], "weekDays": week, "recent": shifts[:3], "active": active, "metrics": active_metrics, "plannedMs": planned, "progress": min(100, active_metrics["workMs"] / planned * 100) if planned > 0 else 0}
    return dashboard, summary


def audit_details(entry):
    return json.dumps(entry["details"], ensure_ascii=False, indent=2)
