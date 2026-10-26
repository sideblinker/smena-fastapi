"""JWT-сессии и хеширование; поддержка паролей прежней Node.js-версии."""
from functools import lru_cache
import hashlib
import hmac
import secrets
from uuid import uuid4

import jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from .common import Actor, public_user
from .config import Settings
from .models import SessionRecord, User

COOKIE = "smena_session"
password_context = CryptContext(schemes=["bcrypt_sha256"], bcrypt_sha256__rounds=12)


def sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def hash_password(password: str) -> str:
    # SHA-256 preprocessing avoids bcrypt's silent 72-byte password truncation.
    return password_context.hash(password)


@lru_cache(maxsize=1)
def dummy_hash() -> str:
    return hash_password(secrets.token_urlsafe(32))


def verify_password(password: str, encoded: str) -> bool:
    if not isinstance(password, str) or len(password) > 128:
        return False
    if encoded.startswith("scrypt$"):
        parts = encoded.split("$")
        if len(parts) != 6 or parts[1] not in {"16384", "32768"} or parts[2:4] != ["8", "1"]:
            return False
        try:
            # Node used the hexadecimal salt as text, not decoded binary.
            key = hashlib.scrypt(password.encode(), salt=parts[4].encode(), n=int(parts[1]),
                                 r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
            return hmac.compare_digest(key, bytes.fromhex(parts[5]))
        except (ValueError, TypeError):
            return False
    try:
        return password_context.verify(password, encoded)
    except (ValueError, TypeError):
        return False


def new_session(db: Session, user: User, settings: Settings, now: int):
    raw = jwt.encode({"sub": user.id, "jti": str(uuid4()), "iat": now // 1000,
                      "exp": now // 1000 + settings.session_seconds, "iss": "smena", "aud": "smena-api"},
                     settings.jwt_secret, algorithm="HS256")
    csrf = secrets.token_urlsafe(32)
    db.add(SessionRecord(token_hash=sha(raw), user_id=user.id, csrf_token=csrf,
                         expires_at=now + settings.session_seconds * 1000, created_at=now))
    return raw, csrf


def authenticate(db: Session, raw: str | None, settings: Settings, now: int, bearer=False) -> Actor | None:
    if not raw or len(raw) > 4096:
        return None
    try:
        claims = jwt.decode(raw, settings.jwt_secret, algorithms=["HS256"], issuer="smena", audience="smena-api",
                            options={"require": ["sub", "exp", "iat", "jti", "iss", "aud"],
                                     "verify_exp": False, "verify_iat": False, "verify_nbf": False})
        if not isinstance(claims["exp"], int) or not isinstance(claims["iat"], int):
            return None
        if claims["exp"] <= now // 1000 or claims["iat"] > now // 1000 + 30:
            return None
    except (jwt.PyJWTError, TypeError, ValueError):
        return None
    row = db.get(SessionRecord, sha(raw))
    if row is None or row.user_id != claims["sub"] or row.expires_at <= now:
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.active or user.archived:
        return None
    return Actor(user, public_user(db, user), row.csrf_token, row.token_hash, bearer)
