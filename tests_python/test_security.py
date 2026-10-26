"""Security boundaries, actual legacy SQLite migration and documented API."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import sqlite3
from uuid import uuid4

import jwt
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend.config import ROOT, Settings
from backend.main import create_app
from backend.models import LoginAttempt, SessionRecord, User
from backend.security import COOKIE, hash_password, verify_password


def test_cookie_csrf_origin_and_unauthenticated_requests(env):
    cookie = env.client.cookies.get(COOKIE)
    claims = jwt.decode(cookie, options={"verify_signature": False})
    assert claims["sub"] == env.admin["id"]
    assert claims["iss"] == "smena" and claims["aud"] == "smena-api"
    response = env.client.post("/api/shifts/start", json={}, headers={"Origin": "http://testserver"})
    assert response.status_code == 403 and response.json()["code"] == "CSRF"
    response = env.request("POST", "/api/shifts/start", json={}, headers={"Origin": "https://outside.example"})
    assert response.status_code == 403 and response.json()["code"] == "ORIGIN"
    response = env.client.post("/api/login", json={"username": "Adilium", "password": env.admin_password},
                               headers={"Origin": "http://testserver"})
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"] and "SameSite=strict" in response.headers["set-cookie"]
    env.client.cookies.clear()
    for path in ("/api/users", "/api/dashboard", "/api/absence-requests", "/api/audit"):
        result = env.client.get(path)
        assert result.status_code == 401 and result.headers["www-authenticate"] == "Bearer"


def test_oauth2_bearer_is_signed_revocable_and_validated(env):
    result = env.client.post("/api/token", data={"username": "Adilium", "password": env.admin_password})
    assert result.status_code == 200 and "set-cookie" not in result.headers
    raw = result.json()["access_token"]
    headers = {"Authorization": "Bearer " + raw}
    assert env.client.get("/api/users", headers=headers).status_code == 200
    assert env.client.post("/api/shifts/start", json={}, headers=headers).status_code == 201
    assert env.client.get("/api/users", headers={"Authorization": "Bearer " + raw + "broken"}).status_code == 401
    assert env.client.post("/api/logout", headers=headers).status_code == 200
    assert env.client.get("/api/users", headers=headers).status_code == 401
    wrong = env.client.post("/api/token", data={"username": "!", "password": "private-value" * 20})
    assert wrong.status_code == 422 and "private-value" not in wrong.text


def test_expired_tokens_and_password_change_revoke_all_sessions(env):
    token = env.client.cookies.get(COOKIE)
    env.now += 12 * 3600 * 1000
    assert env.client.get("/api/dashboard").status_code == 401
    env.admin_login()
    old = env.client.cookies.get(COOKIE)
    result = env.request("POST", "/api/change-password", json={"currentPassword": env.admin_password, "newPassword": "New-password123!"})
    assert result.status_code == 200 and result.json()["reauthenticate"]
    assert env.client.get("/api/users", headers={"Authorization": "Bearer " + old}).status_code == 401
    with env.factory() as db:
        assert db.scalars(select(SessionRecord).where(SessionRecord.user_id == env.admin["id"])).all() == []
    assert env.client.post("/api/login", json={"username": "Adilium", "password": "New-password123!"},
                           headers={"Origin": "http://testserver"}).status_code == 200


def test_failed_logins_are_persisted_and_rate_limit_recovers(env):
    for _ in range(5):
        result = env.request("POST", "/api/login", json={"username": "Adilium", "password": "wrong"})
        assert result.status_code == 401
    with env.factory() as db:
        assert len(db.scalars(select(LoginAttempt)).all()) == 5
    assert env.request("POST", "/api/login", json={"username": "ADILIUM", "password": env.admin_password}).status_code == 429
    env.now += 15 * 60 * 1000 + 1
    assert env.admin_login()["user"]["username"] == "Adilium"


def test_remote_setup_cannot_be_opened_by_host_header(tmp_path):
    settings = Settings(f"sqlite:///{(tmp_path / 'remote.sqlite').as_posix()}", "signing-key-" * 4)
    with TestClient(create_app(settings=settings), client=("203.0.113.10", 1234), base_url="http://localhost") as client:
        assert client.get("/api/session").json()["setupRequired"] is False
        result = client.post("/api/setup", json={"password": "AdminPassword123!"}, headers={"Origin": "http://localhost"})
        assert result.status_code == 409


def test_first_setup_is_atomic_and_requires_remote_secret(tmp_path):
    settings = Settings(f"sqlite:///{(tmp_path / 'remote.sqlite').as_posix()}", "signing-key-" * 4,
                        setup_token="setup-secret-" * 4)
    with TestClient(create_app(settings=settings)) as client:
        assert client.get("/api/session").json()["setupRequired"] is False
        headers = {"Origin": "http://testserver", "X-Setup-Token": settings.setup_token}
        assert client.get("/api/session", headers=headers).json()["setupRequired"] is True
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: client.post("/api/setup", json={"password": "AdminPassword123!"}, headers=headers), range(2)))
        assert sorted(result.status_code for result in results) == [201, 409]


def test_legacy_database_password_and_records_survive_migration(tmp_path):
    path = tmp_path / "legacy.sqlite"
    password = "Пароль-с-пробелом 123!"
    salt = "0123456789abcdef0123456789abcdef"
    key = hashlib.scrypt(password.encode(), salt=salt.encode(), n=32768, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024).hex()
    encoded = f"scrypt$32768$8$1${salt}${key}"
    user_id, shift_id = str(uuid4()), str(uuid4())
    with sqlite3.connect(path) as db:
        db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
        db.execute("INSERT INTO users(id,username,name,password_hash,role,master,created_at) VALUES(?,?,?,?,?,?,?)",
                   (user_id, "Adilium", "Адиль Кубентаев", encoded, "admin", 1, 1700000000000))
        db.execute("INSERT INTO shifts(id,user_id,started_at,ended_at,revision_token) VALUES(?,?,?,?,?)",
                   (shift_id, user_id, 1700000000000, 1700003600000, "legacy-revision"))
    settings = Settings(f"sqlite:///{path.as_posix()}", "legacy-test-secret-" * 3)
    with TestClient(create_app(settings=settings)) as client:
        assert client.get("/api/session").json()["setupRequired"] is False
        result = client.post("/api/login", json={"username": "adiliUM", "password": password}, headers={"Origin": "http://testserver"})
        assert result.status_code == 200, result.text
        records = client.get("/api/dashboard").json()["shifts"]
        assert len(records) == 1 and records[0]["id"] == shift_id
    with sqlite3.connect(path) as db:
        assert db.execute("SELECT password_hash FROM users").fetchone()[0].startswith("$bcrypt-sha256$")
    backup = path.with_name("legacy.sqlite.before-fastapi.bak")
    with sqlite3.connect(backup) as db:
        assert db.execute("SELECT password_hash FROM users").fetchone()[0] == encoded
        assert db.execute("SELECT id FROM shifts").fetchone()[0] == shift_id


def test_unicode_long_password_does_not_truncate_at_bcrypt_limit():
    prefix = "д" * 50
    encoded = hash_password(prefix + "first")
    assert verify_password(prefix + "first", encoded)
    assert not verify_password(prefix + "other", encoded)


def test_validation_body_limits_and_static_paths_do_not_leak_secrets(env):
    invalid = env.request("POST", "/api/users", json={"username": "bad!", "password": "very-private-secret", "name": ""})
    assert invalid.status_code == 422 and "very-private-secret" not in invalid.text
    for path in ("/data/smena.sqlite", "/data/jwt_secret", "/backend/config.py"):
        assert env.client.get(path).status_code == 404
    assert env.request("POST", "/api/login", content=b"x" * 102401, headers={"Content-Type": "application/json"}).status_code == 413
    assert env.client.post("/api/login", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415


def test_docs_templates_and_openapi_match_real_routes(env):
    for path in ("/", "/index.html", "/docs", "/redoc", "/css/style.css", "/js/app.js"):
        result = env.client.get(path)
        assert result.status_code == 200, (path, result.text[:200])
    assert "Смена — рабочее время команды" in env.client.get("/").text
    assert env.client.get("/api/health").json()["backend"] == "FastAPI"
    schema = env.client.get("/openapi.json").json()
    assert schema["components"]["securitySchemes"]["OAuth2PasswordBearer"]["flows"]["password"]["tokenUrl"] == "api/token"
    for path in ("/api/shifts", "/api/absence-requests", "/api/users", "/api/schedules/{user_id}"):
        assert path in schema["paths"]
    for path, methods in schema["paths"].items():
        for method, operation in methods.items():
            if method in {"get", "post", "patch", "put", "delete"}:
                assert "responses" in operation
