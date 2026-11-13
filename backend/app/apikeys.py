from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/apikeys", tags=["apikeys"])
_lock = threading.Lock()


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    scopes: list[str] = Field(default_factory=lambda: ["read"])
    expiresAt: str | None = None  # ISO date or null


class ApiKeyPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    enabled: bool | None = None
    scopes: list[str] | None = None


def _file() -> Path:
    return Path(os.getenv("KDG_API_KEYS_FILE", "/home/tabahi/kdg-dev/kdg-api/kdg-api-keys.json"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _load() -> list[dict[str, Any]]:
    path = _file()
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, list) else []
    except Exception:
        return []


def _save(items: list[dict[str, Any]]) -> None:
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _public(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry.get("id"),
        "name": entry.get("name"),
        "prefix": entry.get("prefix"),
        "scopes": entry.get("scopes", []),
        "enabled": bool(entry.get("enabled", True)),
        "createdAt": entry.get("createdAt"),
        "createdBy": entry.get("createdBy"),
        "lastUsedAt": entry.get("lastUsedAt"),
        "usageCount": int(entry.get("usageCount") or 0),
        "expiresAt": entry.get("expiresAt"),
    }


def _require_manager(request: Request):
    from app.auth import current_user
    user = current_user(request)
    if not user or user.role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="Not allowed")
    return user


def authenticate_bearer(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    h = _hash(token)
    with _lock:
        items = _load()
        for entry in items:
            if entry.get("tokenHash") != h:
                continue
            if not entry.get("enabled", True):
                return None
            exp = entry.get("expiresAt")
            if exp:
                try:
                    # accept date or iso
                    if len(str(exp)) == 10:
                        exp_dt = datetime.fromisoformat(str(exp) + "T23:59:59+00:00")
                    else:
                        exp_dt = datetime.fromisoformat(str(exp).replace("Z", "+00:00"))
                    if exp_dt < datetime.now(timezone.utc):
                        return None
                except Exception:
                    pass
            entry["usageCount"] = int(entry.get("usageCount") or 0) + 1
            entry["lastUsedAt"] = _now_iso()
            _save(items)
            return entry
    return None


def disable_key(key_id: str, reason: str = "") -> bool:
    with _lock:
        items = _load()
        for entry in items:
            if entry.get("id") == key_id:
                if not entry.get("enabled", True):
                    return False
                entry["enabled"] = False
                entry["disabledReason"] = reason or "auto-disabled"
                entry["disabledAt"] = _now_iso()
                _save(items)
                return True
    return False


@router.get("")
def list_keys(request: Request):
    _require_manager(request)
    with _lock:
        return [_public(e) for e in _load()]


@router.post("")
def create_key(payload: ApiKeyCreate, request: Request):
    user = _require_manager(request)
    scopes = [s for s in (payload.scopes or ["read"]) if isinstance(s, str) and s.strip()]
    scopes = scopes or ["read"]
    token = "kdg_" + secrets.token_urlsafe(32)
    entry = {
        "id": secrets.token_hex(8),
        "name": payload.name.strip(),
        "tokenHash": _hash(token),
        "prefix": token[:12],
        "scopes": scopes,
        "enabled": True,
        "createdAt": _now_iso(),
        "createdBy": user.username,
        "lastUsedAt": None,
        "usageCount": 0,
        "expiresAt": payload.expiresAt,
    }
    with _lock:
        items = _load()
        items.insert(0, entry)
        _save(items)
    out = _public(entry)
    out["token"] = token  # shown once
    return out


@router.patch("/{key_id}")
def update_key(key_id: str, payload: ApiKeyPatch, request: Request):
    _require_manager(request)
    with _lock:
        items = _load()
        for entry in items:
            if entry.get("id") == key_id:
                if payload.name is not None:
                    entry["name"] = payload.name.strip()
                if payload.enabled is not None:
                    entry["enabled"] = bool(payload.enabled)
                if payload.scopes is not None:
                    scopes = [s for s in payload.scopes if isinstance(s, str) and s.strip()]
                    entry["scopes"] = scopes or entry.get("scopes") or ["read"]
                _save(items)
                return _public(entry)
    raise HTTPException(status_code=404, detail="API key not found")


@router.delete("/{key_id}")
def delete_key(key_id: str, request: Request):
    _require_manager(request)
    with _lock:
        items = _load()
        new_items = [e for e in items if e.get("id") != key_id]
        if len(new_items) == len(items):
            raise HTTPException(status_code=404, detail="API key not found")
        _save(new_items)
    return {"ok": True, "id": key_id}
