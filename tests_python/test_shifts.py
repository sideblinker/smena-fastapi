"""Behavioural regression tests for the ported shift and reporting workflow."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from sqlalchemy import func, select

from backend.models import AuditLog, Break, Shift

HOUR = 3_600_000


def added_shift(env, **changes):
    values = {"startedAt": env.now - 5 * HOUR, "endedAt": env.now - HOUR, "breaks": []}
    values.update(changes)
    response = env.request("POST", "/api/shifts", json=values)
    assert response.status_code == 201, response.text
    return response.json()["shift"]


def test_clock_state_is_persisted_and_finish_closes_open_break(env):
    env.employee()
    env.login("worker")
    start = env.now
    response = env.request("POST", "/api/shifts/start", json={})
    assert response.status_code == 201, response.text
    shift_id = response.json()["shift"]["id"]
    assert env.request("POST", "/api/shifts/start", json={}).status_code == 409
    env.now += HOUR
    assert env.request("POST", f"/api/shifts/{shift_id}/pause", json={}).status_code == 200
    assert env.request("POST", f"/api/shifts/{shift_id}/pause", json={}).status_code == 409
    env.now += HOUR // 2
    assert env.request("POST", f"/api/shifts/{shift_id}/resume", json={}).status_code == 200
    assert env.request("POST", f"/api/shifts/{shift_id}/resume", json={}).status_code == 409
    env.now += HOUR // 2
    assert env.request("POST", f"/api/shifts/{shift_id}/pause", json={}).status_code == 200
    env.now += HOUR // 2
    finished = env.request("POST", f"/api/shifts/{shift_id}/finish", json={})
    assert finished.status_code == 200, finished.text
    shift = finished.json()["shift"]
    assert shift["breaks"][-1]["endedAt"] == env.now
    assert shift["startedAt"] == start
    assert env.request("POST", f"/api/shifts/{shift_id}/finish", json={}).status_code == 409
    env.login("worker")
    assert env.client.get("/api/dashboard").json()["shifts"][0] == shift
    report = env.client.get("/api/reports").json()
    assert report["totals"]["workMs"] == HOUR * 3 // 2
    assert report["totals"]["breakMs"] == HOUR
    assert report["totals"]["completedShifts"] == 1


def test_employee_can_correct_only_own_shift_without_optional_rights(env):
    employee = env.employee("editor", permissions=[])
    own = added_shift(env, userId=employee["id"], note="Исходная смена")
    foreign = added_shift(env)
    env.login("editor")
    changes = {"version": 1, "reason": "  Забыл отметить перерыв  ",
               "breaks": [{"startedAt": env.now - 3 * HOUR, "endedAt": env.now - 2 * HOUR}],
               "note": "Исправлено"}
    edited = env.request("PATCH", f'/api/shifts/{own["id"]}', json=changes)
    assert edited.status_code == 200, edited.text
    assert edited.json()["shift"]["version"] == 2
    assert edited.json()["shift"]["userId"] == employee["id"]
    assert env.request("PATCH", f'/api/shifts/{foreign["id"]}', json=changes).status_code == 403
    assert env.request("PATCH", f'/api/shifts/{own["id"]}', json={**changes, "userId": env.admin["id"]}).status_code == 422
    assert env.client.get(f'/api/dashboard?userId={env.admin["id"]}').status_code == 403
    assert env.request("POST", "/api/shifts", json={"startedAt": env.now - HOUR, "endedAt": env.now}).status_code == 403
    assert env.request("DELETE", f'/api/shifts/{own["id"]}', json={"version": 2}).status_code == 403
    env.admin_login()
    entries = env.client.get("/api/audit").json()["entries"]
    entry = next(x for x in entries if x["action"] == "shift_updated")
    assert entry["details"]["reason"] == "Забыл отметить перерыв"
    assert entry["details"]["before"] == {"startedAt": own["startedAt"], "endedAt": own["endedAt"], "breaks": [], "note": "Исходная смена"}
    assert entry["details"]["after"]["breaks"] == changes["breaks"]
    assert entry["actorName"] == employee["name"]


def test_invalid_boundaries_do_not_persist_records_and_adjacent_shifts_are_allowed(env):
    start = env.now - 10 * HOUR
    base = {"startedAt": start, "endedAt": start + 3 * HOUR, "breaks": []}
    invalid = [
        {"endedAt": start}, {"startedAt": env.now + 1, "endedAt": None},
        {"breaks": [{"startedAt": start - HOUR, "endedAt": start}]},
        {"breaks": [{"startedAt": start + HOUR, "endedAt": None}]},
        {"breaks": [{"startedAt": start + HOUR, "endedAt": start + 2 * HOUR},
                    {"startedAt": start + HOUR, "endedAt": start + 3 * HOUR}]},
        {"startedAt": True},
        {"breaks": [{"startedAt": start, "endedAt": start, "ownerId": "spoofed"}]},
    ]
    for change in invalid:
        result = env.request("POST", "/api/shifts", json={**base, **change})
        assert result.status_code == 422, result.text
    assert env.client.get("/api/dashboard").json()["shifts"] == []
    assert env.request("POST", "/api/shifts", json=base).status_code == 201
    assert env.request("POST", "/api/shifts", json={**base, "startedAt": start + 2 * HOUR, "endedAt": start + 4 * HOUR}).status_code == 409
    assert env.request("POST", "/api/shifts", json={**base, "startedAt": start + 3 * HOUR, "endedAt": start + 4 * HOUR}).status_code == 201


def test_correcting_shift_requires_a_reason_and_rejects_explicit_null(env):
    shift = added_shift(env)
    for change in ({}, {"reason": "  "}, {"reason": "ab"}, {"reason": "x" * 501},
                   {"reason": "Исправление", "startedAt": None},
                   {"reason": "Исправление", "note": None},
                   {"reason": "Исправление", "breaks": None}):
        result = env.request("PATCH", f'/api/shifts/{shift["id"]}', json={"version": 1, **change})
        assert result.status_code == 422, result.text
    assert env.client.get("/api/dashboard").json()["shifts"][0] == shift


def test_conflicting_updates_have_one_winner_and_deletion_cascades_breaks(env):
    shift = added_shift(env)
    path = f'/api/shifts/{shift["id"]}'
    def change(index):
        return env.request("PATCH", path, json={"version": 1, "reason": f"Исправление {index}", "note": str(index),
                           "breaks": [{"startedAt": env.now - (4 - index) * HOUR,
                                       "endedAt": env.now - (3 - index) * HOUR}]})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(change, (0, 1)))
    assert sorted(result.status_code for result in results) == [200, 409], [result.text for result in results]
    winner = next(result.json()["shift"] for result in results if result.status_code == 200)
    assert env.client.get("/api/dashboard").json()["shifts"][0] == winner
    assert env.request("DELETE", path, json={"version": 1}).status_code == 409
    assert env.request("DELETE", path, json={"version": 2}).status_code == 200
    with env.factory() as db:
        assert db.scalar(select(func.count()).select_from(Break)) == 0
        assert db.scalar(select(func.count()).select_from(Shift)) == 0
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "shift_updated")) == 1
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "shift_deleted")) == 1


def test_concurrent_start_has_only_one_active_shift(env):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: env.request("POST", "/api/shifts/start", json={}), range(2)))
    assert sorted(result.status_code for result in results) == [201, 409], [result.text for result in results]
    assert len(env.client.get("/api/dashboard").json()["shifts"]) == 1


def test_server_clock_rollback_cannot_put_a_finished_break_outside_shift(env):
    start = env.now
    shift = env.request("POST", "/api/shifts/start", json={}).json()["shift"]
    path = f'/api/shifts/{shift["id"]}'
    env.now = start + 2 * HOUR
    assert env.request("POST", path + "/pause", json={}).status_code == 200
    env.now = start + 3 * HOUR
    resumed = env.request("POST", path + "/resume", json={}).json()["shift"]
    env.now = start + HOUR * 5 // 2
    for action in ("pause", "finish"):
        result = env.request("POST", path + "/" + action, json={})
        assert result.status_code == 409, result.text
        assert result.json()["code"] == "CLOCK_CONFLICT"
    assert env.client.get("/api/dashboard").json()["shifts"][0] == resumed


def test_reports_split_night_shift_and_break_at_local_midnight(env):
    start = int(datetime.fromisoformat("2026-10-13T23:00:00+05:00").timestamp() * 1000)
    added_shift(env, startedAt=start, endedAt=start + 3 * HOUR,
                breaks=[{"startedAt": start + HOUR // 2, "endedAt": start + HOUR * 3 // 2}])
    report = env.client.get("/api/reports?from=2026-10-13&to=2026-10-14").json()
    assert report["days"] == [
        {"date": "2026-10-13", "workMs": HOUR // 2, "breakMs": HOUR // 2},
        {"date": "2026-10-14", "workMs": HOUR * 3 // 2, "breakMs": HOUR // 2},
    ]
    assert report["totals"]["workMs"] == 2 * HOUR
    assert report["totals"]["averageMs"] == 2 * HOUR
    assert env.client.get("/api/reports?from=2026-02-30&to=2026-03-01").status_code == 422
    assert env.client.get("/api/reports?from=2024-01-01&to=2026-01-01").status_code == 422


def test_csv_permission_formula_escaping_and_export_audit(env):
    employee = env.employee("exporter")
    env.login("exporter")
    assert env.client.get("/api/export").status_code == 403
    env.admin_login()
    changed = env.request("PATCH", f'/api/users/{employee["id"]}', json={
        "name": '=HYPERLINK("bad")', "permissions": ["export_reports"]})
    assert changed.status_code == 200, changed.text
    env.login("exporter")
    result = env.client.get("/api/export?from=2026-10-15&to=2026-10-15")
    assert result.status_code == 200, result.text
    assert result.text.startswith("\ufeff")
    assert "'=HYPERLINK" in result.text
    assert "text/csv" in result.headers["content-type"]
    assert env.client.get("/api/reports").status_code == 403
    env.admin_login()
    assert any(entry["action"] == "report_exported" for entry in env.client.get("/api/audit").json()["entries"])
