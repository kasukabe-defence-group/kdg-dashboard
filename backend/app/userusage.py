"""Per-user resource attribution for the KDG dashboard.

Answers "who is using what" for CPU, RAM, GPU/VRAM and processes.

Attribution is evidence-based, never guessed silently:

1. ``kdg.owner`` Docker label (containers created by KDG or labelled manually).
2. PID registry populated when KDG itself spawns processes (terminal sessions).
3. Administrator-defined patterns / container names (``kdg-user-map.json``).
4. OS-account mapping (only meaningful when real OS users differ).

Anything that cannot be attributed is returned in the ``unattributed`` bucket
instead of being assigned to a random user.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import psutil
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import app.auth as auth_mod
from app.apikeys import _load as _load_api_keys
from app.audit import read_events, record
from app.auth import current_user, require_user

router = APIRouter(prefix="/users", tags=["users"])

BASE = Path(os.getenv("KDG_STATE_DIR", "/home/tabahi/kdg-dev/kdg-api")).resolve()
ATTR_FILE = BASE / "kdg-attribution.json"
MAP_FILE = BASE / "kdg-user-map.json"

_lock = threading.RLock()
_attr: dict[str, dict[str, Any]] | None = None
_user_map: dict[str, Any] | None = None

_CID_RE = re.compile(r"(?:docker[-/]|libpod-)([0-9a-f]{12,64})")
_containers_cache: dict[str, Any] = {"at": 0.0, "data": []}
_gpu_cache: dict[str, Any] = {"at": 0.0, "data": {}}


# --------------------------------------------------------------------------
# persistence helpers
# --------------------------------------------------------------------------
def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _write_json(path: Path, data) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        tmp.replace(path)
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
    except Exception:
        pass


def _load_attr() -> dict[str, dict[str, Any]]:
    global _attr
    with _lock:
        if _attr is None:
            raw = _read_json(ATTR_FILE, {})
            _attr = raw if isinstance(raw, dict) else {}
        return _attr


def _save_attr() -> None:
    with _lock:
        _write_json(ATTR_FILE, _load_attr())


def _load_map() -> dict[str, Any]:
    global _user_map
    with _lock:
        if _user_map is None:
            raw = _read_json(MAP_FILE, {})
            if not isinstance(raw, dict):
                raw = {}
            raw.setdefault("containers", {})
            raw.setdefault("patterns", [])
            raw.setdefault("os", {})
            _user_map = raw
        return _user_map


def _save_map() -> None:
    with _lock:
        _write_json(MAP_FILE, _load_map())


# --------------------------------------------------------------------------
# attribution API used by other modules (terminal, minecraft, ...)
# --------------------------------------------------------------------------
def attribute_pid(pid: int, username: str, label: str = "", source: str = "manual") -> None:
    """Register that ``pid`` (and its descendants) belongs to ``username``."""
    if not pid or not username:
        return
    with _lock:
        attr = _load_attr()
        attr[str(int(pid))] = {
            "user": username,
            "label": label or "",
            "source": source,
            "since": int(time.time()),
        }
        _save_attr()


def release_pid(pid: int) -> None:
    with _lock:
        attr = _load_attr()
        if attr.pop(str(int(pid)), None) is not None:
            _save_attr()


def attribute_container(key: str, username: str) -> None:
    """Record that ``key`` (container name or id) is operated by ``username``."""
    if not key or not username:
        return
    name = key.strip()
    for c in _docker_containers():
        if name == c["name"] or (len(name) >= 6 and (c["shortId"].startswith(name) or name.startswith(c["shortId"]))):
            name = c["name"]
            break
    with _lock:
        _load_map()["containers"][name] = username
        _save_map()
    _containers_cache["at"] = 0.0


def _prune(attr: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Drop registry entries whose PID no longer exists."""
    changed = False
    for key in list(attr.keys()):
        try:
            pid = int(key)
        except ValueError:
            attr.pop(key, None)
            changed = True
            continue
        if not psutil.pid_exists(pid):
            attr.pop(key, None)
            changed = True
    if changed:
        _save_attr()
    return attr


