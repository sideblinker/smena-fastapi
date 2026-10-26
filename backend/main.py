"""Точка входа ASGI: python -m uvicorn backend.main:app."""
from contextlib import asynccontextmanager
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, OperationalError

from .common import ApiError
from .config import ROOT, Settings
from .database import create_database
from .dependencies import Db
from .models import current_ms

logger = logging.getLogger("smena")


class BodyLimitMiddleware:
    """Bound request bodies before JSON/form parsing, including chunked requests."""
    def __init__(self, app, limit=102400):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/") or scope["method"] in {"GET", "HEAD", "OPTIONS"}:
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > self.limit:
                return await JSONResponse({"error": "Слишком большой запрос.", "code": "TOO_LARGE"}, 413)(scope, receive, send)
            if not message.get("more_body", False):
                break
        headers = dict(scope["headers"])
        content_type = headers.get(b"content-type", b"").decode("latin-1").split(";", 1)[0].lower()
        allowed = {"application/x-www-form-urlencoded", "multipart/form-data"} if scope["path"] == "/api/token" else {"application/json"}
        if body and content_type not in allowed:
            return await JSONResponse({"error": "Некорректный формат запроса.", "code": "CONTENT_TYPE"}, 415)(scope, receive, send)
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        return await self.app(scope, replay, send)


def create_app(settings: Settings | None = None, clock=None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application):
        configured = settings or Settings.from_env()
        if len(configured.jwt_secret.encode()) < 32:
            raise ValueError("Секрет JWT должен содержать не менее 32 байт.")
        engine, factory = create_database(configured.database_url)
        application.state.settings = configured
        application.state.engine = engine
        application.state.session_factory = factory
        application.state.clock = clock or current_ms
        try:
            yield
        finally:
            engine.dispose()

    application = FastAPI(title="Смена — учёт рабочего времени", version="2.0.0",
                          description="Смены, перерывы, графики и согласование отсутствий. Python + FastAPI + SQLAlchemy + SQLite.",
                          lifespan=lifespan)
    application.add_middleware(BodyLimitMiddleware)

    @application.middleware("http")
    async def response_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "same-origin"
        if request.url.path.startswith("/api/") or "text/html" in response.headers.get("content-type", ""):
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(ApiError)
    async def api_error(request: Request, error: ApiError):
        headers = {"WWW-Authenticate": "Bearer"} if error.status == 401 else None
        return JSONResponse({"error": error.message, "code": error.code}, error.status, headers=headers)

    @application.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        # Pydantic's default 'input' can contain a password; never echo it back.
        details = [{"loc": entry["loc"], "msg": entry["msg"], "type": entry["type"]} for entry in error.errors()]
        message = "Проверьте поля запроса. " + (details[0]["msg"] if details else "Некорректные данные.")
        return JSONResponse({"error": message, "code": "VALIDATION", "detail": details}, 422)

    @application.exception_handler(IntegrityError)
    async def integrity_error(request: Request, error: IntegrityError):
        duplicate = "users_username_unique" in str(error.orig)
        return JSONResponse({"error": "Этот логин уже занят." if duplicate else "Данные изменились или нарушают ограничения. Обновите страницу.",
                             "code": "USERNAME_EXISTS" if duplicate else "CONFLICT"}, 409)

    @application.exception_handler(OperationalError)
    async def database_error(request: Request, error: OperationalError):
        logger.error("Database operation failed (%s)", type(error.orig).__name__)
        return JSONResponse({"error": "База данных временно недоступна. Повторите запрос.", "code": "DATABASE_UNAVAILABLE"}, 503)

    @application.exception_handler(Exception)
    async def unexpected_error(request: Request, error: Exception):
        logger.error("Request failed (%s)", type(error).__name__)
        return JSONResponse({"error": "Не удалось выполнить операцию. Попробуйте ещё раз.", "code": "INTERNAL"}, 500)

    from .routers import auth, planning, shifts, users, pages
    for module in (auth, users, shifts, planning, pages):
        application.include_router(module.router)

    @application.get("/api/health", tags=["Состояние"], summary="Проверить доступность приложения и базы")
    def health(db: Db) -> dict[str, str]:
        db.scalar(select(1))
        return {"status": "ok", "backend": "FastAPI"}

    # API routes are registered before static assets; only public/ is exposed.
    application.mount("/", StaticFiles(directory=ROOT / "public"), name="static")
    return application


app = create_app()
