"""Account administration preserves ownership, credentials and the master user."""

from sqlalchemy import select

from backend.models import SessionRecord, User


def test_protected_master_and_case_insensitive_unique_logins(env):
    master_id = env.admin["id"]
    for change in ({"username": "renamed"}, {"name": "Other"}, {"active": False},
                   {"archived": True}, {"permissions": []}):
        assert env.request("PATCH", f"/api/users/{master_id}", json=change).status_code == 403
    assert env.request("DELETE", f"/api/users/{master_id}").status_code == 403
    duplicate = env.request("POST", "/api/users", json={"username": "ADILIUM", "name": "Duplicate", "password": env.password})
    assert duplicate.status_code == 409, duplicate.text
    unchanged = env.client.get("/api/session").json()["user"]
    assert unchanged["username"] == "Adilium"
    assert unchanged["name"] == "Адиль Кубентаев"
    assert unchanged["active"] is True


def test_employee_cannot_assign_rights_and_admin_changes_are_immediate(env):
    worker = env.employee()
    env.login("worker")
    assert env.client.get("/api/users").status_code == 403
    assert env.request("PATCH", f'/api/users/{worker["id"]}', json={"permissions": ["edit_own_shifts"]}).status_code == 403
    assert env.request("PATCH", "/api/profile", json={"role": "admin"}).status_code == 422
    assert env.request("PATCH", "/api/profile", json={"name": " Исправлено "}).json()["user"]["name"] == "Исправлено"
    env.admin_login()
    changed = env.request("PATCH", f'/api/users/{worker["id"]}', json={"permissions": [], "department": "IT"})
    assert changed.status_code == 200, changed.text
    assert changed.json()["user"]["permissions"] == []
    env.login("worker")
    assert env.request("POST", "/api/shifts/start", json={}).status_code == 403
    assert env.request("PATCH", "/api/profile", json={"name": "Forbidden"}).status_code == 403


def test_archive_preserves_history_and_reset_revokes_sessions(env):
    worker = env.employee()
    created = env.request("POST", "/api/shifts", json={"userId": worker["id"],
                          "startedAt": env.now - 7200000, "endedAt": env.now - 3600000})
    assert created.status_code == 201, created.text
    env.login("worker")
    env.admin_login()
    reset = env.request("PATCH", f'/api/users/{worker["id"]}', json={"password": "Replacement-password-2!"})
    assert reset.status_code == 200, reset.text
    with env.factory() as db:
        assert db.scalars(select(SessionRecord).where(SessionRecord.user_id == worker["id"])).all() == []
        original_hash = db.get(User, worker["id"]).password_hash
    changed = env.request("PATCH", f'/api/users/{worker["id"]}', json={"active": False, "name": "Исправленное имя"})
    assert changed.status_code == 200
    edited = env.request("PATCH", f'/api/users/{worker["id"]}', json={"position": "Разработчик"}).json()["user"]
    assert edited["active"] is False
    assert edited["name"] == "Исправленное имя"
    with env.factory() as db:
        assert db.get(User, worker["id"]).password_hash == original_hash
    assert env.request("DELETE", f'/api/users/{worker["id"]}').status_code == 200
    assert env.client.get(f'/api/dashboard?userId={worker["id"]}').json()["shifts"] == [created.json()["shift"]]
    assert worker["id"] not in [u["id"] for u in env.client.get("/api/users").json()["users"]]
    assert worker["id"] in [u["id"] for u in env.client.get("/api/users?includeArchived=1").json()["users"]]


def test_user_validation_rejects_null_unknown_permissions_and_coerced_booleans(env):
    worker = env.employee()
    for change in ({"active": "false"}, {"archived": 1}, {"username": None}, {"name": "  "},
                   {"password": None}, {"permissions": None}, {"permissions": ["admin"]}, {"role": "admin"}):
        result = env.request("PATCH", f'/api/users/{worker["id"]}', json=change)
        assert result.status_code == 422, result.text


def test_schedule_validates_overnight_duration_and_admin_only_write(env):
    worker = env.employee()
    path = f'/api/schedules/{worker["id"]}'
    values = {"startTime": "22:00", "endTime": "06:00", "breakMinutes": 60,
              "weekdays": [5, 1, 1], "timezone": "Asia/Qyzylorda"}
    for change in ({"endTime": "22:00"}, {"breakMinutes": 480}, {"weekdays": [True]},
                   {"weekdays": [8]}, {"startTime": "24:00"}, {"timezone": "UTC"}):
        assert env.request("PUT", path, json={**values, **change}).status_code == 422
    result = env.request("PUT", path, json=values)
    assert result.status_code == 200, result.text
    assert result.json()["schedule"]["weekdays"] == [1, 5]
    env.login("worker")
    assert env.client.get(path).json()["schedule"]["endTime"] == "06:00"
    assert env.request("PUT", path, json=values).status_code == 403
    assert env.client.get(f'/api/schedules/{env.admin["id"]}').status_code == 403