# --------------------------------------------------------------------------
# discovery
# --------------------------------------------------------------------------
def _docker_containers() -> list[dict[str, Any]]:
    now = time.monotonic()
    if now - _containers_cache["at"] < 8:
        return _containers_cache["data"]
    rows: list[dict[str, Any]] = []
    fmt = '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "kdg.owner"}}\t{{.Label "kdg.managed"}}'
    try:
        out = subprocess.run(
            ["docker", "ps", "-a", "--no-trunc", "--format", fmt],
            capture_output=True, text=True, timeout=8,
        )
        if out.returncode == 0:
            for line in out.stdout.splitlines():
                parts = line.split("\t")
                if len(parts) < 3:
                    continue
                cid, name, state = parts[0].strip(), parts[1].strip(), parts[2].strip()
                owner = parts[3].strip() if len(parts) > 3 else ""
                managed = parts[4].strip() if len(parts) > 4 else ""
                rows.append({
                    "id": cid,
                    "shortId": cid[:12],
                    "name": name,
                    "state": state,
                    "owner": owner,
                    "managed": managed,
                })
    except Exception:
        rows = []
    _containers_cache.update({"at": now, "data": rows})
    return rows


def _container_owner_map() -> dict[str, str]:
    """short container id / container name -> dashboard username."""
    mapping = _load_map().get("containers") or {}
    owner_map: dict[str, str] = {}
    for c in _docker_containers():
        owner = c.get("owner") or ""
        if not owner:
            for name_key, user in mapping.items():
                if str(name_key).lower() in (c["name"].lower(), c["shortId"].lower()):
                    owner = user
                    break
        if owner:
            owner_map[c["shortId"]] = owner
            owner_map[c["name"]] = owner
    return owner_map


def _pid_container_id(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/cgroup").read_text(errors="ignore")
    except OSError:
        return None
    m = _CID_RE.search(raw)
    return m.group(1) if m else None


def _gpu_processes() -> dict[int, int]:
    """pid -> VRAM MiB used."""
    now = time.monotonic()
    if now - _gpu_cache["at"] < 5:
        return _gpu_cache["data"]
    data: dict[int, int] = {}
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        )
        if out.returncode == 0:
            for line in out.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 2 and parts[0].isdigit():
                    try:
                        data[int(parts[0])] = int(float(parts[1]))
                    except ValueError:
                        continue
    except Exception:
        data = {}
    _gpu_cache.update({"at": now, "data": data})
    return data


