from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.auth import require_user
from app.audit import record

router = APIRouter(prefix="/minecraft", tags=["minecraft"])

ROOT = Path(os.getenv("KDG_MINECRAFT_ROOT", "/home/tabahi/kdg-dev/minecraft")).resolve()
SERVERS_FILE = ROOT / "servers.json"
DATA_DIR = ROOT / "data"
_lock = threading.Lock()
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
_ALLOWED_TYPES = {"VANILLA", "PAPER", "SPIGOT", "PURPUR", "FABRIC", "FORGE", "NEOFORGE", "QUILT", "BUKKIT", "PAPERMC"}
_ALLOWED_DIFFICULTY = {"peaceful", "easy", "normal", "hard"}
_ALLOWED_GAMEMODE = {"survival", "creative", "adventure", "spectator"}
_MEM_RE = re.compile(r"^[1-9][0-9]{0,3}[MG]$")


def _ensure():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SERVERS_FILE.exists():
        SERVERS_FILE.write_text("[]", encoding="utf-8")


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _load() -> list[dict[str, Any]]:
    _ensure()
    try:
        data = json.loads(SERVERS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save(servers: list[dict[str, Any]]):
    _ensure()
    tmp = SERVERS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(servers, indent=2), encoding="utf-8")
    tmp.replace(SERVERS_FILE)


def _find(servers: list[dict[str, Any]], sid: str) -> dict[str, Any] | None:
    for s in servers:
        if s.get("id") == sid:
            return s
    return None


