"""Per-user workspaces: JupyterLab containers, Git repos and Google Drive sync.

Each dashboard user gets an isolated directory on the node:

    workspaces/<user>/
        notebooks/     persisted Jupyter notebooks and data
        repos/         git clones
        drive/         Google Drive mirror (rclone)
        .kdg/          tokens, git credentials, rclone config (mode 700/600)

A JupyterLab container (``ws-<user>``) mounts that directory at
/home/jovyan/work. Containers carry ``kdg.owner=<user>`` so the existing
attribution engine reports their CPU/RAM/VRAM under the right person.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from app.audit import record
from app.auth import _load_users, require_user

router = APIRouter(prefix="/workspaces", tags=["workspaces"])

ROOT = Path(os.getenv("KDG_WORKSPACE_ROOT", "/home/tabahi/kdg-dev/workspaces")).resolve()
DEFAULT_IMAGE = os.getenv("KDG_WORKSPACE_IMAGE", "quay.io/jupyter/scipy-notebook:latest")
RCLONE_IMAGE = os.getenv("KDG_RCLONE_IMAGE", "rclone/rclone:latest")
PORT_BASE = int(os.getenv("KDG_WORKSPACE_PORT_BASE", "8891"))
PORT_MAX = 8999
DEFAULT_MEMORY_MIB = 2048
DEFAULT_CPUS = 2.0
MAX_UPLOAD_BYTES = int(os.getenv("KDG_WORKSPACE_UPLOAD_MAX", str(4 * 1024 ** 3)))
REMOTE_NAME = "kdgdrive"

_LOCK = threading.RLock()
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
_IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:-]{2,150}$")
_ROLES_ALL = {"owner", "admin"}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _canonical(username: str) -> dict[str, Any]:
    entry = _load_users().get(str(username or "").strip().casefold())
    if not entry:
        raise HTTPException(status_code=404, detail="Unknown dashboard user")
    return entry


def _slug(username: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", username.lower()).strip("-") or "user"


def _ws_dir(entry: dict[str, Any]) -> Path:
    return ROOT / _slug(entry["username"])


def _safe_workspace_path(entry: dict[str, Any], relative: str) -> Path:
    root = _ws_dir(entry).resolve()
    text = str(relative or "").strip().lstrip("/\\")
    candidate = (root / text).resolve()
    if candidate != root and root not in candidate.parents:
        raise HTTPException(status_code=400, detail="Path escapes the workspace")
    return candidate


def _container_name(entry: dict[str, Any]) -> str:
    return f"ws-{_slug(entry['username'])}"


def lab_base(entry: dict[str, Any]) -> str:
    """Same-origin path where the embedded JupyterLab is proxied by the API."""
    return f"/api/v1/workspaces/jupyter/{_slug(entry['username'])}/"


def _base_url(entry: dict[str, Any]) -> str:
    return lab_base(entry)


def _state_path(entry: dict[str, Any]) -> Path:
    return _ws_dir(entry) / ".kdg" / "workspace.json"


def _run(cmd: list[str], timeout: int = 60, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", f"Timed out after {timeout}s")
    except FileNotFoundError as exc:
        return subprocess.CompletedProcess(cmd, 127, "", str(exc))


def _private(path: Path, mode: int) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path, mode)
    except OSError:
        pass


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        try:
            sock.bind(("0.0.0.0", port))
            return True
        except OSError:
            return False


def _default_state(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "username": entry["username"],
        "image": DEFAULT_IMAGE,
        "port": 0,
        "token": "",
        "memoryMiB": DEFAULT_MEMORY_MIB,
        "cpus": DEFAULT_CPUS,
        "gpu": False,
        "createdAt": 0,
    }


def _load_state(entry: dict[str, Any]) -> dict[str, Any]:
    state = _default_state(entry)
    try:
        raw = json.loads(_state_path(entry).read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            state.update({k: v for k, v in raw.items() if k in state})
    except (OSError, ValueError):
        pass
    return state


def _save_state(entry: dict[str, Any], state: dict[str, Any]) -> None:
    path = _state_path(entry)
    _private(path, 0o600)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
    tmp.replace(path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _used_ports() -> set[int]:
    used: set[int] = set()
    try:
        entries = _load_users()
    except Exception:
        entries = {}
    for item in entries.values():
        port = int(_load_state(item).get("port") or 0)
        if port:
            used.add(port)
    r = _run(["docker", "ps", "--format", "{{.Ports}}"], timeout=15)
    if r.returncode == 0:
        for token in re.findall(r":(\d{4,5})->", r.stdout):
            used.add(int(token))
    return used


def _ensure(entry: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        base = _ws_dir(entry)
        for sub in ("", "notebooks", "repos", "drive", ".kdg"):
            (base / sub).mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(base, 0o700)
            os.chmod(base / ".kdg", 0o700)
        except OSError:
            pass

        state = _load_state(entry)
        changed = False
        if not state.get("token"):
            state["token"] = secrets.token_urlsafe(24)
            changed = True
        if not state.get("port"):
            used = _used_ports()
            port = PORT_BASE
            while port <= PORT_MAX and (port in used or not _port_free(port)):
                port += 1
            state["port"] = port if port <= PORT_MAX else PORT_BASE
            changed = True
        if not state.get("createdAt"):
            state["createdAt"] = int(time.time())
            changed = True
        if changed:
            _save_state(entry, state)
        return state


def _docker_status(name: str) -> dict[str, Any]:
    r = _run(["docker", "inspect", name, "--format", "{{json .}}"], timeout=15)
    if r.returncode != 0:
        return {"exists": False, "state": "not_created", "status": "Not created", "running": False}
    try:
        info = json.loads(r.stdout.strip() or "{}")
    except ValueError:
        return {"exists": False, "state": "unknown", "status": "Unknown", "running": False}
    state = info.get("State") or {}
    running = bool(state.get("Running"))
    config = info.get("Config") or {}
    labels = config.get("Labels") or {}
    return {
        "exists": True,
        "state": "running" if running else "stopped",
        "status": state.get("Status") or ("running" if running else "stopped"),
        "running": running,
        "startedAt": state.get("StartedAt"),
        "image": config.get("Image"),
        "labels": {str(k): str(v) for k, v in labels.items() if str(k).startswith("kdg.")},
    }


def _mib(value: str) -> float | None:
    text = str(value or "").strip().lower().replace(" ", "")
    match = re.match(r"^([0-9.]+)([a-z]*)$", text)
    if not match:
        return None
    number = float(match.group(1))
    unit = match.group(2) or "b"
    if unit.startswith("gi"):
        return round(number * 1024, 1)
    if unit.startswith("g"):
        return round(number * 1000, 1)
    if unit.startswith("mi"):
        return round(number, 1)
    if unit.startswith("m"):
        return round(number * 1000 / 1024, 1)
    if unit.startswith("ki"):
        return round(number / 1024, 1)
    if unit.startswith("k"):
        return round(number / 1_000_000, 2)
    return round(number / (1024 * 1024), 2)


def _container_usage(name: str) -> dict[str, Any]:
    out: dict[str, Any] = {"cpuPercent": None, "memMiB": None, "memLimitMiB": None, "gpuMiB": None}
    r = _run(["docker", "stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", name], timeout=25)
    if r.returncode == 0 and "|" in r.stdout:
        cpu, mem = r.stdout.strip().split("|", 1)
        try:
            out["cpuPercent"] = round(float(cpu.strip().rstrip("%")), 2)
        except ValueError:
            pass
        parts = mem.split("/")
        if len(parts) == 2:
            out["memMiB"] = _mib(parts[0])
            out["memLimitMiB"] = _mib(parts[1])
    pids: set[int] = set()
    top = _run(["docker", "top", name, "-o", "pid"], timeout=15)
    if top.returncode == 0:
        for line in top.stdout.splitlines()[1:]:
            line = line.strip()
            if line.isdigit():
                pids.add(int(line))
    if pids:
        smi = _run(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], timeout=15)
        if smi.returncode == 0:
            total = 0.0
            for line in smi.stdout.splitlines():
                cells = [c.strip() for c in line.split(",")]
                if len(cells) >= 2 and cells[0].isdigit() and int(cells[0]) in pids:
                    try:
                        total += float(cells[1])
                    except ValueError:
                        pass
            out["gpuMiB"] = round(total, 1)
    return out


def _dir_size_bytes(path: Path) -> int:
    r = _run(["du", "-sb", str(path)], timeout=30)
    if r.returncode == 0:
        first = r.stdout.split()
        if first and first[0].isdigit():
            return int(first[0])
    return 0


def _git_credentials(entry: dict[str, Any]) -> dict[str, Any]:
    try:
        raw = json.loads((_ws_dir(entry) / ".kdg" / "git-credentials.json").read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_git_credentials(entry: dict[str, Any], creds: dict[str, Any]) -> None:
    path = _ws_dir(entry) / ".kdg" / "git-credentials.json"
    _private(path, 0o600)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(creds, indent=2), encoding="utf-8")
    tmp.replace(path)
    os.chmod(path, 0o600)
    # Mirror into git's credential store so the JupyterLab terminal can push.
    store = _ws_dir(entry) / ".kdg" / "git-credentials-store"
    lines = []
    for host, item in creds.items():
        host = str(host)
        user = urllib.parse.quote(str(item.get("username") or "git"), safe="")
        token = urllib.parse.quote(str(item.get("token") or ""), safe="")
        if token:
            lines.append(f"https://{user}:{token}@{host}\n")
    store.write_text("".join(lines), encoding="utf-8")
    os.chmod(store, 0o600)


def _git(args: list[str], cwd: Path | None = None, timeout: int = 180) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    cmd = ["git"]
    if cwd is not None:
        cmd += ["-C", str(cwd)]
    return _run(cmd + args, timeout=timeout, env=env)


def _repo_dir(entry: dict[str, Any], name: str) -> Path:
    if not _REPO_RE.match(name or ""):
        raise HTTPException(status_code=400, detail="Invalid repository name")
    return _ws_dir(entry) / "repos" / name


def _repo_info(path: Path) -> dict[str, Any] | None:
    if not (path / ".git").exists():
        return None
    info: dict[str, Any] = {"name": path.name, "branch": "", "dirty": False, "ahead": 0, "behind": 0, "lastCommit": "", "remote": ""}
    head = _git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=path, timeout=20)
    if head.returncode == 0:
        info["branch"] = head.stdout.strip()
    status = _git(["status", "--porcelain"], cwd=path, timeout=30)
    if status.returncode == 0:
        info["dirty"] = bool(status.stdout.strip())
    log = _git(["log", "-1", "--pretty=format:%h%x1f%an%x1f%ar%x1f%s"], cwd=path, timeout=20)
    if log.returncode == 0 and log.stdout.strip():
        parts = log.stdout.strip().split("\x1f")
        while len(parts) < 4:
            parts.append("")
        info["lastCommit"] = f"{parts[0]} · {parts[3]}"
        info["commitAuthor"] = parts[1]
        info["commitAge"] = parts[2]
    remote = _git(["remote", "get-url", "origin"], cwd=path, timeout=20)
    if remote.returncode == 0:
        info["remote"] = remote.stdout.strip()
    counts = _git(["rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd=path, timeout=20)
    if counts.returncode == 0:
        cells = counts.stdout.split()
        if len(cells) == 2:
            info["behind"], info["ahead"] = int(cells[0]), int(cells[1])
    return info


def _drive_state(entry: dict[str, Any]) -> dict[str, Any]:
    try:
        raw = json.loads((_ws_dir(entry) / ".kdg" / "drive.json").read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _drive_connected(entry: dict[str, Any]) -> bool:
    return (_ws_dir(entry) / ".kdg" / "rclone.conf").exists()


def _payload(entry: dict[str, Any], actor: Any) -> dict[str, Any]:
    state = _ensure(entry)
    name = _container_name(entry)
    status = _docker_status(name)
    repos = []
    repos_dir = _ws_dir(entry) / "repos"
    if repos_dir.exists():
        for child in sorted(repos_dir.iterdir()):
            if child.is_dir():
                info = _repo_info(child)
                if info:
                    repos.append(info)
    creds = _git_credentials(entry)
    drive = _drive_state(entry)
    is_self = actor.username.casefold() == entry["username"].casefold()
    payload = {
        "username": entry["username"],
        "displayName": entry["displayName"],
        "role": entry["role"],
        "state": status["state"],
        "running": status["running"],
        "status": status["status"],
        "startedAt": status.get("startedAt"),
        "containerName": name,
        "port": int(state.get("port") or 0),
        "memoryMiB": int(state.get("memoryMiB") or DEFAULT_MEMORY_MIB),
        "cpus": float(state.get("cpus") or DEFAULT_CPUS),
        "gpu": bool(state.get("gpu")),
        "image": state.get("image") or DEFAULT_IMAGE,
        "labPath": lab_base(entry),
        "labReady": (status.get("labels") or {}).get("kdg.lab") == lab_base(entry),
        "diskBytes": _dir_size_bytes(_ws_dir(entry)),
        "usage": _container_usage(name) if status["running"] else {"cpuPercent": None, "memMiB": None, "memLimitMiB": None, "gpuMiB": None},
        "git": {"repos": repos, "credentials": sorted(creds.keys())},
        "drive": {
            "connected": _drive_connected(entry),
            "remotePath": drive.get("remotePath") or "",
            "lastSync": drive.get("lastSync"),
            "lastResult": drive.get("lastResult") or "",
            "quota": drive.get("quota"),
        },
    }
    # The Jupyter token is only ever shown to the workspace owner or an owner/admin.
    if is_self or actor.role in _ROLES_ALL:
        payload["token"] = state.get("token") or ""
    return payload


def _target(request: Request, username: str) -> tuple[Any, dict[str, Any]]:
    actor = require_user(request)
    entry = _canonical(username)
    is_self = actor.username.casefold() == entry["username"].casefold()
    if not is_self and actor.role not in _ROLES_ALL:
        raise HTTPException(status_code=403, detail="You can only manage your own workspace")
    return actor, entry


def _docker_args(state: dict[str, Any], entry: dict[str, Any]) -> list[str]:
    base = _ws_dir(entry)
    name = _container_name(entry)
    account = entry["username"]
    args = [
        "docker", "run", "-d", "--name", name,
        *(["--gpus", "all"] if state.get("gpu") else []),
        "--restart", "unless-stopped",
        "--label", "kdg.managed=workspace",
        "--label", f"kdg.owner={account}",
        "--memory", f"{int(state.get('memoryMiB') or DEFAULT_MEMORY_MIB)}m",
        "--cpus", str(float(state.get("cpus") or DEFAULT_CPUS)),
        "-p", f"0.0.0.0:{int(state.get('port') or PORT_BASE)}:8888",
        "-v", f"{base}:/home/jovyan/work",
        "-e", f"JUPYTER_TOKEN={state.get('token', '')}",
        "-e", "JUPYTER_ENABLE_LAB=yes",
        "-e", "GRANT_SUDO=no",
        "-e", "TZ=Asia/Kolkata",
        "--label", f"kdg.lab={_base_url(entry)}",
    ]
    args.append(str(state.get("image") or DEFAULT_IMAGE))
    args.extend([
        "start-notebook.py",
        f"--ServerApp.base_url={_base_url(entry)}",
        "--ServerApp.allow_remote_access=True",
    ])
    return args


# --------------------------------------------------------------------------- #
# api models
# --------------------------------------------------------------------------- #

class StartWorkspace(BaseModel):
    memoryMiB: int = Field(default=DEFAULT_MEMORY_MIB, ge=512, le=8192)
    cpus: float = Field(default=DEFAULT_CPUS, ge=0.5, le=8.0)
    gpu: bool = False
    image: str = Field(default="", max_length=160)


class GitCredential(BaseModel):
    host: str = Field(min_length=3, max_length=253)
    username: str = Field(default="git", max_length=120)
    token: str = Field(min_length=4, max_length=600)


class CloneRepo(BaseModel):
    url: str = Field(min_length=8, max_length=500)
    name: str = Field(default="", max_length=64)
    branch: str = Field(default="", max_length=120)
    userName: str = Field(default="", max_length=120)
    userEmail: str = Field(default="", max_length=200)


class DriveConnect(BaseModel):
    token: str = Field(min_length=10, max_length=8000)
    clientId: str = Field(default="", max_length=200)
    clientSecret: str = Field(default="", max_length=200)
    remotePath: str = Field(default="", max_length=200)


class DriveSync(BaseModel):
    direction: str = Field(default="pull", pattern="^(pull|push)$")


class NewNotebook(BaseModel):
    name: str = Field(default="notebook.ipynb", min_length=1, max_length=120)
    path: str = Field(default="", max_length=300)


# --------------------------------------------------------------------------- #
# workspace endpoints
# --------------------------------------------------------------------------- #

@router.get("")
def list_workspaces(request: Request):
    actor = require_user(request)
    entries = _load_users()
    if actor.role in _ROLES_ALL:
        chosen = [entries[k] for k in sorted(entries)]
    else:
        chosen = [entries[actor.username.casefold()]]
    return [_payload(entry, actor) for entry in chosen]


@router.get("/{username}")
def get_workspace(username: str, request: Request):
    actor, entry = _target(request, username)
    return _payload(entry, actor)


@router.post("/{username}/start")
def start_workspace(username: str, payload: StartWorkspace, request: Request):
    actor, entry = _target(request, username)
    image = (payload.image or "").strip()
    if image and not _IMAGE_RE.match(image):
        raise HTTPException(status_code=400, detail="Invalid container image reference")
    with _LOCK:
        state = _ensure(entry)
        state.update({
            "memoryMiB": payload.memoryMiB,
            "cpus": payload.cpus,
            "gpu": bool(payload.gpu),
        })
        if image:
            state["image"] = image
        _save_state(entry, state)
        name = _container_name(entry)
        status = _docker_status(name)
        if status["exists"]:
            _run(["docker", "rm", "-f", name], timeout=90)
        r = _run(_docker_args(state, entry), timeout=420)
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=(r.stderr or r.stdout or "Failed to start workspace")[:400])
    record("workspace.start", actor=actor.username, resource=entry["username"], action="start", result="success",
           ip=_client_ip(request), detail={"gpu": bool(state.get("gpu")), "memoryMiB": state.get("memoryMiB")})
    return _payload(entry, actor)


@router.post("/{username}/stop")
def stop_workspace(username: str, request: Request):
    actor, entry = _target(request, username)
    name = _container_name(entry)
    status = _docker_status(name)
    if not status["exists"]:
        return {"ok": True, "status": "not_created"}
    r = _run(["docker", "stop", name], timeout=120)
    if r.returncode != 0:
        raise HTTPException(status_code=500, detail=(r.stderr or r.stdout or "Failed to stop workspace")[:300])
    record("workspace.stop", actor=actor.username, resource=entry["username"], action="stop", result="success", ip=_client_ip(request))
    return {"ok": True, "status": "stopped"}


@router.post("/{username}/restart")
def restart_workspace(username: str, request: Request):
    actor, entry = _target(request, username)
    with _LOCK:
        state = _ensure(entry)
        name = _container_name(entry)
        status = _docker_status(name)
        if not status["exists"]:
            raise HTTPException(status_code=400, detail="Workspace container does not exist yet. Start it first.")
        _run(["docker", "rm", "-f", name], timeout=90)
        r = _run(_docker_args(state, entry), timeout=420)
        if r.returncode != 0:
            raise HTTPException(status_code=500, detail=(r.stderr or r.stdout or "Failed to restart workspace")[:400])
    record("workspace.restart", actor=actor.username, resource=entry["username"], action="restart", result="success", ip=_client_ip(request))
    return _payload(entry, actor)


@router.get("/{username}/logs")
def workspace_logs(username: str, request: Request, tail: int = Query(default=200, ge=1, le=2000)):
    _target(request, username)
    entry = _canonical(username)
    name = _container_name(entry)
    status = _docker_status(name)
    if not status["exists"]:
        return {"logs": "Workspace has not been started yet.", "exists": False, "tail": 0}
    r = _run(["docker", "logs", "--tail", str(tail), name], timeout=25)
    out = (r.stdout or "") + (("\n" + r.stderr) if r.stderr else "")
    return {"logs": out[-200000:], "exists": True, "tail": tail}


@router.post("/{username}/files")
async def upload_workspace_files(
    username: str,
    request: Request,
    path: str = Query(default="", max_length=500),
    files: list[UploadFile] = File(...),
):
    """Upload files into the workspace directory (visible in the embedded JupyterLab)."""
    actor, entry = _target(request, username)
    with _LOCK:
        _ensure(entry)
    root = _ws_dir(entry).resolve()
    dest_dir = _safe_workspace_path(entry, path)
    if dest_dir.exists() and not dest_dir.is_dir():
        raise HTTPException(status_code=400, detail="Target path is a file")
    dest_dir.mkdir(parents=True, exist_ok=True)
    saved: list[dict[str, Any]] = []
    total = 0
    for upload in files[:20]:
        raw = str(upload.filename or "upload.bin").replace("\\", "/").split("/")[-1]
        name = re.sub(r"[\x00-\x1f]", "", raw).strip() or "upload.bin"
        target = dest_dir / name
        stem, suffix = target.stem, target.suffix
        index = 1
        while target.exists():
            target = dest_dir / f"{stem}-{index}{suffix}"
            index += 1
        size = 0
        try:
            with open(target, "wb") as handle:
                while True:
                    chunk = await upload.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail=f"{name} exceeds the upload limit")
                    handle.write(chunk)
        except HTTPException:
            target.unlink(missing_ok=True)
            raise
        except OSError as exc:
            target.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Could not save {name}: {exc}") from exc
        saved.append({"name": target.name, "path": str(target.relative_to(root)), "sizeBytes": size})
        total += size
    record("workspace.files.upload", actor=actor.username, resource=entry["username"], action="upload", result="success",
           ip=_client_ip(request), detail={"files": len(saved), "bytes": total, "path": path})
    return {"ok": True, "uploaded": saved, "totalBytes": total, "directory": path}


@router.post("/{username}/notebooks")
def create_workspace_notebook(username: str, payload: NewNotebook, request: Request):
    actor, entry = _target(request, username)
    with _LOCK:
        _ensure(entry)
    root = _ws_dir(entry).resolve()
    folder = _safe_workspace_path(entry, payload.path)
    if folder.exists() and not folder.is_dir():
        raise HTTPException(status_code=400, detail="Target path is a file")
    folder.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._ -]", "-", payload.name).strip().strip(".") or "notebook"
    if not stem.lower().endswith(".ipynb"):
        stem += ".ipynb"
    rel_dir = "" if folder == root else str(folder.relative_to(root))
    target = _safe_workspace_path(entry, str(Path(rel_dir) / stem) if rel_dir else stem)
    if target.exists():
        raise HTTPException(status_code=409, detail=f"'{target.name}' already exists")
    notebook = {
        "cells": [],
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": ""},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    target.write_text(json.dumps(notebook, indent=1), encoding="utf-8")
    rel = str(target.relative_to(root))
    record("workspace.notebook.create", actor=actor.username, resource=entry["username"], action="create", result="success",
           ip=_client_ip(request), detail={"notebook": rel})
    return {"ok": True, "notebook": rel, "name": target.name}


@router.post("/{username}/token/rotate")
def rotate_token(username: str, request: Request):
    actor, entry = _target(request, username)
    with _LOCK:
        state = _ensure(entry)
        state["token"] = secrets.token_urlsafe(24)
        _save_state(entry, state)
        name = _container_name(entry)
        status = _docker_status(name)
        if status["exists"]:
            _run(["docker", "rm", "-f", name], timeout=90)
            r = _run(_docker_args(state, entry), timeout=420)
            if r.returncode != 0:
                raise HTTPException(status_code=500, detail=(r.stderr or r.stdout or "Failed to recreate workspace")[:400])
    record("workspace.token.rotate", actor=actor.username, resource=entry["username"], action="rotate", result="success", ip=_client_ip(request))
    return _payload(entry, actor)


@router.delete("/{username}")
def delete_workspace(username: str, request: Request, deleteData: bool = Query(default=False)):
    actor, entry = _target(request, username)
    with _LOCK:
        _run(["docker", "rm", "-f", _container_name(entry)], timeout=90)
        if deleteData:
            shutil.rmtree(_ws_dir(entry), ignore_errors=True)
        else:
            state = _load_state(entry)
            state["token"] = secrets.token_urlsafe(24)
            state["port"] = 0
            _save_state(entry, state)
    record("workspace.delete", actor=actor.username, resource=entry["username"], action="delete", result="success",
           ip=_client_ip(request), detail={"deleteData": deleteData})
    return {"ok": True}


# --------------------------------------------------------------------------- #
# git
# --------------------------------------------------------------------------- #

@router.get("/{username}/git")
def git_overview(username: str, request: Request):
    _actor, entry = _target(request, username)
    repos = []
    repos_dir = _ws_dir(entry) / "repos"
    if repos_dir.exists():
        for child in sorted(repos_dir.iterdir()):
            if child.is_dir():
                info = _repo_info(child)
                if info:
                    repos.append(info)
    creds = _git_credentials(entry)
    return {"repos": repos, "credentials": sorted(creds.keys())}


@router.post("/{username}/git/credentials")
def save_git_credential(username: str, payload: GitCredential, request: Request):
    actor, entry = _target(request, username)
    host = payload.host.strip().lower()
    if not _HOST_RE.match(host):
        raise HTTPException(status_code=400, detail="Invalid git host")
    creds = _git_credentials(entry)
    creds[host] = {"username": payload.username.strip() or "git", "token": payload.token.strip(), "savedAt": int(time.time())}
    _save_git_credentials(entry, creds)
    record("workspace.git.credential", actor=actor.username, resource=entry["username"], action="credential", result="success",
           ip=_client_ip(request), detail={"host": host})
    return {"ok": True, "credentials": sorted(creds.keys())}


@router.delete("/{username}/git/credentials")
def delete_git_credential(username: str, request: Request, host: str = Query(min_length=3)):
    actor, entry = _target(request, username)
    creds = _git_credentials(entry)
    creds.pop(host.strip().lower(), None)
    _save_git_credentials(entry, creds)
    record("workspace.git.credential.delete", actor=actor.username, resource=entry["username"], action="delete", result="success",
           ip=_client_ip(request), detail={"host": host})
    return {"ok": True, "credentials": sorted(creds.keys())}


@router.post("/{username}/git/repos")
def clone_repo(username: str, payload: CloneRepo, request: Request):
    actor, entry = _target(request, username)
    url = payload.url.strip()
    if not re.match(r"^(https?://|ssh://|git@)", url):
        raise HTTPException(status_code=400, detail="Only https://, ssh:// or git@ repository URLs are supported")
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    name = (payload.name or "").strip() or re.sub(r"\.git$", "", (parsed.path or "").rstrip("/").split("/")[-1])
    name = re.sub(r"[^A-Za-z0-9._-]", "-", name)[:64].strip(".-")
    if not _REPO_RE.match(name):
        raise HTTPException(status_code=400, detail="Could not derive a valid repository name")
    dest = _repo_dir(entry, name)
    if dest.exists():
        raise HTTPException(status_code=409, detail=f"Repository '{name}' already exists")

    clone_url = url
    creds = _git_credentials(entry)
    credential = creds.get(host) if url.startswith("https://") else None
    if credential and parsed.scheme == "https":
        quoted_host = parsed.hostname or ""
        user = urllib.parse.quote(str(credential.get("username") or "git"), safe="")
        token = urllib.parse.quote(str(credential.get("token") or ""), safe="")
        clone_url = urllib.parse.urlunparse((
            "https", f"{user}:{token}@{quoted_host}", parsed.path, parsed.params, parsed.query, parsed.fragment,
        ))
    args = ["clone", "--"]
    if payload.branch:
        args = ["clone", "--branch", payload.branch, "--"]
    r = _git(args + [clone_url, str(dest)], timeout=600)
    if r.returncode != 0:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(status_code=400, detail=(r.stderr or r.stdout or "git clone failed").strip()[:400])
    _git(["remote", "set-url", "origin", url], cwd=dest)
    _git(["config", "credential.helper", "store --file=../../.kdg/git-credentials-store"], cwd=dest)
    if payload.userName:
        _git(["config", "user.name", payload.userName], cwd=dest)
    if payload.userEmail:
        _git(["config", "user.email", payload.userEmail], cwd=dest)
    record("workspace.git.clone", actor=actor.username, resource=entry["username"], action="clone", result="success",
           ip=_client_ip(request), detail={"repo": name, "host": host})
    return {"ok": True, "repo": _repo_info(dest), "usedCredential": bool(credential)}


@router.post("/{username}/git/repos/{name}/{action}")
def repo_action(username: str, name: str, action: str, request: Request):
    actor, entry = _target(request, username)
    if action not in {"pull", "push", "fetch"}:
        raise HTTPException(status_code=400, detail="Unsupported action")
    dest = _repo_dir(entry, name)
    if not (dest / ".git").exists():
        raise HTTPException(status_code=404, detail="Repository not found")
    if action == "pull":
        r = _git(["pull", "--ff-only"], cwd=dest, timeout=300)
    elif action == "push":
        r = _git(["push"], cwd=dest, timeout=300)
    else:
        r = _git(["fetch", "--all", "--prune"], cwd=dest, timeout=300)
    if r.returncode != 0:
        raise HTTPException(status_code=409, detail=(r.stderr or r.stdout or f"git {action} failed").strip()[:400])
    record(f"workspace.git.{action}", actor=actor.username, resource=entry["username"], action=action, result="success",
           ip=_client_ip(request), detail={"repo": name})
    return {"ok": True, "output": ((r.stdout or "") + (r.stderr or "")).strip()[:4000], "repo": _repo_info(dest)}


@router.get("/{username}/git/repos/{name}/log")
def repo_log(username: str, request: Request, name: str, tail: int = Query(default=20, ge=1, le=200)):
    _actor, entry = _target(request, username)
    dest = _repo_dir(entry, name)
    if not (dest / ".git").exists():
        raise HTTPException(status_code=404, detail="Repository not found")
    r = _git(["log", f"-{tail}", "--pretty=format:%h%x1f%an%x1f%ar%x1f%s"], cwd=dest, timeout=30)
    if r.returncode != 0:
        raise HTTPException(status_code=400, detail=(r.stderr or "git log failed").strip()[:300])
    commits = []
    for line in r.stdout.splitlines():
        parts = line.split("\x1f")
        if len(parts) == 4:
            commits.append({"hash": parts[0], "author": parts[1], "age": parts[2], "subject": parts[3]})
    return {"commits": commits}


@router.delete("/{username}/git/repos/{name}")
def delete_repo(username: str, request: Request, name: str):
    actor, entry = _target(request, username)
    dest = _repo_dir(entry, name)
    if not dest.exists():
        raise HTTPException(status_code=404, detail="Repository not found")
    shutil.rmtree(dest, ignore_errors=True)
    record("workspace.git.delete", actor=actor.username, resource=entry["username"], action="delete", result="success",
           ip=_client_ip(request), detail={"repo": name})
    return {"ok": True}


# --------------------------------------------------------------------------- #
# google drive (rclone)
# --------------------------------------------------------------------------- #

def _rclone(entry: dict[str, Any], args: list[str], timeout: int = 900) -> subprocess.CompletedProcess:
    base = _ws_dir(entry)
    cmd = [
        "docker", "run", "--rm",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{base / '.kdg'}:/config/rclone",
        "-v", f"{base / 'drive'}:/data",
        RCLONE_IMAGE,
        "--config", "/config/rclone/rclone.conf",
    ] + args
    return _run(cmd, timeout=timeout)


@router.get("/{username}/drive")
def drive_status(username: str, request: Request):
    _actor, entry = _target(request, username)
    state = _drive_state(entry)
    return {
        "connected": _drive_connected(entry),
        "remotePath": state.get("remotePath") or "",
        "lastSync": state.get("lastSync"),
        "lastResult": state.get("lastResult") or "",
        "quota": state.get("quota"),
        "localBytes": _dir_size_bytes(_ws_dir(entry) / "drive"),
    }


@router.post("/{username}/drive/connect")
def drive_connect(username: str, payload: DriveConnect, request: Request):
    actor, entry = _target(request, username)
    raw = payload.token.strip()
    try:
        token_obj = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Token must be the JSON printed by `rclone authorize drive`") from exc
    if isinstance(token_obj, str):
        try:
            token_obj = json.loads(token_obj)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Token JSON is invalid") from exc
    if not isinstance(token_obj, dict) or not token_obj.get("refresh_token"):
        raise HTTPException(status_code=400, detail="Token JSON needs a refresh_token from `rclone authorize drive`")
    token_json = json.dumps(token_obj, separators=(",", ":"))
    remote_path = (payload.remotePath or f"KDG/{entry['username']}").strip().strip("/")
    lines = [
        f"[{REMOTE_NAME}]",
        "type = drive",
        "scope = drive",
        f"token = {token_json}",
    ]
    if payload.clientId.strip():
        lines.append(f"client_id = {payload.clientId.strip()}")
    if payload.clientSecret.strip():
        lines.append(f"client_secret = {payload.clientSecret.strip()}")
    config = _ws_dir(entry) / ".kdg" / "rclone.conf"
    _private(config, 0o600)
    config.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.chmod(config, 0o600)

    probe = _rclone(entry, ["about", f"{REMOTE_NAME}:", "--json"], timeout=180)
    quota = None
    if probe.returncode == 0 and probe.stdout.strip():
        try:
            quota = json.loads(probe.stdout)
        except ValueError:
            quota = None
    if probe.returncode != 0:
        listing = _rclone(entry, ["lsd", f"{REMOTE_NAME}:", "--max-depth", "1"], timeout=180)
        if listing.returncode != 0:
            config.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail=(listing.stderr or probe.stderr or "Google Drive rejected the token").strip()[:400])
    state = _drive_state(entry)
    state.update({
        "remotePath": remote_path,
        "connectedAt": int(time.time()),
        "quota": quota,
        "lastResult": "Connected",
    })
    path = _ws_dir(entry) / ".kdg" / "drive.json"
    _private(path, 0o600)
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    record("workspace.drive.connect", actor=actor.username, resource=entry["username"], action="connect", result="success",
           ip=_client_ip(request), detail={"remotePath": remote_path})
    return drive_status(username, request)


@router.post("/{username}/drive/sync")
def drive_sync(username: str, payload: DriveSync, request: Request):
    actor, entry = _target(request, username)
    if not _drive_connected(entry):
        raise HTTPException(status_code=400, detail="Connect Google Drive first")
    state = _drive_state(entry)
    remote_path = (state.get("remotePath") or f"KDG/{entry['username']}").strip("/")
    source, dest = (f"{REMOTE_NAME}:{remote_path}", "/data") if payload.direction == "pull" else ("/data", f"{REMOTE_NAME}:{remote_path}")
    r = _rclone(entry, [
        "copy", source, dest,
        "--create-empty-src-dirs",
        "--transfers", "8",
        "--stats", "10s",
        "--stats-one-line",
    ], timeout=1800)
    if r.returncode != 0:
        state["lastResult"] = (r.stderr or r.stdout or "Sync failed").strip()[:400]
        state["lastSync"] = int(time.time())
        path = _ws_dir(entry) / ".kdg" / "drive.json"
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        raise HTTPException(status_code=502, detail=state["lastResult"])
    tail = [line for line in ((r.stdout or "") + (r.stderr or "")).strip().splitlines() if line.strip()][-3:]
    state["lastSync"] = int(time.time())
    state["lastResult"] = " ".join(tail)[:400] or f"{payload.direction} complete"
    path = _ws_dir(entry) / ".kdg" / "drive.json"
    _private(path, 0o600)
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    record("workspace.drive.sync", actor=actor.username, resource=entry["username"], action="sync", result="success",
           ip=_client_ip(request), detail={"direction": payload.direction})
    return drive_status(username, request)


@router.delete("/{username}/drive")
def drive_disconnect(username: str, request: Request):
    actor, entry = _target(request, username)
    for name in ("rclone.conf", "drive.json"):
        (_ws_dir(entry) / ".kdg" / name).unlink(missing_ok=True)
    record("workspace.drive.disconnect", actor=actor.username, resource=entry["username"], action="disconnect", result="success", ip=_client_ip(request))
    return {"ok": True}