def _gpu_totals() -> dict[str, Any]:
    now = time.monotonic()
    if now - _gpu_cache.get("totalsAt", 0) < 5 and _gpu_cache.get("totals"):
        return _gpu_cache["totals"]
    out = {"name": "NVIDIA GPU unavailable", "utilPercent": 0, "vramUsedMiB": 0, "vramTotalMiB": 0, "tempC": 0}
    try:
        q = "name,utilization.gpu,memory.used,memory.total,temperature.gpu"
        res = subprocess.run(
            ["nvidia-smi", f"--query-gpu={q}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3,
        )
        if res.returncode == 0 and res.stdout.strip():
            parts = [p.strip() for p in res.stdout.strip().splitlines()[0].split(",")]
            out = {
                "name": parts[0],
                "utilPercent": int(float(parts[1])),
                "vramUsedMiB": int(float(parts[2])),
                "vramTotalMiB": int(float(parts[3])),
                "tempC": int(float(parts[4])),
            }
    except Exception:
        pass
    _gpu_cache["totals"] = out
    _gpu_cache["totalsAt"] = now
    return out


def _canonical_user(name: str, users: dict[str, dict[str, Any]]) -> str | None:
    if not name:
        return None
    entry = users.get(str(name).strip().casefold())
    return entry["username"] if entry else None


def _process_snapshot() -> tuple[dict[int, dict[str, Any]], dict[int, int]]:
    procs: dict[int, dict[str, Any]] = {}
    for proc in psutil.process_iter():
        try:
            info = proc.as_dict(attrs=["pid", "ppid", "name", "username", "cmdline", "cpu_percent", "memory_info"])
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        mem = info.get("memory_info")
        procs[info["pid"]] = {
            "pid": info["pid"],
            "ppid": info.get("ppid") or 0,
            "name": info.get("name") or "unknown",
            "osUser": info.get("username") or "",
            "command": (" ".join(info.get("cmdline") or []) or info.get("name") or "")[:400],
            "cpu": round(info.get("cpu_percent") or 0, 1),
            "rssMiB": round((mem.rss if mem else 0) / (1024 ** 2), 1),
        }
    return procs, _gpu_processes()


def _resolve(
    pid: int,
    procs: dict[int, dict[str, Any]],
    attr: dict[str, dict[str, Any]],
    owners_by_container: dict[str, str],
    patterns: list[dict[str, str]],
    os_map: dict[str, str],
    users: dict[str, dict[str, Any]],
) -> tuple[str | None, str]:
    """Return (dashboard username, attribution source)."""
    seen: set[int] = set()
    cur: int | None = pid
    while cur and cur not in seen:
        seen.add(cur)
        entry = attr.get(str(cur))
        if entry:
            user = _canonical_user(entry.get("user", ""), users) or entry.get("user")
            return user, entry.get("source") or "registry"
        row = procs.get(cur)
        cur = int(row["ppid"]) if row and row.get("ppid") else None

    cid = _pid_container_id(pid)
    if cid:
        for key, user in owners_by_container.items():
            if len(key) >= 12 and cid.startswith(key[: len(cid)]) and key == cid[: len(key)]:
                return _canonical_user(user, users) or user, "container-label"
        for key, user in owners_by_container.items():
            if len(key) >= 12 and cid.startswith(key):
                return _canonical_user(user, users) or user, "container-label"

    row = procs.get(pid)
    if row:
        haystack = f"{row['name']} {row['command']}".lower()
        for pat in patterns:
            match = str(pat.get("match") or "").lower().strip()
            if match and match in haystack:
                user = _canonical_user(pat.get("user", ""), users)
                if user:
                    return user, "pattern"
        os_user = str(row.get("osUser") or "")
        if os_user:
            mapped = os_map.get(os_user)
            if mapped:
                user = _canonical_user(mapped, users)
                if user:
                    return user, "os-account"
            # Exact match between an OS account and a dashboard username is real
            # evidence (e.g. the host account "tabahi" is dashboard user tabahi).
            # Service accounts and root are never auto-attributed.
            if os_user.casefold() in users and os_user.casefold() not in {"root", "nobody", "daemon"}:
                return users[os_user.casefold()]["username"], "os-account"
    return None, ""


def _active_sessions() -> dict[str, int]:
    counts: dict[str, int] = {}
    now = time.time()
    sessions = getattr(auth_mod, "_sessions", {}) or {}
    stale = [token for token, (expires, _u) in sessions.items() if expires <= now]
    for token in stale:
        sessions.pop(token, None)
    for _token, (expires, user) in list(sessions.items()):
        if expires <= now:
            continue
        key = user.username.casefold()
        counts[key] = counts.get(key, 0) + 1
    return counts


def _last_logins() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        events = read_events(600)
    except Exception:
        return out
    for evt in events:
        if str(evt.get("event", "")).startswith("auth.login.success"):
            actor = str(evt.get("actor", "")).casefold()
            if actor and actor not in out:
                out[actor] = str(evt.get("at", ""))
    return out


def _api_keys_by_user() -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    try:
        keys = _load_api_keys()
    except Exception:
        return out
    for key in keys:
        created_by = str(key.get("createdBy") or "").casefold()
        if not created_by:
            continue
        out.setdefault(created_by, []).append({
            "id": key.get("id"),
            "name": key.get("name"),
            "prefix": key.get("prefix"),
            "scopes": key.get("scopes") or [],
            "enabled": bool(key.get("enabled", True)),
            "usageCount": int(key.get("usageCount") or 0),
            "lastUsedAt": key.get("lastUsedAt"),
            "expiresAt": key.get("expiresAt"),
        })
    return out


def _build_usage() -> dict[str, Any]:
    users = auth_mod._load_users()
    attr = _prune(_load_attr())
    user_map = _load_map()
    owners_by_container = _container_owner_map()
    procs, gpu_pids = _process_snapshot()
    sessions = _active_sessions()
    last_logins = _last_logins()
    keys_by_user = _api_keys_by_user()
    patterns = [p for p in (user_map.get("patterns") or []) if isinstance(p, dict)]
    os_map = {str(k): str(v) for k, v in (user_map.get("os") or {}).items()}

    buckets: dict[str, dict[str, Any]] = {}
    for key, entry in users.items():
        buckets[key] = {
            "username": entry["username"],
            "displayName": entry["displayName"],
            "role": entry["role"],
            "activeSessions": sessions.get(key, 0),
            "lastLogin": last_logins.get(key),
            "processes": [],
            "containers": [],
            "apiKeys": keys_by_user.get(key, []),
            "cpuPercent": 0.0,
            "memMiB": 0.0,
            "gpuMiB": 0.0,
        }

    unattributed = {"processCount": 0, "cpuPercent": 0.0, "memMiB": 0.0, "gpuMiB": 0.0}
    gpu_rows: list[dict[str, Any]] = []

    for pid, row in procs.items():
        owner, source = _resolve(pid, procs, attr, owners_by_container, patterns, os_map, users)
        gpu_mib = gpu_pids.get(pid, 0)
        if gpu_mib:
            gpu_rows.append({
                "pid": pid,
                "name": row["name"],
                "vramMiB": gpu_mib,
                "owner": owner or None,
                "ownerSource": source or None,
            })
        if not owner:
            unattributed["processCount"] += 1
            unattributed["cpuPercent"] += row["cpu"]
            unattributed["memMiB"] += row["rssMiB"]
            unattributed["gpuMiB"] += gpu_mib
            continue
        bucket = buckets.get(owner.casefold())
        if not bucket:
            # attributed to a name that is not a dashboard account
            bucket = buckets.setdefault(owner.casefold(), {
                "username": owner, "displayName": owner, "role": "external",
                "activeSessions": 0, "lastLogin": None, "processes": [],
                "containers": [], "apiKeys": [], "cpuPercent": 0.0,
                "memMiB": 0.0, "gpuMiB": 0.0,
            })
        bucket["processes"].append({
            "pid": pid,
            "name": row["name"],
            "command": row["command"],
            "cpu": row["cpu"],
            "rssMiB": row["rssMiB"],
            "gpuMiB": gpu_mib,
            "osUser": row["osUser"],
            "source": source,
        })
        bucket["cpuPercent"] += row["cpu"]
        bucket["memMiB"] += row["rssMiB"]
        bucket["gpuMiB"] += gpu_mib

    for c in _docker_containers():
        owner = c.get("owner") or owners_by_container.get(c["name"]) or owners_by_container.get(c["shortId"])
        if not owner:
            continue
        bucket = buckets.get(str(owner).casefold())
        if not bucket:
            continue
        bucket["containers"].append({
            "name": c["name"],
            "state": c["state"],
            "managed": c.get("managed") or "",
        })

    out_users = []
    for bucket in buckets.values():
        bucket["processes"].sort(key=lambda p: (p["gpuMiB"], p["rssMiB"], p["cpu"]), reverse=True)
        bucket["cpuPercent"] = round(bucket["cpuPercent"], 1)
        bucket["memMiB"] = round(bucket["memMiB"], 1)
        bucket["processCount"] = len(bucket["processes"])
        bucket["gpuProcessCount"] = sum(1 for p in bucket["processes"] if p["gpuMiB"])
        out_users.append(bucket)
    out_users.sort(key=lambda u: (u["gpuMiB"], u["memMiB"], u["cpuPercent"]), reverse=True)

    for key in ("cpuPercent", "memMiB", "gpuMiB"):
        unattributed[key] = round(unattributed[key], 1)

    memory = psutil.virtual_memory()
    gpu_rows.sort(key=lambda r: r["vramMiB"], reverse=True)
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "users": out_users,
        "unattributed": unattributed,
        "gpuProcesses": gpu_rows,
        "gpu": _gpu_totals(),
        "host": {
            "cpuPercent": round(psutil.cpu_percent(interval=None), 1),
            "cpuCount": psutil.cpu_count() or 1,
            "memUsedMiB": round(memory.used / (1024 ** 2), 1),
            "memTotalMiB": round(memory.total / (1024 ** 2), 1),
            "processCount": len(procs),
        },
        "map": user_map,
    }


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------
class AssignRequest(BaseModel):
    kind: str = Field(pattern="^(container|pattern|os|pid)$")
    key: str = Field(min_length=1, max_length=200)
    user: str = Field(min_length=1, max_length=64)


