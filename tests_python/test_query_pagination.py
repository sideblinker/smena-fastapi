"""Pagination, URL validation and privacy at the REST/SQL boundary."""
from uuid import uuid4

import pytest

from backend.models import AbsenceRequest, Shift, User

DAY = 86_400_000


def add_shifts(env, user_id, count=47):
    with env.factory.begin() as db:
        for index in range(count):
            start = env.now - (index + 1) * DAY
            db.add(Shift(id=str(uuid4()), user_id=user_id, started_at=start,
                         ended_at=start + 3_600_000, note=f"Shift {index}", version=1,
                         revision_token=str(uuid4())))


def test_shift_pages_cover_all_records_in_stable_order_and_clamp_after_delete(env):
    add_shifts(env, env.admin["id"])
    pages = [env.client.get("/api/shifts", params={"page": page, "pageSize": 20}).json() for page in (1, 2, 3)]
    assert [len(page["shifts"]) for page in pages] == [20, 20, 7]
    assert pages[0]["pagination"] == {"page": 1, "pageSize": 20, "total": 47, "pages": 3}
    identifiers = [row["id"] for page in pages for row in page["shifts"]]
    assert len(identifiers) == len(set(identifiers)) == 47
    starts = [row["startedAt"] for page in pages for row in page["shifts"]]
    assert starts == sorted(starts, reverse=True)
    assert env.client.get("/api/shifts?page=100&pageSize=20").json()["pagination"]["page"] == 3
    # A page cannot become a dead end when its last record is removed.
    with env.factory.begin() as db:
        for identifier in identifiers[40:]:
            db.delete(db.get(Shift, identifier))
    after = env.client.get("/api/shifts?page=3&pageSize=20").json()
    assert after["pagination"] == {"page": 2, "pageSize": 20, "total": 40, "pages": 2}


def test_shift_filters_apply_before_count_and_pagination(env):
    add_shifts(env, env.admin["id"])
    response = env.client.get("/api/shifts", params={"from": "2026-10-23", "to": "2026-10-25", "pageSize": 2, "status": "finished"})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["pagination"] == {"page": 1, "pageSize": 2, "total": 3, "pages": 2}
    assert len(data["shifts"]) == 2
    empty = env.client.get("/api/shifts?status=active&page=20").json()
    assert empty["shifts"] == []
    assert empty["pagination"] == {"page": 1, "pageSize": 20, "total": 0, "pages": 1}


def test_employee_pages_and_details_never_expose_another_user(env):
    worker = env.employee()
    add_shifts(env, env.admin["id"], 3)
    add_shifts(env, worker["id"], 4)
    own_id = env.client.get("/api/shifts", params={"userId": worker["id"]}).json()["shifts"][0]["id"]
    other_id = env.client.get("/api/shifts").json()["shifts"][0]["id"]
    env.login("worker")
    result = env.client.get("/api/shifts?page=2&pageSize=2").json()
    assert result["pagination"]["total"] == 4 and len(result["shifts"]) == 2
    assert all(row["userId"] == worker["id"] for row in result["shifts"])
    assert env.client.get("/api/shifts", params={"userId": env.admin["id"]}).status_code == 403
    assert env.client.get("/api/shifts/" + other_id).status_code == 403
    assert env.client.get("/api/shifts/" + own_id).status_code == 200
    assert env.client.get("/api/users?page=1").status_code == 403
    assert env.client.get("/api/audit?page=1").status_code == 403


def test_employee_search_is_unicode_case_insensitive_and_escapes_wildcards(env):
    with env.factory.begin() as db:
        for i in range(6):
            db.add(User(username=f"alpha{i}", name=f"АЛЬФА сотрудник {i}", password_hash="test-only-unused",
                        created_at=env.now, archived=int(i == 5), active=int(i != 5)))
        db.add(User(username="percent", name="Процент % и знак _", password_hash="test-only-unused", created_at=env.now))
    result = env.client.get("/api/users", params={"page": 2, "pageSize": 2, "search": "аЛьФа"})
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["pagination"] == {"page": 2, "pageSize": 2, "total": 5, "pages": 3}
    assert len(data["users"]) == 2 and all("АЛЬФА" in row["name"] for row in data["users"])
    assert env.client.get("/api/users", params={"page": 1, "search": "альфа", "includeArchived": "1"}).json()["pagination"]["total"] == 6
    for text in ("%", "_"):
        assert env.client.get("/api/users", params={"page": 1, "search": text}).json()["pagination"]["total"] == 1
    # The existing selector still receives the unpaged legacy response.
    assert len(env.client.get("/api/users?includeArchived=1").json()["users"]) == 8


