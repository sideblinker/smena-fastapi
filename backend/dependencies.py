import hmac
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from .common import Actor, fail, now_ms
from .database import get_db
from .security import COOKIE, authenticate

Db = Annotated[Session, Depends(get_db, scope="function")]
oauth2 = OAuth2PasswordBearer(tokenUrl="api/token", auto_error=False)


def check_origin(request: Request, required: bool = True):
    origin = request.headers.get("origin")
    expected = f"{request.url.scheme}://{request.url.netloc}"
    if (required or origin) and origin != expected:
        fail(403, "ORIGIN", "Запрос отклонён: источник не совпадает с адресом сайта.")


def optional_actor(request: Request, db: Db, bearer: Annotated[str | None, Depends(oauth2)] = None):
    # An explicitly supplied invalid Authorization header never falls back to a cookie.
    header_present = bool(request.headers.get("authorization"))
    raw = bearer if header_present else request.cookies.get(COOKIE)
    return authenticate(db, raw, request.app.state.settings, now_ms(request), header_present)


def require_actor(request: Request, actor: Annotated[Actor | None, Depends(optional_actor)]):
    if actor is None:
        fail(401, "UNAUTHENTICATED", "Войдите в аккаунт.")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and not actor.bearer:
        check_origin(request)
        supplied = request.headers.get("x-csrf-token", "")
        if not hmac.compare_digest(supplied.encode(), actor.csrf.encode()):
            fail(403, "CSRF", "Защитный токен устарел. Обновите страницу.")
    return actor


CurrentActor = Annotated[Actor, Depends(require_actor)]
