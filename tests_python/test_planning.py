"""Behavioural tests for monthly calculations and leave authorization."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime

import pytest

from backend.attendance import DAY, MINUTE, build_attendance_month, local_date, month_bounds

HOUR = 60 * MINUTE
SCHEDULE = {"startTime": "09:00", "endTime": "18:00", "breakMinutes": 60,
            "weekdays": [1, 2, 3, 4, 5], "timezone": "Asia/Qyzylorda"}


def at(value):
    return int(datetime.fromisoformat(value + "+05:00").timestamp() * 1000)


def shift(identifier, start, end, breaks=None):
    return {"id": identifier, "startedAt": at(start), "endedAt": None if end is None else at(end), "breaks": breaks or []}


def pause(start, end):
    return {"startedAt": at(start), "endedAt": None if end is None else at(end)}


def build(**overrides):
    values = {"month": "2026-10", "schedule": SCHEDULE, "now": at("2026-10-16T20:00:00")}
    values.update(overrides)
    return build_attendance_month(**values)


def day(days, selected):
    return next(item for item in days if item["date"] == selected)


def test_month_boundaries_leap_years_and_strict_formats():
    assert month_bounds("2026-10") == {"from": at("2026-10-01T00:00:00"), "to": at("2026-11-01T00:00:00")}
    for month, count in [("2024-02", 29), ("2025-02", 28), ("2026-12", 31), ("9999-12", 31)]:
        bounds = month_bounds(month)
        assert (bounds["to"] - bounds["from"]) // DAY == count
    assert month_bounds("0099-01")["from"] == at("0099-01-01T00:00:00")
    for invalid in ["2026-00", "2026-13", "2026-1", "2026-10-01", "0000-01", "2026-02x", " 2026-02", "", None, 202610]:
        with pytest.raises(ValueError):
            month_bounds(invalid)


def test_regular_shift_net_work_lateness_and_aggregation_do_not_mutate_inputs():
    shifts = [shift("second", "2026-10-15T14:00:00", "2026-10-15T20:00:00",
                    [pause("2026-10-15T17:00:00", "2026-10-15T17:30:00")]),
              shift("first", "2026-10-15T08:45:00", "2026-10-15T12:00:00")]
    original = deepcopy(shifts)
    actual = day(build(shifts=shifts), "2026-10-15")
    assert actual["workMs"] == 8 * HOUR + 45 * MINUTE
    assert actual["overtimeMs"] == 45 * MINUTE
    assert actual["breakMs"] == 30 * MINUTE
    assert actual["lateMs"] == 0
    assert actual["shiftIds"] == ["first", "second"]
    assert shifts == original
    late = day(build(shifts=[shift("late", "2026-10-15T09:20:00", "2026-10-15T18:00:00",
                                  [pause("2026-10-15T13:00:00", "2026-10-15T14:00:00")])]), "2026-10-15")
    assert late["workMs"] == 7 * HOUR + 40 * MINUTE
    assert late["lateMs"] == 20 * MINUTE


def test_night_shift_and_midnight_break_are_assigned_to_start_day():
    schedule = {**SCHEDULE, "startTime": "22:00", "endTime": "06:00", "breakMinutes": 30}
    days = build(schedule=schedule, shifts=[shift("night", "2026-10-15T22:10:00", "2026-10-16T06:30:00",
                                                 [pause("2026-10-15T23:50:00", "2026-10-16T00:20:00")])])
    actual = day(days, "2026-10-15")
    assert actual["plannedEnd"] == at("2026-10-16T06:00:00")
    assert actual["workMs"] == 7 * HOUR + 50 * MINUTE
    assert actual["overtimeMs"] == 20 * MINUTE
    assert actual["lateMs"] == 10 * MINUTE
    assert day(days, "2026-10-16")["workMs"] == 0
    assert day(build(schedule=schedule, now=at("2026-10-16T02:00:00")), "2026-10-15")["state"] == "not_started"
    assert day(build(schedule=schedule, now=at("2026-10-16T06:00:00")), "2026-10-15")["state"] == "missed"


def test_ongoing_break_and_future_ends_are_clamped_to_now():
    current = shift("active", "2026-10-16T09:00:00", None, [pause("2026-10-16T12:00:00", None)])
    actual = day(build(shifts=[current], now=at("2026-10-16T13:15:00")), "2026-10-16")
    assert (actual["workMs"], actual["breakMs"], actual["state"], actual["lastEnd"]) == (3 * HOUR, 75 * MINUTE, "break", None)
    future_end = shift("future-end", "2026-10-16T09:00:00", "2026-10-16T18:00:00",
                       [pause("2026-10-16T10:00:00", "2026-10-16T11:00:00")])
    actual = day(build(shifts=[future_end], now=at("2026-10-16T10:15:00")), "2026-10-16")
    assert (actual["workMs"], actual["breakMs"], actual["state"]) == (HOUR, 15 * MINUTE, "break")


def test_cross_month_assignment_and_future_records():
    days = build(now=at("2026-11-02T10:00:00"), shifts=[
        shift("previous", "2026-09-30T22:00:00", "2026-10-01T06:00:00"),
        shift("last-night", "2026-10-31T22:00:00", "2026-11-01T06:00:00"),
        shift("next", "2026-11-01T22:00:00", "2026-11-02T06:00:00")])
    assert sum(item["workMs"] for item in days) == 8 * HOUR
    assert day(days, "2026-10-31")["shiftIds"] == ["last-night"]
    future = build(now=at("2026-10-16T08:30:00"), shifts=[shift("future", "2026-10-19T09:20:00", "2026-10-19T18:00:00")])
    for selected in ["2026-10-16", "2026-10-19", "2026-10-30"]:
        actual = day(future, selected)
        assert (actual["state"], actual["workMs"], actual["lateMs"], actual["shiftIds"]) == ("upcoming", 0, 0, [])


def test_absences_days_off_and_before_employment_keep_actual_hours_without_missed_days():
    absence = {"id": "a", "startDate": "2026-10-14", "endDate": "2026-10-16", "type": "vacation"}
    days = build(absences=[absence], shifts=[shift("actual", "2026-10-15T10:00:00", "2026-10-15T11:00:00")])
    for selected in ["2026-10-14", "2026-10-15", "2026-10-16"]:
        actual = day(days, selected)
        assert (actual["kind"], actual["plannedMs"], actual["state"]) == ("absence", 0, "finished")
    assert day(days, "2026-10-15")["overtimeMs"] == HOUR
    before = day(build(created_at=at("2026-10-15T00:15:00")), "2026-10-14")
    assert (before["kind"], before["state"], before["plannedMs"]) == ("day_off", "finished", 0)
    sunday = day(build(shifts=[shift("sunday", "2026-10-11T14:00:00", "2026-10-11T16:00:00")]), "2026-10-11")
    assert (sunday["kind"], sunday["workMs"], sunday["lateMs"]) == ("day_off", 2 * HOUR, 0)
    leap = build(month="2024-02", now=at("2024-03-01T12:00:00"))
    assert len(leap) == 29 and leap[-1]["date"] == "2024-02-29"
    assert day(leap, "2024-02-05")["kind"] == "workday"
    assert day(leap, "2024-02-04")["kind"] == "day_off"


REQUEST = {"startDate": "2026-10-27", "endDate": "2026-10-28", "type": "vacation", "note": "Моя заявка"}


def test_request_privacy_calendar_baseline_and_ownership(env):
    alice = env.employee("alice", permissions=[])
    bob = env.employee("bob", permissions=[])
    env.login("alice")
    assert env.request("GET", "/api/calendar?month=2026-10").status_code == 200
    assert env.request("GET", "/api/timesheet?month=2026-10").status_code == 403
    assert env.request("GET", "/api/calendar?userId=" + bob["id"]).status_code == 403
    assert env.request("GET", "/api/team-status").status_code == 403
    created = env.request("POST", "/api/absence-requests", json=REQUEST)
    assert created.status_code == 201, created.text
    own = created.json()["request"]
    assert own["userId"] == alice["id"] and own["status"] == "pending"
    assert own["decidedAt"] is None and own["absenceId"] is None
    assert env.request("PATCH", "/api/absence-requests/" + own["id"], json={"version": 1, "status": "approved"}).status_code == 403
    env.login("bob")
    listed = env.request("GET", "/api/absence-requests?userId=" + alice["id"]).json()
    assert listed["requests"] == [] and listed["counts"]["pending"] == 0
    assert env.request("POST", "/api/absence-requests/" + own["id"] + "/cancel", json={"version": 1}).status_code == 403
    env.admin_login()
    assert len(env.request("GET", "/api/absence-requests").json()["requests"]) == 1
    assert env.request("POST", "/api/absence-requests/" + own["id"] + "/cancel", json={"version": 1}).status_code == 403


def test_approval_reflects_in_calendar_timesheet_and_history_survives_absence_deletion(env):
    env.employee("leave_worker")
    env.login("leave_worker")
    own = env.request("POST", "/api/absence-requests", json=REQUEST).json()["request"]
    env.admin_login()
    decision = {"version": 1, "status": "approved", "decisionNote": "  Согласовано  "}
    result = env.request("PATCH", "/api/absence-requests/" + own["id"], json=decision)
    assert result.status_code == 200, result.text
    approved = result.json()["request"]
    assert approved["version"] == 2 and approved["decisionNote"] == "Согласовано"
    assert approved["decidedBy"] == {"id": env.admin["id"], "name": env.admin["name"]}
    assert env.request("PATCH", "/api/absence-requests/" + own["id"], json=decision).status_code == 409
    env.login("leave_worker")
    calendar = env.request("GET", "/api/calendar?month=2026-10").json()
    assert len(calendar["absences"]) == 1
    assert day(calendar["days"], "2026-10-27")["kind"] == "absence"
    sheet = env.request("GET", "/api/timesheet?month=2026-10").json()
    assert day(sheet["rows"][0]["days"], "2026-10-28")["plannedMs"] == 0
    assert env.request("POST", "/api/absence-requests/" + own["id"] + "/cancel", json={"version": 2}).status_code == 409
    env.admin_login()
    assert env.request("DELETE", "/api/absences/" + approved["absenceId"], json={"version": 1}).status_code == 200
    history = env.request("GET", "/api/absence-requests").json()["requests"][0]
    assert history["status"] == "approved" and history["absenceId"] is None


@pytest.mark.parametrize("invalid", [
    {"startDate": "2026-02-30"}, {"endDate": "2026-10-26"}, {"endDate": "2028-01-01"},
    {"type": "other"}, {"status": "approved"}, {"note": "x" * 2001}, {"userId": "arbitrary-user"},
])
def test_request_body_validation_rejects_invalid_dates_or_forged_fields(env, invalid):
    result = env.request("POST", "/api/absence-requests", json={**REQUEST, **invalid})
    assert result.status_code == 422, result.text
    assert env.request("GET", "/api/absence-requests").json()["counts"]["pending"] == 0


def test_rejection_cancel_and_resubmission_keep_version_and_counts(env):
    env.employee("resubmit")
    env.login("resubmit")
    first = env.request("POST", "/api/absence-requests", json=REQUEST).json()["request"]
    assert env.request("POST", "/api/absence-requests", json=REQUEST).status_code == 409
    env.admin_login()
    path = "/api/absence-requests/" + first["id"]
    assert env.request("PATCH", path, json={"version": 1, "status": "rejected", "decisionNote": "  "}).status_code == 422
    assert env.request("PATCH", path, json={"version": 2, "status": "rejected", "decisionNote": "Причина"}).status_code == 409
    assert env.request("PATCH", path, json={"version": 1, "status": "rejected", "decisionNote": "  Недостаточно сотрудников  "}).status_code == 200
    env.login("resubmit")
    second = env.request("POST", "/api/absence-requests", json=REQUEST).json()["request"]
    cancelled = env.request("POST", "/api/absence-requests/" + second["id"] + "/cancel", json={"version": 1})
    assert cancelled.json()["request"]["status"] == "cancelled"
    third = env.request("POST", "/api/absence-requests", json=REQUEST).json()["request"]
    listed = env.request("GET", "/api/absence-requests?status=pending").json()
    assert [row["id"] for row in listed["requests"]] == [third["id"]]
    assert listed["counts"] == {"pending": 1, "approved": 0, "rejected": 1, "cancelled": 1}


def test_failed_approval_rolls_back_and_disabled_employee_cannot_be_approved(env):
    employee = env.employee("blocked_leave")
    env.login("blocked_leave")
    own = env.request("POST", "/api/absence-requests", json=REQUEST).json()["request"]
    env.admin_login()
    direct = env.request("POST", "/api/absences", json={**REQUEST, "userId": employee["id"], "type": "other"}).json()["absence"]
    path = "/api/absence-requests/" + own["id"]
    assert env.request("PATCH", path, json={"version": 1, "status": "approved"}).status_code == 409
    pending = env.request("GET", "/api/absence-requests").json()["requests"][0]
    assert (pending["status"], pending["version"], pending["absenceId"]) == ("pending", 1, None)
    audit = env.request("GET", "/api/audit").json()["entries"]
    assert not [row for row in audit if row["targetId"] == own["id"] and row["action"] == "absence_request_approved"]
    env.request("DELETE", "/api/absences/" + direct["id"], json={"version": 1})
    env.request("PATCH", "/api/users/" + employee["id"], json={"active": False})
    assert env.request("PATCH", path, json={"version": 1, "status": "approved"}).status_code == 409
    assert env.request("PATCH", path, json={"version": 1, "status": "rejected", "decisionNote": "Аккаунт отключён"}).status_code == 200


def test_concurrent_approvals_and_overlapping_direct_absence_have_one_winner(env):
    employee = env.employee("race_leave")
    env.login("race_leave")
    own = env.request("POST", "/api/absence-requests", json=REQUEST).json()["request"]
    env.admin_login()
    path = "/api/absence-requests/" + own["id"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: env.request("PATCH", path, json={"version": 1, "status": "approved"}), range(2)))
    assert sorted(result.status_code for result in results) == [200, 409]
    calendar = env.request("GET", "/api/calendar?month=2026-10&userId=" + employee["id"]).json()
    assert len(calendar["absences"]) == 1
    audit = env.request("GET", "/api/audit").json()["entries"]
    assert len([row for row in audit if row["targetId"] == own["id"] and row["action"] == "absence_request_approved"]) == 1
    env.login("race_leave")
    later = {**REQUEST, "startDate": "2026-10-29", "endDate": "2026-10-30"}
    second = env.request("POST", "/api/absence-requests", json=later).json()["request"]
    env.admin_login()
    with ThreadPoolExecutor(max_workers=2) as pool:
        approve = pool.submit(env.request, "PATCH", "/api/absence-requests/" + second["id"], json={"version": 1, "status": "approved"})
        direct = pool.submit(env.request, "POST", "/api/absences", json={**later, "userId": employee["id"], "type": "other"})
        statuses = [approve.result().status_code, direct.result().status_code]
    assert 409 in statuses and sum(code < 300 for code in statuses) == 1
    calendar = env.request("GET", "/api/calendar?month=2026-10&userId=" + employee["id"]).json()
    assert len(calendar["absences"]) == 2


def test_archived_employee_night_shift_stays_in_start_month_timesheet(env):
    employee = env.employee("archived_night")
    response = env.request("POST", "/api/shifts", json={"userId": employee["id"],
        "startedAt": at("2026-09-30T22:00:00"), "endedAt": at("2026-10-01T06:00:00"), "breaks": []})
    assert response.status_code == 201, response.text
    assert env.request("DELETE", "/api/users/" + employee["id"]).status_code == 200
    september = env.request("GET", "/api/timesheet?month=2026-09&userId=all").json()
    archived = next(row for row in september["rows"] if row["user"]["id"] == employee["id"])
    assert archived["user"]["archived"] and archived["workMs"] == 8 * HOUR
    assert day(archived["days"], "2026-09-30")["workMs"] == 8 * HOUR
    october = env.request("GET", "/api/timesheet?month=2026-10&userId=all").json()
    assert not [row for row in october["rows"] if row["user"]["id"] == employee["id"]]


def test_team_prior_month_active_shift_takes_priority_over_todays_absence(env):
    employee = env.employee("long_night")
    today = local_date(env.now)
    assert env.request("POST", "/api/absences", json={"userId": employee["id"], "startDate": today,
        "endDate": today, "type": "day_off"}).status_code == 201
    response = env.request("POST", "/api/shifts", json={"userId": employee["id"],
        "startedAt": at("2026-09-30T22:00:00"), "endedAt": None,
        "breaks": [pause("2026-09-30T23:00:00", None)]})
    assert response.status_code == 201, response.text
    active_id = response.json()["shift"]["id"]
    members = env.request("GET", "/api/team-status").json()["members"]
    member = next(member for member in members if member["user"]["id"] == employee["id"])
    assert member["status"] == "break" and member["day"]["kind"] == "absence"
    assert member["activeShift"]["id"] == active_id
    assert env.request("POST", "/api/shifts/" + active_id + "/finish", json={}).status_code == 200
    members = env.request("GET", "/api/team-status").json()["members"]
    assert next(member for member in members if member["user"]["id"] == employee["id"])["status"] == "absence"
    env.request("PATCH", "/api/users/" + employee["id"], json={"active": False})
    members = env.request("GET", "/api/team-status").json()["members"]
    assert not [member for member in members if member["user"]["id"] == employee["id"]]
