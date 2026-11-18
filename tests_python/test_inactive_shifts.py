from concurrent.futures import ThreadPoolExecutor

import pytest

from backend.models import User


HOUR = 3_600_000


@pytest.mark.parametrize(("method", "change"), [
    ("PATCH", {"active": False, "department": "Другой отдел"}),
    ("PATCH", {"archived": True}),
    ("DELETE", None),
])
def test_disable_requires_finishing_open_shift(env, method, change):
    worker = env.employee()
    profile = f'/api/users/{worker["id"]}'
    start = env.now
    shift = env.request("POST", "/api/shifts/start", json={"userId": worker["id"]}).json()["shift"]
    path = f'/api/shifts/{shift["id"]}'
    env.now += HOUR
    assert env.request("POST", path + "/pause", json={}).status_code == 200

    refused = env.request(method, profile, json=change)
    assert refused.status_code == 409
    assert refused.json()["code"] == "ACTIVE_SHIFT"
    assert "завершите" in refused.json()["error"]
    assert env.client.get(profile).json()["user"] == worker

    env.now += HOUR // 2
    result = env.request("POST", path + "/finish", json={})
    assert result.status_code == 200
    assert result.json()["shift"]["breaks"] == [{"startedAt": start + HOUR, "endedAt": env.now}]
    assert env.request(method, profile, json=change).status_code == 200
    assert env.client.get(profile).json()["user"]["active"] is False
    env.now += 2 * HOUR
    totals = env.client.get("/api/reports", params={"userId": worker["id"]}).json()["totals"]
    assert totals["workMs"] == HOUR
    assert totals["breakMs"] == HOUR // 2


@pytest.mark.parametrize("archived", [False, True])
def test_admin_can_finish_legacy_inactive_shift_and_correct_history(env, archived):
    worker = env.employee()
    start = env.now
    shift = env.request("POST", "/api/shifts/start", json={"userId": worker["id"]}).json()["shift"]
    path = f'/api/shifts/{shift["id"]}'
    # Versions before the open-shift check could leave this combination in SQLite.
    with env.factory() as db:
        user = db.get(User, worker["id"])
        user.active, user.archived = 0, int(archived)
        db.commit()
    env.now += 3 * HOUR
    assert env.request("POST", path + "/pause", json={}).status_code == 409
    if archived:
        closed = env.request("PATCH", path, json={"version": shift["version"], "reason": "Уточнили время",
                                                  "endedAt": start + HOUR})
        assert closed.json()["shift"]["endedAt"] == start + HOUR
    else:
        closed = env.request("POST", path + "/finish", json={})
        assert closed.json()["shift"]["endedAt"] == env.now
    assert closed.status_code == 200
    version = closed.json()["shift"]["version"]
    reopened = env.request("PATCH", path, json={"version": version, "endedAt": None, "reason": "Повторное открытие"})
    assert reopened.status_code == 409 and reopened.json()["code"] == "INACTIVE_USER"
    for endpoint, values in [("/api/shifts/start", {}), ("/api/shifts", {"startedAt": env.now})]:
        response = env.request("POST", endpoint, json={"userId": worker["id"], **values})
        assert response.status_code == 409 and response.json()["code"] == "INACTIVE_USER"
    corrected = env.request("PATCH", path, json={"version": version, "endedAt": start + HOUR // 2,
                                                 "reason": "Проверен табель"})
    assert corrected.status_code == 200
    historical = env.request("POST", "/api/shifts", json={"userId": worker["id"],
                             "startedAt": start - HOUR, "endedAt": start})
    assert historical.status_code == 201


def test_concurrent_archive_and_start_keep_worker_and_shift_consistent(env):
    worker = env.employee()
    profile = f'/api/users/{worker["id"]}'
    with ThreadPoolExecutor(max_workers=2) as pool:
        archive = pool.submit(env.request, "DELETE", profile)
        start = pool.submit(env.request, "POST", "/api/shifts/start", json={"userId": worker["id"]})
        outcome = (archive.result().status_code, start.result().status_code)
    assert outcome in {(200, 409), (409, 201)}
    state = env.client.get("/api/dashboard", params={"userId": worker["id"]}).json()
    assert state["user"]["archived"] == (outcome[0] == 200)
    assert bool(state["shifts"]) == (outcome[1] == 201)
