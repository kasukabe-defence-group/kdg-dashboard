"""Exclusive administrative read adapter; never initialize workspace/world state."""

import json
import hmac
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from app.audit import rate_limiter, record
from app.auth import AuthConfigError, AuthUser, _load_users

PREFIX = "/api/v1/mcp-readonly"
SCOPE = "mcp:read"
_ID = r"[a-z0-9][a-z0-9-]{1,40}"
_ROUTES = {
    "health": "/health", "resources": "/resources", "containers": "/containers",
    "minecraft_servers": "/minecraft/servers", "workspaces": "/workspaces",
    "drive_files": "/drive/files",
}


def find_mcp_key(authorization: str) -> dict | None:
    # Identify even disabled/expired MCP credentials before session fallback.
    from app.apikeys import _hash, _load, _lock
    if not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    if not token or len(token) > 512:
        return None
    hashed = _hash(token)
    with _lock:
        for key in _load():
            if isinstance(key, dict) and hmac.compare_digest(str(key.get("tokenHash") or ""), hashed):
                return key if SCOPE in (key.get("scopes") or []) else None
    return None


class MCPWebSocketGuard:
    """HTTP middleware cannot guard terminal/Jupyter WebSocket handshakes."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "websocket":
            values = [value.decode("latin-1") for key, value in scope.get("headers", []) if key.lower() == b"authorization"]
            if any(find_mcp_key(value) for value in values):
                record("mcp.api.read", actor="apikey", resource="restricted", action="WEBSOCKET", result="denied")
                await send({"type": "websocket.close", "code": 4403})
                return
        await self.app(scope, receive, send)


def operation(path: str) -> str | None:
    for name, suffix in _ROUTES.items():
        if path == PREFIX + suffix:
            return name
    if re.fullmatch(re.escape(PREFIX) + rf"/minecraft/servers/{_ID}/logs", path):
        return "minecraft_logs"
    return None


def principal(key: dict) -> AuthUser:
    if key.get("scopes") != [SCOPE] or key.get("enabled", True) is not True:
        raise HTTPException(403, "An exclusive mcp:read key is required")
    expiry = key.get("expiresAt")
    if expiry is not None:
        try:
            if not isinstance(expiry, str) or not expiry:
                raise ValueError("invalid expiry")
            text = expiry
            date = datetime.fromisoformat(text + "T23:59:59+00:00" if len(text) == 10 else text.replace("Z", "+00:00"))
            if date.tzinfo is None or date <= datetime.now(timezone.utc):
                raise ValueError("expired")
        except (ValueError, TypeError):
            raise HTTPException(403, "Key expiry is invalid or expired") from None
    user = _load_users().get(str(key.get("createdBy") or "").casefold())
    if not user or user.get("role") not in {"owner", "admin"}:
        raise HTTPException(403, "The key creator must be a current owner or admin")
    return AuthUser(**{field: user[field] for field in ("username", "displayName", "role")})


async def protect_mcp_key(request: Request, key: dict, call_next):
    """Called before session fallback, including public paths and cookie-plus-key requests."""
    name = operation(request.url.path)
    actor = "apikey:" + str(key.get("id") or "unknown")
    status = 500
    try:
        if request.method != "GET" or name is None:
            raise HTTPException(403, "MCP keys permit only the dedicated GET routes")
        ip = request.client.host if request.client else "unknown"
        for bucket, limit in ((f"api:ip:{ip}", 600), (f"api:key:{key.get('id')}", 300)):
            allowed, retry = rate_limiter.allow(bucket, limit=limit, window_seconds=60)
            if not allowed:
                raise HTTPException(429, "Rate limit exceeded", headers={"Retry-After": str(retry)})
        request.state.mcp_user = principal(key)
        request.state.api_key = key
        response = await call_next(request)
        status = response.status_code
        return response
    except HTTPException as exc:
        status = exc.status_code
        return JSONResponse({"detail": exc.detail}, status_code=status, headers=exc.headers)
    except AuthConfigError:
        status = 503
        return JSONResponse({"detail": "Dashboard account configuration is unavailable"}, status_code=status)
    finally:
        record("mcp.api.read", actor=actor, resource=name or "restricted", action=request.method,
               result="success" if status < 400 else "denied" if status < 500 else "error",
               detail={"status": status})


def require_mcp(request: Request) -> AuthUser:
    user = getattr(request.state, "mcp_user", None)
    if not user:
        raise HTTPException(403, "A dedicated MCP key is required; browser sessions are not accepted")
    return user


router = APIRouter(prefix="/mcp-readonly", tags=["mcp-readonly"], dependencies=[Depends(require_mcp)])


def pick(data: dict, fields: tuple[str, ...]) -> dict:
    return {key: data[key] for key in fields if key in data}


def read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        if path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("too large")
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(503, "Stored metadata is unavailable or invalid") from None


def registry() -> list[dict]:
    from app.minecraft import SERVERS_FILE
    entries = read_json(SERVERS_FILE, [])
    if not isinstance(entries, list) or len(entries) > 500 or any(
        not isinstance(item, dict) or not re.fullmatch(_ID, str(item.get("id", ""))) for item in entries
    ):
        raise HTTPException(503, "Server registry is invalid")
    return entries


def redact_logs(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    text = re.sub(r"(?i)\b(?:kdg_|gh[pousr]_)[A-Za-z0-9_-]{20,}", "[REDACTED]", text)
    text = re.sub(r"(?i)((?:password|token|secret|authorization)\s*[=:]\s*)[^\s,;]+", r"\1[REDACTED]", text)
    return text


@router.get("/health")
def health():
    return {"ok": True, "service": "kdg-api", "access": "administrative-read-only"}


@router.get("/resources")
def resources():
    from app.main import overview
    result = pick(overview(), (
        "cpuPercent", "memUsedGiB", "memTotalGiB", "swapUsedGiB", "swapTotalGiB",
        "diskUsedGiB", "diskTotalGiB", "dataDiskUsedGiB", "dataDiskTotalGiB",
        "netUpMbps", "netDownMbps", "uptimeSeconds", "gpu",
    ))
    if "gpu" in result:
        result["gpu"] = pick(result["gpu"], ("utilPercent", "vramUsedMiB", "vramTotalMiB", "tempC"))
    return result


@router.get("/containers")
def containers():
    from app.docker_readonly import DockerInventoryError, get_containers
    try:
        items = get_containers(strict=True)
    except DockerInventoryError:
        raise HTTPException(503, "Docker inventory is unavailable") from None
    return [pick(item, ("id", "name", "image", "state", "status")) for item in items[:500]]


@router.get("/minecraft/servers")
def minecraft_servers():
    from app.minecraft import _docker_status
    return [{**pick(item, ("id", "name", "type", "version", "port", "memory", "maxPlayers")),
             "runtime": pick(_docker_status(item["id"]), ("state", "running", "exists", "health"))}
            for item in registry()]


@router.get("/minecraft/servers/{sid}/logs")
def minecraft_logs(sid: str, request: Request, tail: int = Query(100, ge=1, le=500)):
    from app.minecraft import _run
    item = next((item for item in registry() if item["id"] == sid), None)
    if not item:
        raise HTTPException(404, "Managed server not found")
    try:
        result = _run(["docker", "logs", "--tail", str(tail), f"mc-{sid}"], timeout=15)
        if result.returncode:
            raise HTTPException(503, "Container logs are unavailable")
    except (OSError, subprocess.TimeoutExpired):
        raise HTTPException(503, "Container logs are unavailable") from None
    known = [str(item.get("rconPassword") or ""), request.headers.get("authorization", "").removeprefix("Bearer ")]
    known += [value for key, value in os.environ.items() if any(word in key for word in ("PASSWORD", "TOKEN", "SECRET"))]
    # Redact before truncation, so a cut cannot expose the beginning of a known secret.
    output = redact_logs((result.stdout or "") + "\n" + (result.stderr or ""), known)
    return {"logs": output[-32768:], "tail": tail, "untrustedData": True}


@router.get("/workspaces")
def workspaces():
    from app.workspaces import ROOT, _container_name, _docker_status, _load_state, _ws_dir
    items = []
    for entry in list(_load_users().values())[:500]:
        path = _ws_dir(entry)
        if not path.is_dir() or path.is_symlink() or path.resolve().parent != ROOT:
            continue
        state = _load_state(entry)  # read-only, unlike _payload/_ensure
        status = _docker_status(_container_name(entry))
        items.append({"username": entry["username"],
                      **pick(state, ("memoryMiB", "cpus", "gpu", "image")),
                      **pick(status, ("state", "running"))})
    return items


@router.get("/drive/files")
def drive_files(path: str = Query("/", max_length=1024), page: int = Query(1, ge=1, le=100000),
                limit: int = Query(50, ge=1, le=100)):
    from app.drive.nextcloud import normalize_path
    from app.drive.router import files
    result = files(path=normalize_path(path), page=page, limit=limit, sort="name", order="asc", search=None).model_dump()
    result["items"] = [pick(item, ("name", "path", "fileType", "mimeType", "sizeBytes", "modified"))
                       for item in result["items"]]
    result["access"] = "administrative-service-account-root"
    return result
