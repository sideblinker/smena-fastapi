from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


class Environment:
    password = "WorkerPass123!"
    admin_password = "AdminPass123!"

    def __init__(self):
        self.now = int(datetime.fromisoformat("2026-10-26T12:00:00+05:00").timestamp() * 1000)

    def request(self, method, path, json=None, **kwargs):
        headers = {"Origin": "http://testserver", "X-CSRF-Token": self.csrf}
        headers.update(kwargs.pop("headers", {}))
        return self.client.request(method, path, json=json, headers=headers, **kwargs)

    def employee(self, username="worker", permissions=None):
        body = {"username": username, "name": "Сотрудник " + username, "password": self.password}
        if permissions is not None:
            body["permissions"] = permissions
        response = self.request("POST", "/api/users", json=body)
        assert response.status_code == 201, response.text
        return response.json()["user"]

    def login(self, username, password=None):
        response = self.request("POST", "/api/login", json={"username": username, "password": password or self.password})
        assert response.status_code == 200, response.text
        self.csrf = response.json()["csrfToken"]
        return response.json()

    def admin_login(self):
        return self.login("Adilium", self.admin_password)


@pytest.fixture
def env(tmp_path):
    environment = Environment()
    settings = Settings(database_url=f"sqlite:///{(tmp_path / 'test.sqlite').as_posix()}",
                        jwt_secret="test-signing-secret-" * 3, setup_token="test-setup-token-" * 3)
    app = create_app(settings=settings, clock=lambda: environment.now)
    with TestClient(app) as client:
        environment.client = client
        environment.factory = app.state.session_factory
        response = client.post("/api/setup", json={"password": environment.admin_password},
                               headers={"Origin": "http://testserver", "X-Setup-Token": settings.setup_token})
        assert response.status_code == 201, response.text
        environment.admin = response.json()["user"]
        environment.csrf = response.json()["csrfToken"]
        yield environment