def _run(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _container_name(sid: str) -> str:
    return f"mc-{sid}"


def _docker_status(sid: str) -> dict[str, Any]:
    name = _container_name(sid)
    try:
        r = _run(["docker", "inspect", name, "--format", "{{json .}}"], timeout=10)
        if r.returncode != 0:
            return {"exists": False, "state": "not_created", "status": "Not created", "running": False}
        info = json.loads(r.stdout.strip() or "{}")
        state = info.get("State", {}) or {}
        running = bool(state.get("Running"))
        ports = info.get("NetworkSettings", {}).get("Ports") or {}
        mapped: list[str] = []
        for k, v in ports.items():
            if v:
                for b in v:
                    mapped.append(f"{b.get('HostPort')}->{k}")
        return {
            "exists": True,
            "state": "running" if running else "stopped",
            "status": state.get("Status") or ("running" if running else "stopped"),
            "health": (state.get("Health") or {}).get("Status"),
            "running": running,
            "ports": mapped,
            "startedAt": state.get("StartedAt"),
            "containerId": (info.get("Id") or "")[:12],
        }
    except Exception:
        return {"exists": False, "state": "unknown", "status": "Unknown", "running": False}


class CreateServer(BaseModel):
    name: str = Field(min_length=2, max_length=32)
    type: str = Field(default="PAPER")
    version: str = Field(default="LATEST")
    memory: str = Field(default="2G")
    port: int = Field(default=25565, ge=1024, le=65535)
    maxPlayers: int = Field(default=20, ge=1, le=200)
    motd: str = Field(default="A KDG Minecraft Server", max_length=120)
    difficulty: str = Field(default="normal")
    gamemode: str = Field(default="survival")
    pvp: bool = True
    onlineMode: bool = True
    enableRcon: bool = True
    rconPassword: str = Field(default="", max_length=64)
    description: str = Field(default="", max_length=200)


class UpdateServer(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=32)
    type: str | None = None
    version: str | None = None
    memory: str | None = None
    port: int | None = Field(default=None, ge=1024, le=65535)
    maxPlayers: int | None = Field(default=None, ge=1, le=200)
    motd: str | None = Field(default=None, max_length=120)
    difficulty: str | None = None
    gamemode: str | None = None
    pvp: bool | None = None
    onlineMode: bool | None = None
    enableRcon: bool | None = None
    rconPassword: str | None = Field(default=None, max_length=64)
    description: str | None = Field(default=None, max_length=200)


class CommandReq(BaseModel):
    command: str = Field(min_length=1, max_length=500)


_host_cache: dict[str, Any] = {"at": 0.0, "ips": []}


def _host_ips() -> list[str]:
    import ipaddress

    now = time.monotonic()
    if now - _host_cache["at"] < 60 and _host_cache["ips"]:
        return _host_cache["ips"]
    ips: list[str] = []
    try:
        r = _run(["tailscale", "ip", "-4"], timeout=3)
        if r.returncode == 0:
            ips += [line.strip() for line in r.stdout.splitlines() if line.strip()]
    except Exception:
        pass
    try:
        out = subprocess.run(
            ["hostname", "-I"], capture_output=True, text=True, timeout=3
        )
        if out.returncode == 0:
            ips += [p for p in out.stdout.split() if not p.startswith("127.")]
    except Exception:
        pass

    def usable(ip: str) -> bool:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        if addr.version != 4:
            return False
        tailnet = ipaddress.ip_network("100.64.0.0/10")
        lan = ipaddress.ip_network("192.168.0.0/16")
        return addr in tailnet or addr in lan

    filtered = [ip for ip in ips if usable(ip)]
    if not filtered:
        filtered = [ip for ip in ips if ":" not in ip and not ip.startswith("127.")][:1]
    seen: list[str] = []
    for ip in filtered:
        if ip not in seen:
            seen.append(ip)
    _host_cache.update({"at": now, "ips": seen})
    return seen


def _addresses(port: int) -> list[str]:
    ips = _host_ips() or ["127.0.0.1"]
    return [f"{ip}:{int(port)}" for ip in ips]


def _server_payload(s: dict[str, Any]) -> dict[str, Any]:
    st = _docker_status(s["id"])
    out = dict(s)
    # Never leak the RCON password back to the browser.
    secret = out.pop("rconPassword", "")
    out["rconConfigured"] = bool(secret)
    out["runtime"] = st
    out["containerName"] = _container_name(s["id"])
    addrs = _addresses(int(s.get("port", 25565)))
    out["addresses"] = addrs
    out["address"] = addrs[0]
    return out


def _require_access(request: Request):
    user = require_user(request)
    if user.role not in {"owner", "admin", "moderator"}:
        raise HTTPException(status_code=403, detail="Not allowed")
    return user


def _validate(payload: dict[str, Any]):
    if "type" in payload and payload["type"]:
        t = str(payload["type"]).upper()
        if t not in _ALLOWED_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported server type. Allowed: {', '.join(sorted(_ALLOWED_TYPES))}")
        payload["type"] = t
    if payload.get("memory") is not None and not _MEM_RE.match(str(payload["memory"]).strip().upper()):
        raise HTTPException(status_code=400, detail="Memory must look like 1G, 2G or 512M")
    if payload.get("memory") is not None:
        payload["memory"] = str(payload["memory"]).strip().upper()
    if payload.get("difficulty") is not None:
        d = str(payload["difficulty"]).lower()
        if d not in _ALLOWED_DIFFICULTY:
            raise HTTPException(status_code=400, detail="Invalid difficulty")
        payload["difficulty"] = d
    if payload.get("gamemode") is not None:
        g = str(payload["gamemode"]).lower()
        if g not in _ALLOWED_GAMEMODE:
            raise HTTPException(status_code=400, detail="Invalid gamemode")
        payload["gamemode"] = g
    if payload.get("version") is not None:
        payload["version"] = str(payload["version"]).strip() or "LATEST"


@router.get("/servers")
def list_servers(request: Request):
    _require_access(request)
    with _lock:
        servers = _load()
    return [_server_payload(s) for s in servers]


@router.post("/servers")
def create_server(payload: CreateServer, request: Request):
    user = _require_access(request)
    data = payload.model_dump()
    _validate(data)
    name = str(data["name"]).strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    sid = re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")[:20] or "server"
    sid = f"{sid}-{uuid.uuid4().hex[:6]}"
    if not _ID_RE.match(sid):
        sid = f"mc-{uuid.uuid4().hex[:8]}"
    rcon_pw = str(data.get("rconPassword") or "").strip() or uuid.uuid4().hex[:12]
    server = {
        "id": sid,
        "name": name,
        "description": data.get("description") or "",
        "type": data["type"],
        "version": data["version"],
        "memory": data["memory"],
        "port": data["port"],
        "maxPlayers": data["maxPlayers"],
        "motd": data["motd"],
        "difficulty": data["difficulty"],
        "gamemode": data["gamemode"],
        "pvp": bool(data["pvp"]),
        "onlineMode": bool(data["onlineMode"]),
        "enableRcon": bool(data["enableRcon"]),
        "rconPassword": rcon_pw,
        "createdAt": int(time.time()),
        "createdBy": user.username,
    }
    with _lock:
        servers = _load()
        for s in servers:
            if int(s.get("port", 0)) == int(data["port"]):
                raise HTTPException(status_code=400, detail="Port already used by another managed server")
        servers.append(server)
        _save(servers)
    (DATA_DIR / sid).mkdir(parents=True, exist_ok=True)
    record("minecraft.server.create", actor=user.username, resource=sid, action="create", result="success", ip=_client_ip(request), detail={"name": name})
    return _server_payload(server)


@router.get("/servers/{sid}")
def get_server(sid: str, request: Request):
    _require_access(request)
    with _lock:
        s = _find(_load(), sid)
    if not s:
        raise HTTPException(status_code=404, detail="Server not found")
    return _server_payload(s)


def _build_docker_args(s: dict[str, Any]) -> list[str]:
    sid = s["id"]
    name = _container_name(sid)
    data = str((DATA_DIR / sid).resolve())
    env = {
        "EULA": "TRUE",
        "TYPE": s.get("type", "PAPER"),
        "VERSION": s.get("version", "LATEST"),
        "MEMORY": s.get("memory", "2G"),
        "MAX_PLAYERS": str(s.get("maxPlayers", 20)),
        "MOTD": s.get("motd", "A KDG Minecraft Server"),
        "DIFFICULTY": s.get("difficulty", "normal"),
        "MODE": s.get("gamemode", "survival"),
        "PVP": "true" if s.get("pvp", True) else "false",
        "ONLINE_MODE": "true" if s.get("onlineMode", True) else "false",
        "ENABLE_RCON": "true" if s.get("enableRcon", True) else "false",
        "RCON_PASSWORD": s.get("rconPassword", ""),
        "SERVER_PORT": "25565",
        "TZ": "Asia/Kolkata",
    }
    args = [
        "docker", "run", "-d", "--name", name, "--restart", "unless-stopped",
        "-p", f"{int(s.get('port', 25565))}:25565/tcp",
        "-v", f"{data}:/data",
        "--label", f"kdg.owner={s.get('createdBy') or 'system'}",
        "--label", "kdg.managed=minecraft",
    ]
    for k, v in env.items():
        if v is not None and v != "":
            args += ["-e", f"{k}={v}"]
    args += ["itzg/minecraft-server:latest"]
    return args


@router.post("/servers/{sid}/start")
def start_server(sid: str, request: Request):
    user = _require_access(request)
    with _lock:
        s = _find(_load(), sid)
    if not s:
        raise HTTPException(status_code=404, detail="Server not found")
    st = _docker_status(sid)
    name = _container_name(sid)
    if st.get("exists") and st.get("running"):
        return {"ok": True, "status": "running", "message": "Already running"}
    # Restore the latest Drive snapshot before the server boots (user-configured).
    restore_note = None
    try:
        from app.mcbackup import restore_on_start_if_enabled

        restore_note = restore_on_start_if_enabled(sid)
    except Exception as exc:  # never block the start path
        record("minecraft.backup.restore_failed", actor=user.username, resource=sid, action="restore", result="failed",
               ip=_client_ip(request), detail={"error": str(exc)[:200]})
        restore_note = str(exc)[:200]
    if st.get("exists") and not st.get("running"):
        r = _run(["docker", "start", name], timeout=90)
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=(r.stderr or r.stdout or "Failed to start")[:300])
    else:
        (DATA_DIR / sid).mkdir(parents=True, exist_ok=True)
        r = _run(_build_docker_args(s), timeout=180)
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=(r.stderr or r.stdout or "Failed to create/start")[:400])
    record("minecraft.server.start", actor=user.username, resource=sid, action="start", result="success", ip=_client_ip(request))
    return {"ok": True, "status": "starting", "restore": restore_note}


