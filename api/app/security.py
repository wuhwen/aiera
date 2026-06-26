import secrets
import hashlib
import os

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .database import get_db
from .models import User
from .settings import get_settings


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return f"pbkdf2_sha256${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, salt_hex, digest_hex = stored.split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    expected = hash_password(password, bytes.fromhex(salt_hex)).split("$", 2)[2]
    return secrets.compare_digest(expected, digest_hex)


def issue_session_token() -> str:
    return secrets.token_urlsafe(32)


def bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token


def current_user(
    authorization: str | None = Header(default=None),
    x_session_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    token = x_session_token or bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")
    user = db.scalar(select(User).where(User.session_token == token))
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid session")
    return user


def current_owner(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None),
    x_session_token: str | None = Header(default=None),
    x_user_id: str = Header(default="studio"),
    db: Session = Depends(get_db),
) -> str:
    settings = get_settings()
    if settings.api_key and not secrets.compare_digest(x_api_key or "", settings.api_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid API key")
    token = x_session_token or bearer_token(authorization)
    if token:
        user = db.scalar(select(User).where(User.session_token == token))
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid session")
        return user.id
    return x_user_id[:64]
