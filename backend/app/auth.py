from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from app.audit import clear_login_failures, login_blocked, rate_limiter, record, record_login_failure


SESSION_COOKIE = "kdg_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
router = APIRouter(prefix="/auth", tags=["auth"])
_session_lock = threading.Lock()


def _sessions_file() -> Path:
    base = Path(os.getenv("KDG_STATE_DIR", "/home/tabahi/kdg-dev/kdg-api"))
    return base / "kdg-sessions.json"


def _token_key(token: str) -> str:
    """Store only a SHA-256 digest of the cookie token on disk."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _save_sessions() -> None:
    now = time.time()
    with _session_lock:
        payload = {
            key: {
                "expires": expires,
                "username": user.username,
                "displayName": user.displayName,
                "role": user.role,
            }
            for key, (expires, user) in list(_sessions.items())
            if expires > now
        }
    try:
        path = _sessions_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        tmp.replace(path)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        pass


def _load_sessions() -> dict[str, tuple[float, "AuthUser"]]:
    now = time.time()
    sessions: dict[str, tuple[float, "AuthUser"]] = {}
    try:
        raw = json.loads(_sessions_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return sessions
    if not isinstance(raw, dict):
        return sessions
    for key, entry in raw.items():
        try:
            expires = float(entry.get("expires", 0))
            if expires <= now:
                continue
            sessions[key] = (
                expires,
                AuthUser(
                    username=str(entry["username"]),
                    displayName=str(entry["displayName"]),
                    role=str(entry["role"]),
                ),
            )
        except (KeyError, TypeError, ValueError):
            continue
    return sessions


class AuthConfigError(Exception):
    pass


class AuthUser(BaseModel):
    username: str
    displayName: str
    role: str


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=512)


# Sessions are persisted (token digests only) so API restarts/redeploys do not
# log every open dashboard out.
_sessions: dict[str, tuple[float, AuthUser]] = _load_sessions()


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, n, r, p, salt, expected = encoded.split("$", 5)
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(password.encode("utf-8"), salt=_unb64(salt), n=int(n), r=int(r), p=int(p), dklen=len(_unb64(expected)))
        return hmac.compare_digest(digest, _unb64(expected))
    except (ValueError, TypeError, UnicodeError):
        return False


def _users_file() -> Path:
    return Path(os.getenv("KDG_AUTH_USERS_FILE", "/etc/kdg-auth-users.json"))


def _load_users() -> dict[str, dict[str, Any]]:
    path = _users_file()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AuthConfigError("Dashboard authentication is not configured.") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise AuthConfigError("Dashboard authentication configuration is invalid.") from exc
    if not isinstance(raw, list):
        raise AuthConfigError("Dashboard authentication configuration is invalid.")
    users: dict[str, dict[str, Any]] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        username = str(entry.get("username", "")).strip()
        display_name = str(entry.get("displayName", "")).strip()
        role = str(entry.get("role", "")).strip()
        password_hash = str(entry.get("passwordHash", ""))
        if username and display_name and role and password_hash:
            users[username.casefold()] = {"username": username, "displayName": display_name, "role": role, "passwordHash": password_hash}
    if not users:
        raise AuthConfigError("Dashboard authentication has no configured users.")
    return users


def authenticate(username: str, password: str) -> AuthUser | None:
    entry = _load_users().get(username.strip().casefold())
    if not entry or not verify_password(password, entry["passwordHash"]):
        return None
    return AuthUser(username=entry["username"], displayName=entry["displayName"], role=entry["role"])


def current_user(request: Request) -> AuthUser | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    key = _token_key(token)
    session = _sessions.get(key)
    if not session:
        return None
    expires_at, user = session
    if expires_at <= time.time():
        _sessions.pop(key, None)
        _save_sessions()
        return None
    return user


def require_user(request: Request) -> AuthUser:
    user = current_user(request)
    if not user:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


def _secure_cookie() -> bool:
    return os.getenv("KDG_AUTH_COOKIE_SECURE", "true").strip().lower() not in {"0", "false", "no"}


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


@router.post("/login", response_model=AuthUser)
def login(payload: LoginRequest, request: Request, response: Response):
    ip = _client_ip(request)
    uname = payload.username.strip().casefold()
    # rate limit login attempts
    allowed, retry = rate_limiter.allow(f"login:ip:{ip}", limit=30, window_seconds=600)
    if not allowed:
        record("auth.login.rate_limited", actor=payload.username, action="login", result="denied", ip=ip, detail={"retryAfter": retry})
        from fastapi import HTTPException
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")
    blocked, bretry = login_blocked(f"{ip}:{uname}")
    if blocked:
        record("auth.login.blocked", actor=payload.username, action="login", result="denied", ip=ip, detail={"retryAfter": bretry})
        from fastapi import HTTPException
        raise HTTPException(status_code=429, detail="Login temporarily blocked due to repeated failures.")

    user = authenticate(payload.username, payload.password)
    if not user:
        count = record_login_failure(f"{ip}:{uname}")
        record("auth.login.failure", actor=payload.username, action="login", result="denied", ip=ip, detail={"failures": count})
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Invalid username or password")

    clear_login_failures(f"{ip}:{uname}")
    token = secrets.token_urlsafe(32)
    _sessions[_token_key(token)] = (time.time() + SESSION_TTL_SECONDS, user)
    _save_sessions()
    response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_TTL_SECONDS, httponly=True, secure=_secure_cookie(), samesite="lax", path="/")
    record("auth.login.success", actor=user.username, resource="session", action="login", result="success", ip=ip)
    return user


@router.get("/session", response_model=AuthUser)
def session(request: Request):
    return require_user(request)


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    user = current_user(request)
    if token:
        _sessions.pop(_token_key(token), None)
        _save_sessions()
    response.delete_cookie(SESSION_COOKIE, path="/")
    if user:
        record("auth.logout", actor=user.username, resource="session", action="logout", result="success", ip=_client_ip(request))
    return {"ok": True}


@router.get("/users")
def list_users(request: Request):
    user = require_user(request)
    if user.role not in {"owner", "admin"}:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Not allowed")
    users = []
    path = _users_file()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            for entry in raw:
                if isinstance(entry, dict):
                    users.append({
                        "username": str(entry.get("username", "")),
                        "displayName": str(entry.get("displayName", "")),
                        "role": str(entry.get("role", "")),
                    })
    except Exception:
        pass
    return users