@router.post("/servers/{sid}/stop")
def stop_server(sid: str, request: Request):
    user = _require_access(request)
    with _lock:
        s = _find(_load(), sid)
    if not s:
        raise HTTPException(status_code=404, detail="Server not found")
    st = _docker_status(sid)
    if not st.get("exists"):
        return {"ok": True, "status": "not_created"}
    # Save the world before the server exits (best-effort).
    backup_note = None
    try:
        from app.mcbackup import backup_on_transition_if_enabled

        backup_note = backup_on_transition_if_enabled(sid, "stop")
    except Exception as exc:
        record("minecraft.backup.stop_failed", actor=user.username, resource=sid, action="backup", result="failed",
               ip=_client_ip(request), detail={"error": str(exc)[:200]})
        backup_note = str(exc)[:200]
    r = _run(["docker", "stop", _container_name(sid)], timeout=120)
    if r.returncode != 0:
        raise HTTPException(status_code=500, detail=(r.stderr or r.stdout or "Failed to stop")[:300])
    record("minecraft.server.stop", actor=user.username, resource=sid, action="stop", result="success", ip=_client_ip(request))
    return {"ok": True, "status": "stopped", "backup": backup_note}


@router.post("/servers/{sid}/restart")
def restart_server(sid: str, request: Request):
    user = _require_access(request)
    with _lock:
        s = _find(_load(), sid)
    if not s:
        raise HTTPException(status_code=404, detail="Server not found")
    st = _docker_status(sid)
    if not st.get("exists"):
        raise HTTPException(status_code=400, detail="Server container not created yet. Start it first.")
    # Save the world before the container bounces (best-effort).
    backup_note = None
    try:
        from app.mcbackup import backup_on_transition_if_enabled

        backup_note = backup_on_transition_if_enabled(sid, "restart")
    except Exception as exc:
        record("minecraft.backup.restart_failed", actor=user.username, resource=sid, action="backup", result="failed",
               ip=_client_ip(request), detail={"error": str(exc)[:200]})
        backup_note = str(exc)[:200]
    r = _run(["docker", "restart", _container_name(sid)], timeout=180)
    if r.returncode != 0:
        raise HTTPException(status_code=500, detail=(r.stderr or r.stdout or "Failed to restart")[:300])
    record("minecraft.server.restart", actor=user.username, resource=sid, action="restart", result="success", ip=_client_ip(request))
    return {"ok": True, "status": "restarting", "backup": backup_note}


