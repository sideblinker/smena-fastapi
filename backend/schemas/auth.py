from pydantic import Field

from .common import ApiModel, ReadUser


class SetupCreate(ApiModel):
    password: str = Field(min_length=10, max_length=128, description="Пароль администратора; не хранится в открытом виде.")


class LoginCreate(ApiModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[a-zA-Z0-9_.-]+$")
    password: str = Field(max_length=128)


class ChangePassword(ApiModel):
    currentPassword: str = Field(max_length=128)
    newPassword: str = Field(min_length=10, max_length=128)


class ReadSession(ApiModel):
    setupRequired: bool
    adminLogin: str
    user: ReadUser | None
    csrfToken: str | None
    serverNow: int


class ReadToken(ApiModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class PasswordChanged(ApiModel):
    ok: bool = True
    reauthenticate: bool = True
