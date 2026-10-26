"""Подключение SQLAlchemy и атомарная транзакция на один HTTP-запрос."""
from collections.abc import Generator
from pathlib import Path
import sqlite3

from fastapi import Request
from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from .models import Base


def create_database(database_url: str):
    url = make_url(database_url)
    if url.get_backend_name() != "sqlite":
        raise ValueError("Эта версия использует SQLite. Перенос на PostgreSQL требует отдельной миграции и проверки блокировок.")
    in_memory = not url.database or url.database == ":memory:"
    if not in_memory:
        path = Path(url.database).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        # SQLite backup API учитывает незавершённый WAL; исходная база не изменяется.
        backup = path.with_name(path.name + ".before-fastapi.bak")
        if path.exists() and path.stat().st_size and not backup.exists():
            with sqlite3.connect(str(path), timeout=15) as source:
                if source.execute("SELECT 1 FROM sqlite_master WHERE name='users'").fetchone():
                    with sqlite3.connect(str(backup)) as target:
                        source.backup(target)
    options = {"connect_args": {"check_same_thread": False, "timeout": 15}}
    if in_memory:
        options["poolclass"] = StaticPool
    engine = create_engine(database_url, **options)

    @event.listens_for(engine, "connect")
    def sqlite_connect(connection, _):
        connection.isolation_level = None
        connection.create_function("unicode_casefold", 1,
                                   lambda value: value.casefold() if isinstance(value, str) else value,
                                   deterministic=True)
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=15000")
        cursor.close()

    @event.listens_for(engine, "begin")
    def sqlite_begin(connection):
        # Lock before reading when a request can write: validation, state change,
        # version increment and audit are committed together even across workers.
        mode = " IMMEDIATE" if connection.get_execution_options().get("smena_write") else ""
        connection.exec_driver_sql("BEGIN" + mode)

    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine, expire_on_commit=False)


def get_db(request: Request) -> Generator[Session, None, None]:
    with request.app.state.session_factory() as db:
        write = request.method not in {"GET", "HEAD", "OPTIONS"} or request.url.path == "/api/export"
        db.connection(execution_options={"smena_write": write})
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
