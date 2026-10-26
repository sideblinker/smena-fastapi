"""ORM-модели; имена таблиц совместимы с исходной базой Смены."""
from __future__ import annotations

import time
from uuid import uuid4

from sqlalchemy import BigInteger, CheckConstraint, ForeignKey, Index, Integer, String, Text, func, text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def new_id() -> str:
    return str(uuid4())


def current_ms() -> int:
    return time.time_ns() // 1_000_000


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[str] = mapped_column(String, default="", server_default="")
    department: Mapped[str] = mapped_column(String, default="", server_default="")
    role: Mapped[str] = mapped_column(String, default="employee", server_default="employee")
    active: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    archived: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    master: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[int] = mapped_column(BigInteger, default=current_ms)
    __table_args__ = (
        CheckConstraint("role IN ('admin','employee')", name="users_role_check"),
        CheckConstraint("master = 0 OR (role = 'admin' AND active = 1 AND archived = 0)", name="users_master_check"),
        Index("users_username_unique", func.lower(username), unique=True),
    )


class UserPermission(Base):
    __tablename__ = "user_permissions"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    permission: Mapped[str] = mapped_column(String, primary_key=True)


class Schedule(Base):
    __tablename__ = "schedules"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    start_time: Mapped[str] = mapped_column(String, default="09:00", server_default="09:00")
    end_time: Mapped[str] = mapped_column(String, default="18:00", server_default="18:00")
    break_minutes: Mapped[int] = mapped_column(Integer, default=60, server_default="60")
    weekdays: Mapped[str] = mapped_column(Text, default="[1,2,3,4,5]", server_default="[1,2,3,4,5]")
    timezone: Mapped[str] = mapped_column(String, default="Asia/Qyzylorda", server_default="Asia/Qyzylorda")


class Shift(Base):
    __tablename__ = "shifts"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[int] = mapped_column(BigInteger)
    ended_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    note: Mapped[str] = mapped_column(Text, default="", server_default="")
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    revision_token: Mapped[str] = mapped_column(String, default=new_id)
    __table_args__ = (
        CheckConstraint("ended_at IS NULL OR ended_at > started_at", name="shifts_time_check"),
        Index("shifts_user_start", "user_id", "started_at"),
        Index("shifts_one_active", "user_id", unique=True, sqlite_where=text("ended_at IS NULL"), postgresql_where=text("ended_at IS NULL")),
    )


class Break(Base):
    __tablename__ = "breaks"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    shift_id: Mapped[str] = mapped_column(ForeignKey("shifts.id", ondelete="CASCADE"))
    started_at: Mapped[int] = mapped_column(BigInteger)
    ended_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    __table_args__ = (
        CheckConstraint("ended_at IS NULL OR ended_at >= started_at", name="breaks_time_check"),
        Index("breaks_shift_start", "shift_id", "started_at"),
        Index("breaks_one_active", "shift_id", unique=True, sqlite_where=text("ended_at IS NULL"), postgresql_where=text("ended_at IS NULL")),
    )


class SessionRecord(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    csrf_token: Mapped[str] = mapped_column(String)
    expires_at: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (Index("sessions_user", "user_id"),)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    bucket: Mapped[str] = mapped_column(String)
    attempted_at: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (Index("login_attempts_bucket_time", "bucket", "attempted_at"),)


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    actor_name: Mapped[str] = mapped_column(String)
    action: Mapped[str] = mapped_column(String)
    target_type: Mapped[str] = mapped_column(String)
    target_id: Mapped[str] = mapped_column(String)
    details: Mapped[str] = mapped_column(Text, default="{}", server_default="{}")
    created_at: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (Index("audit_log_time", "created_at"),)


class Absence(Base):
    __tablename__ = "absences"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    start_date: Mapped[str] = mapped_column(String)
    end_date: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)
    note: Mapped[str] = mapped_column(Text, default="", server_default="")
    created_at: Mapped[int] = mapped_column(BigInteger, default=current_ms)
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    __table_args__ = (
        CheckConstraint("type IN ('vacation','day_off','other')", name="absences_type_check"),
        CheckConstraint("end_date >= start_date", name="absences_date_check"),
        Index("absences_user_dates", "user_id", "start_date", "end_date"),
    )


class AbsenceRequest(Base):
    __tablename__ = "absence_requests"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    start_date: Mapped[str] = mapped_column(String)
    end_date: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)
    note: Mapped[str] = mapped_column(Text, default="", server_default="")
    status: Mapped[str] = mapped_column(String, default="pending", server_default="pending")
    created_at: Mapped[int] = mapped_column(BigInteger, default=current_ms)
    decided_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decision_note: Mapped[str] = mapped_column(Text, default="", server_default="")
    absence_id: Mapped[str | None] = mapped_column(ForeignKey("absences.id", ondelete="SET NULL"), nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    __table_args__ = (
        CheckConstraint("type IN ('vacation','day_off')", name="absence_requests_type_check"),
        CheckConstraint("status IN ('pending','approved','rejected','cancelled')", name="absence_requests_status_check"),
        CheckConstraint("end_date >= start_date", name="absence_requests_date_check"),
        Index("absence_requests_user_status_dates", "user_id", "status", "start_date", "end_date"),
        Index("absence_requests_status_created", "status", "created_at"),
    )
