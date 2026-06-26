import secrets

from fastapi import Header, HTTPException, status

from .settings import get_settings


def current_owner(
    x_api_key: str | None = Header(default=None),
    x_user_id: str = Header(default="studio"),
) -> str:
    settings = get_settings()
    if settings.api_key and not secrets.compare_digest(x_api_key or "", settings.api_key):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid API key")
    return x_user_id[:64]