@router.delete("/servers/{sid}")
def delete_server(sid: str, request: Request, deleteData: bool = Query(default=False)):
    user = _require_access(request)
    with _lock:
        servers = _load()
        s = _find(servers, sid)
        if not s:
            raise HTTPException(status_code=404, detail="Server not found")
        _run(["docker", "rm", "-f", _container_name(sid)], timeout=90)
        servers = [x for x in servers if x.get("id") != sid]
        _save(servers)
    if deleteData:
        d = DATA_DIR / sid
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
    record("minecraft.server.delete", actor=user.username, resource=sid, action="delete", result="success", ip=_client_ip(request), detail={"deleteData": deleteData})
    return {"ok": True}


@router.patch("/servers/{sid}")
def update_server(sid: str, payload: UpdateServer, request: Request):
    user = _require_access(request)
    data = payload.model_dump(exclude_none=True)
    _validate(data)
    with _lock:
        servers = _load()
        s = _find(servers, sid)
        if not s:
            raise HTTPException(status_code=404, detail="Server not found")
        st = _docker_status(sid)
        if st.get("running"):
            raise HTTPException(status_code=400, detail="Stop the server before changing configuration")
        if "port" in data:
            for other in servers:
                if other.get("id") != sid and int(other.get("port", 0)) == int(data["port"]):
                    raise HTTPException(status_code=400, detail="Port already used by another managed server")
        if "name" in data:
            data["name"] = str(data["name"]).strip()
        if "rconPassword" in data and not str(data["rconPassword"]).strip():
            data.pop("rconPassword")
        for k, v in data.items():
            s[k] = v
        _save(servers)
    # Recreate the container so new settings take effect on next start.
    if st.get("exists"):
        _run(["docker", "rm", "-f", _container_name(sid)], timeout=90)
    record("minecraft.server.update", actor=user.username, resource=sid, action="update", result="success", ip=_client_ip(request))
    return _server_payload(s)


@router.get("/servers/{sid}/logs")
def server_logs(sid: str, request: Request, tail: int = Query(default=200, ge=1, le=2000)):
    _require_access(request)
    with _lock:
        s = _find(_load(), sid)
    if not s:
        raise HTTPException(status_code=404, detail="Server not found")
    st = _docker_status(sid)
    if not st.get("exists"):
        return {"logs": "Server container has not been created yet. Start the server to generate logs.", "exists": False, "tail": 0}
    r = _run(["docker", "logs", "--tail", str(tail), _container_name(sid)], timeout=25)
    out = (r.stdout or "") + (("\n" + r.stderr) if r.stderr else "")
    return {"logs": out[-200000:], "exists": True, "tail": tail}


@router.post("/servers/{sid}/command")
def server_command(sid: str, payload: CommandReq, request: Request):
    user = _require_access(request)
    with _lock:
        s = _find(_load(), sid)
    if not s:
        raise HTTPException(status_code=404, detail="Server not found")
    st = _docker_status(sid)
    if not st.get("running"):
        raise HTTPException(status_code=400, detail="Server is not running")
    cmd = payload.command.strip()
    if not cmd:
        raise HTTPException(status_code=400, detail="Command required")
    r = _run(["docker", "exec", _container_name(sid), "rcon-cli", cmd], timeout=20)
    if r.returncode != 0:
        r2 = _run(["docker", "exec", _container_name(sid), "mc-send-to-console", cmd], timeout=20)
        if r2.returncode != 0:
            err = (r.stderr or r.stdout or r2.stderr or r2.stdout or "Command failed").strip()
            raise HTTPException(status_code=500, detail=err[:400])
        out = (r2.stdout or "").strip()
    else:
        out = (r.stdout or "").strip()
    record("minecraft.server.command", actor=user.username, resource=sid, action="command", result="success", ip=_client_ip(request), detail={"command": cmd[:80]})
    return {"ok": True, "output": out}