@pytest.mark.parametrize("path", [
    "/api/shifts?page=0", "/api/shifts?page=abc", "/api/shifts?pageSize=101", "/api/shifts?pageSize=0",
    "/api/shifts?status=unknown", "/api/shifts?userId=not-a-uuid", "/api/shifts?from=2026-02-30",
    "/api/shifts?from=2026-10-26&to=2026-10-25", "/api/users?page=-1", "/api/users?includeArchived=yes",
    "/api/users?page=1&search=" + "x" * 101, "/api/audit?pageSize=101", "/api/audit?page=0",
    "/api/calendar?month=2026-13", "/api/calendar?month=0000-01", "/api/calendar?userId=wrong",
    "/api/timesheet?userId=wrong", "/api/timesheet?month=2026-1", "/api/absence-requests?status=wrong",
    "/api/absence-requests?pageSize=101", "/api/absences?from=2026-02-30", "/api/absences?from=2026-10-30&to=2026-10-01",
    "/api/reports?from=2026-02-30", "/api/reports?from=2024-01-01&to=2026-01-01",
    "/api/reports?from=2026-11-01", "/api/export?to=9999-12-31", "/api/export?userId=wrong",
    "/api/dashboard?userId=wrong", "/api/users/not-an-id", "/api/shifts/not-an-id", "/api/schedules/not-an-id",
])
def test_invalid_query_and_path_values_return_documented_422(env, path):
    response = env.client.get(path)
    assert response.status_code == 422, response.text
    data = response.json()
    assert data["code"] == "VALIDATION" and data["detail"]
    assert data["detail"][0]["loc"][0] in ("query", "path")


def test_invalid_body_owner_is_validated_and_uuid_case_is_canonical(env):
    assert env.request("POST", "/api/shifts/start", json={"userId": "wrong"}).status_code == 422
    assert env.request("POST", "/api/shifts", json={"userId": "wrong", "startedAt": env.now - 10000}).status_code == 422
    assert env.request("POST", "/api/absences", json={"userId": "-" * 36, "startDate": "2026-11-01", "endDate": "2026-11-01", "type": "day_off"}).status_code == 422
    result = env.client.get("/api/users/" + env.admin["id"].upper())
    assert result.status_code == 200 and result.json()["user"]["id"] == env.admin["id"]


@pytest.mark.parametrize("day", ["0001-01-01", "9999-12-30"])
def test_valid_report_dates_are_not_limited_by_windows_timestamp(env, day):
    response = env.client.get("/api/reports", params={"from": day, "to": day})
    assert response.status_code == 200, response.text
    assert response.json()["days"] == [{"date": day, "workMs": 0, "breakMs": 0}]


def test_request_pagination_keeps_unfiltered_counts_and_owner_scope(env):
    worker = env.employee()
    with env.factory.begin() as db:
        for i in range(7):
            db.add(AbsenceRequest(user_id=worker["id"], start_date=f"2026-11-{i+1:02}", end_date=f"2026-11-{i+1:02}",
                                 type="day_off", status="pending" if i < 5 else "cancelled", created_at=env.now + i))
        db.add(AbsenceRequest(user_id=env.admin["id"], start_date="2026-11-20", end_date="2026-11-20", type="day_off", created_at=env.now))
    env.login("worker")
    result = env.client.get("/api/absence-requests?page=2&pageSize=2&status=pending")
    assert result.status_code == 200, result.text
    data = result.json()
    assert data["pagination"] == {"page": 2, "pageSize": 2, "total": 5, "pages": 3}
    assert data["counts"]["pending"] == 5 and data["counts"]["cancelled"] == 2
    assert all(row["userId"] == worker["id"] and row["status"] == "pending" for row in data["requests"])


def test_audit_pages_and_openapi_query_constraints(env):
    env.employee()
    data = env.client.get("/api/audit?page=1&pageSize=1").json()
    assert len(data["entries"]) == 1 and data["pagination"]["total"] >= 2
    schema = env.client.get("/openapi.json").json()
    parameters = {entry["name"]: entry for entry in schema["paths"]["/api/shifts"]["get"]["parameters"]}
    assert parameters["page"]["schema"]["minimum"] == 1
    assert parameters["pageSize"]["schema"]["maximum"] == 100
    assert parameters["status"]["schema"]["enum"] == ["all", "finished", "active"]
