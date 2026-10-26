"""Настройки окружения; секреты никогда не входят в исходный код."""
from dataclasses import dataclass
from pathlib import Path
import os
import secrets

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    database_url: str
    jwt_secret: str
    setup_token: str = ""
    secure_cookies: bool = False
    session_seconds: int = 12 * 60 * 60

    @classmethod
    def from_env(cls):
        data = ROOT / "data"
        data.mkdir(exist_ok=True)
        secret = os.getenv("SMENA_JWT_SECRET", "")
        if not secret:
            path = data / "jwt_secret"
            try:
                with path.open("x", encoding="utf-8") as output:
                    output.write(secrets.token_urlsafe(48))
                path.chmod(0o600)
            except FileExistsError:
                pass
            secret = path.read_text(encoding="utf-8").strip()
        if len(secret.encode()) < 32:
            raise ValueError("SMENA_JWT_SECRET должен содержать не менее 32 байт.")
        return cls(
            database_url=os.getenv("SMENA_DATABASE_URL", f"sqlite:///{(data / 'smena.sqlite').as_posix()}"),
            jwt_secret=secret,
            setup_token=os.getenv("SMENA_SETUP_TOKEN", ""),
            secure_cookies=os.getenv("SMENA_SECURE_COOKIES", "").lower() in {"1", "true", "yes"},
        )