@router.get("/usage")
def users_usage(request: Request):
    user = require_user(request)
    data = _build_usage()
    if user.role not in {"owner", "admin", "moderator"}:
        mine = [u for u in data["users"] if u["username"].casefold() == user.username.casefold()]
        data["users"] = mine
        data.pop("map", None)
    return data


@router.get("/usage/map")
def usage_map(request: Request):
    user = require_user(request)
    if user.role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="Not allowed")
    return _load_map()


@router.post("/usage/assign")
def usage_assign(payload: AssignRequest, request: Request):
    actor = require_user(request)
    if actor.role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="Not allowed")
    users = auth_mod._load_users()
    canonical = _canonical_user(payload.user, users)
    if not canonical:
        raise HTTPException(status_code=400, detail="Unknown dashboard user")
    key = payload.key.strip()
    with _lock:
        if payload.kind == "container":
            _load_map()["containers"][key] = canonical
            _save_map()
        elif payload.kind == "pattern":
            patterns = _load_map()["patterns"]
            patterns = [p for p in patterns if str(p.get("match", "")).lower() != key.lower()]
            patterns.append({"match": key, "user": canonical})
            _load_map()["patterns"] = patterns
            _save_map()
        elif payload.kind == "os":
            _load_map()["os"][key] = canonical
            _save_map()
        else:  # pid
            if not key.isdigit():
                raise HTTPException(status_code=400, detail="PID must be numeric")
            attribute_pid(int(key), canonical, label=f"manual:{key}", source="manual")
    _containers_cache["at"] = 0.0
    record("users.usage.assign", actor=actor.username, resource=key, action=payload.kind, result="success", detail={"user": canonical})
    return {"ok": True, "kind": payload.kind, "key": key, "user": canonical}


