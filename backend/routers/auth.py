import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy import delete, func, select

from ..common import ADMIN_LOGIN, ADMIN_NAME, Actor, audit, fail, now_ms, public_user
from ..dependencies import CurrentActor, Db, check_origin, optional_actor
from ..models import LoginAttempt, Schedule, SessionRecord, User
from ..schemas.auth import ChangePassword, LoginCreate, PasswordChanged, ReadSession, ReadToken, SetupCreate
from ..schemas.common import Ok
from ..security import COOKIE, dummy_hash, hash_password, new_session, sha, verify_password

router = APIRouter(prefix="/api", tags=["Вход и сессии"])


def setup_allowed(request: Request) -> bool:
    expected = request.app.state.settings.setup_token
    if expected:
        supplied = request.headers.get("x-setup-token", "")
        return len(expected) >= 32 and hmac.compare_digest(expected.encode(), supplied.encode())
    return bool(request.client and request.client.host in {"127.0.0.1", "::1"}
                and request.url.hostname in {"localhost", "127.0.0.1", "::1"})


def payload(db, user, csrf, now):
    return dict(setupRequired=False, adminLogin=ADMIN_LOGIN, user=public_user(db, user), csrfToken=csrf, serverNow=now)


def set_cookie(response: Response, request: Request, raw: str):
    response.set_cookie(COOKIE, raw, httponly=True, samesite="strict", path="/",
                        secure=request.app.state.settings.secure_cookies or request.url.scheme == "https",
                        max_age=request.app.state.settings.session_seconds)


def clear_cookie(response: Response, request: Request):
    response.delete_cookie(COOKIE, httponly=True, samesite="strict", path="/",
                           secure=request.app.state.settings.secure_cookies or request.url.scheme == "https")


@router.get("/session", response_model=ReadSession, summary="Текущая сессия и состояние первого запуска")
def get_session(request: Request, db: Db, actor: Annotated[Actor | None, Depends(optional_actor)]):
    empty = db.scalar(select(User.id).limit(1)) is None
    return dict(setupRequired=empty and setup_allowed(request), adminLogin=ADMIN_LOGIN,
                user=actor.user if actor else None, csrfToken=actor.csrf if actor else None, serverNow=now_ms(request))


@router.post("/setup", status_code=201, response_model=ReadSession, summary="Создать первого администратора")
def setup(data: SetupCreate, request: Request, response: Response, db: Db):
    check_origin(request)
    if not setup_allowed(request) or db.scalar(select(User.id).limit(1)):
        fail(409, "SETUP_COMPLETE", "Первоначальная настройка уже выполнена или недоступна.")
    now = now_ms(request)
    user = User(username=ADMIN_LOGIN, name=ADMIN_NAME, password_hash=hash_password(data.password),
                position="Администратор", department="Управление", role="admin", active=1, archived=0,
                master=1, created_at=now)
    db.add(user)
    db.flush()
    db.add(Schedule(user_id=user.id))
    raw, csrf = new_session(db, user, request.app.state.settings, now)
    actor = Actor(user, public_user(db, user), csrf, sha(raw))
    audit(db, actor, "setup", "user", user.id, {}, now)
    set_cookie(response, request, raw)
    return payload(db, user, csrf, now)


def login_user(db, request: Request, username: str, password: str):
    now = now_ms(request)
    bucket, cutoff = sha(username.lower()), now - 15 * 60 * 1000
    attempts = db.scalar(select(func.count()).select_from(LoginAttempt).where(
        LoginAttempt.bucket == bucket, LoginAttempt.attempted_at > cutoff))
    if attempts >= 5:
        fail(429, "RATE_LIMIT", "Слишком много попыток входа. Попробуйте через 15 минут.")
    db.add(LoginAttempt(bucket=bucket, attempted_at=now))
    user = db.scalar(select(User).where(func.lower(User.username) == username.lower()))
    valid = verify_password(password, user.password_hash if user else dummy_hash())
    if not valid or not user or not user.active or user.archived:
        # Failed login attempts must survive the error response, otherwise a caller
        # could retry forever. This transaction contains no business mutations.
        db.commit()
        fail(401, "INVALID_CREDENTIALS", "Неверный логин или пароль, либо аккаунт отключён.")
    if user.password_hash.startswith("scrypt$"):
        user.password_hash = hash_password(password)
    db.execute(delete(LoginAttempt).where((LoginAttempt.bucket == bucket) | (LoginAttempt.attempted_at < cutoff)))
    db.execute(delete(SessionRecord).where(SessionRecord.expires_at <= now))
    raw, csrf = new_session(db, user, request.app.state.settings, now)
    return user, raw, csrf, now


@router.post("/login", response_model=ReadSession, summary="Вход из интерфейса сайта")
def login(data: LoginCreate, request: Request, response: Response, db: Db):
    check_origin(request)
    user, raw, csrf, now = login_user(db, request, data.username, data.password)
    set_cookie(response, request, raw)
    return payload(db, user, csrf, now)


@router.post("/token", response_model=ReadToken, summary="OAuth2: получить JWT для API и Swagger")
def token(request: Request, db: Db, form: Annotated[OAuth2PasswordRequestForm, Depends()]):
    check_origin(request, required=False)
    # The same validation and throttling rules apply to both login endpoints.
    try:
        credentials = LoginCreate(username=form.username, password=form.password)
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from None
    user, raw, csrf, now = login_user(db, request, credentials.username, credentials.password)
    return ReadToken(access_token=raw, expires_in=request.app.state.settings.session_seconds)


@router.post("/logout", response_model=Ok, summary="Завершить текущую сессию")
def logout(request: Request, response: Response, db: Db, actor: CurrentActor):
    db.execute(delete(SessionRecord).where(SessionRecord.token_hash == actor.token_hash))
    clear_cookie(response, request)
    return Ok()


@router.post("/change-password", response_model=PasswordChanged, summary="Сменить пароль и отозвать все сессии")
def change_password(data: ChangePassword, request: Request, response: Response, db: Db, actor: CurrentActor):
    if not verify_password(data.currentPassword, actor.row.password_hash):
        fail(403, "INVALID_PASSWORD", "Текущий пароль неверен.")
    actor.row.password_hash = hash_password(data.newPassword)
    db.execute(delete(SessionRecord).where(SessionRecord.user_id == actor.row.id))
    audit(db, actor, "password_changed", "user", actor.row.id, {}, now_ms(request))
    clear_cookie(response, request)
    return PasswordChanged()
