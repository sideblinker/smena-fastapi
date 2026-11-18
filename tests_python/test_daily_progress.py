import re

from sqlalchemy import insert

from backend.models import Shift


HOUR = 3_600_000


def assert_progress(env, hours, percent, timer):
    page = env.client.get("/")
    assert page.status_code == 200
    assert f'id="progress-caption">{hours} из 8 часов</span>' in page.text
    assert f'aria-valuenow="{percent}" id="shift-progress"' in page.text
    assert re.search(rf'id="timer"[^>]*>{timer}</div>', page.text)


def test_daily_progress_clips_night_work_and_survives_pause_and_finish(env):
    midnight = env.now - 12 * HOUR
    night = env.request("POST", "/api/shifts", json={
        "startedAt": midnight - 2 * HOUR, "endedAt": midnight + 5 * HOUR,
        "breaks": [{"startedAt": midnight - HOUR, "endedAt": midnight + HOUR}],
    })
    assert night.status_code == 201
    assert_progress(env, 4, 50, "00:00:00")

    second = env.request("POST", "/api/shifts/start", json={})
    assert second.status_code == 201
    path = "/api/shifts/" + second.json()["shift"]["id"]
    env.now += HOUR
    assert_progress(env, 5, 63, "01:00:00")

    assert env.request("POST", path + "/pause", json={}).status_code == 200
    env.now += HOUR
    assert_progress(env, 5, 63, "01:00:00")
    assert env.request("POST", path + "/finish", json={}).status_code == 200
    assert_progress(env, 5, 63, "00:00:00")


def test_dashboard_refresh_includes_all_todays_shifts_beyond_history_limit(env):
    # The oldest shift contributes four hours even after 2,000 shorter shifts.
    first = env.request("POST", "/api/shifts", json={"startedAt": env.now - 5 * HOUR, "endedAt": env.now - HOUR})
    assert first.status_code == 201
    first_id = first.json()["shift"]["id"]
    with env.factory() as db:
        db.execute(insert(Shift), [
            {"user_id": env.admin["id"], "started_at": env.now - 2_001_000 + i * 1000,
             "ended_at": env.now - 2_000_000 + i * 1000}
            for i in range(2000)
        ])
        db.commit()
    refreshed = env.client.get("/api/dashboard")
    assert refreshed.status_code == 200
    shifts = refreshed.json()["shifts"]
    assert len(shifts) == 2001
    assert shifts[-1]["id"] == first_id