@router.delete("/usage/assign")
def usage_unassign(kind: str, key: str, request: Request):
    actor = require_user(request)
    if actor.role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="Not allowed")
    with _lock:
        if kind == "container":
            (_load_map()["containers"]).pop(key, None)
            _save_map()
        elif kind == "pattern":
            _load_map()["patterns"] = [
                p for p in _load_map()["patterns"] if str(p.get("match", "")).lower() != key.lower()
            ]
            _save_map()
        elif kind == "os":
            (_load_map()["os"]).pop(key, None)
            _save_map()
        elif kind == "pid":
            release_pid(int(key)) if key.isdigit() else None
        else:
            raise HTTPException(status_code=400, detail="Unknown kind")
    _containers_cache["at"] = 0.0
    record("users.usage.unassign", actor=actor.username, resource=key, action=kind, result="success")
    return {"ok": True}


def enrich_process_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Add ``owner``/``ownerSource`` to process rows returned by /processes."""
    try:
        users = auth_mod._load_users()
        attr = _prune(_load_attr())
        user_map = _load_map()
        owners_by_container = _container_owner_map()
        patterns = [p for p in (user_map.get("patterns") or []) if isinstance(p, dict)]
        os_map = {str(k): str(v) for k, v in (user_map.get("os") or {}).items()}
        procs = {
            int(r["pid"]): {"pid": int(r["pid"]), "ppid": int(r.get("ppid") or 0),
                            "name": r.get("name", ""), "command": r.get("command", ""),
                            "osUser": r.get("user", "")}
            for r in rows
        }
        for row in rows:
            owner, source = _resolve(int(row["pid"]), procs, attr, owners_by_container, patterns, os_map, users)
            row["owner"] = owner
            row["ownerSource"] = source or None
    except Exception:
        for row in rows:
            row.setdefault("owner", None)
            row.setdefault("ownerSource", None)
    return rows


def active_user_count() -> int:
    try:
        data = _build_usage()
    except Exception:
        return 0
    return sum(
        1 for u in data["users"]
        if u["activeSessions"] or u["processes"] or any(c["state"] == "running" for c in u["containers"])
    )
