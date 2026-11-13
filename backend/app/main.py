
import csv

import platform

import socket

import subprocess

import threading
import time
from collections import deque

from app.docker_readonly import DockerControlError, DockerInventoryError, control_container, get_containers
from pathlib import Path



import psutil

import os
import signal

from fastapi import FastAPI, HTTPException, Query, Request
from pydantic import BaseModel


from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.drive.nextcloud import DriveError
from app.drive.router import router as drive_router
from app.auth import AuthConfigError, current_user, router as auth_router
from app.apikeys import authenticate_bearer, disable_key, router as apikeys_router
from app.terminal import router as terminal_router
from app.s3store import router as s3_router
from app.modules_extra import router as modules_extra_router
from app.minecraft import router as minecraft_router
from app.minecraft_extra import router as minecraft_extra_router
from app.userusage import active_user_count, enrich_process_rows, router as userusage_router
from app.workspaces import router as workspaces_router
from app.jupyter_proxy import router as jupyter_proxy_router
from app.mcbackup import router as mcbackup_router
from app.playit import router as playit_router
from app.audit import check_key_anomaly, rate_limiter, read_events, record
from app.mcp_readonly import MCPWebSocketGuard, find_mcp_key, protect_mcp_key, router as mcp_readonly_router



app = FastAPI(title="KDG API", version="0.1.0")



app.add_middleware(

    CORSMiddleware,

    allow_origins=[

        "http://127.0.0.1:18081",

        "http://localhost:18081",

        "http://127.0.0.1:8081",

        "http://localhost:8081",

    ],

    allow_credentials=True,

    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],

    allow_headers=["*"],

)


@app.exception_handler(DriveError)
async def drive_error_handler(_, exc: DriveError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


@app.exception_handler(AuthConfigError)
async def auth_config_error_handler(_, exc: AuthConfigError):
    return JSONResponse(status_code=503, content={"error": {"code": "auth_not_configured", "message": str(exc)}})


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


@app.middleware("http")
async def protect_api(request: Request, call_next):
    path = request.url.path
    ip = _client_ip(request)
    authz = request.headers.get("authorization", "")
    mcp_key = find_mcp_key(authz)
    if mcp_key:
        return await protect_mcp_key(request, mcp_key, call_next)
    public = path in {"/api/v1/health", "/api/v1/auth/login", "/api/v1/auth/session", "/api/v1/auth/logout"}
    if path.startswith("/api/v1/") and not public and request.method != "OPTIONS":
        # general per-IP rate limit (skip the embedded JupyterLab proxy; Lab issues
        # frequent asset/kernel requests and must stay responsive for one user)
        if not path.startswith("/api/v1/workspaces/jupyter/"):
            allowed, retry = rate_limiter.allow(f"api:ip:{ip}", limit=600, window_seconds=60)
            if not allowed:
                record("api.rate_limited", actor="ip", action=request.method, resource=path, result="denied", ip=ip, detail={"retryAfter": retry})
                return JSONResponse(status_code=429, content={"error": {"code": "rate_limited", "message": "Too many requests. Try again later."}})

        if not current_user(request):
            authz = request.headers.get("authorization", "")
            if authz.lower().startswith("bearer "):
                token = authz.split(" ", 1)[1].strip()
                key = authenticate_bearer(token)
                if key:
                    # per-key rate limit and anomaly detection
                    kid = str(key.get("id") or key.get("prefix") or "unknown")
                    k_allowed, kretry = rate_limiter.allow(f"api:key:{kid}", limit=300, window_seconds=60)
                    if not k_allowed:
                        record("api.key.rate_limited", actor=f"apikey:{kid}", action=request.method, resource=path, result="denied", ip=ip, detail={"retryAfter": kretry})
                        return JSONResponse(status_code=429, content={"error": {"code": "rate_limited", "message": "API key rate limit exceeded."}})
                    anomalous = check_key_anomaly(kid, limit_per_minute=300)
                    if anomalous:
                        # severe burst auto-disable threshold
                        from app.audit import _key_windows
                        with __import__('threading').Lock():
                            pass
                        record("api.key.anomaly", actor=f"apikey:{kid}", action=request.method, resource=path, result="warning", ip=ip, detail={"reason": "high_request_rate"})
                    # auto-disable on extreme burst (protect against leaked/abused key)
                    try:
                        from app.audit import _key_windows, _key_anom_lock
                        with _key_anom_lock:
                            q = _key_windows.get(kid)
                            count = len(q) if q else 0
                        if count > 600:
                            if disable_key(kid, "auto-disabled: extreme request burst"):
                                record("api.key.auto_disabled", actor=f"apikey:{kid}", action=request.method, resource=path, result="success", ip=ip, detail={"count_per_minute": count})
                                return JSONResponse(status_code=403, content={"error": {"code": "api_key_disabled", "message": "API key automatically disabled due to unusual activity."}})
                    except Exception:
                        pass
                    request.state.api_key = key
                else:
                    record("auth.apikey.failure", actor="apikey", action=request.method, resource=path, result="denied", ip=ip)
                    return JSONResponse(status_code=401, content={"error": {"code": "authentication_required", "message": "Invalid or disabled API key"}})
            else:
                # avoid noisy audit spam from anonymous/SSR probes; real security events are recorded elsewhere
                if request.method not in {"GET", "HEAD", "OPTIONS"}:
                    record("auth.required", actor="anonymous", action=request.method, resource=path, result="denied", ip=ip)
                return JSONResponse(status_code=401, content={"error": {"code": "authentication_required", "message": "Authentication required"}})
    return await call_next(request)


app.include_router(auth_router, prefix="/api/v1")
app.include_router(drive_router, prefix="/api/v1")
app.include_router(apikeys_router, prefix="/api/v1")
app.include_router(terminal_router)
app.include_router(s3_router, prefix="/api/v1")
app.include_router(modules_extra_router, prefix="/api/v1")
app.include_router(minecraft_router, prefix="/api/v1")
app.include_router(minecraft_extra_router, prefix="/api/v1")
app.include_router(mcbackup_router, prefix="/api/v1")
app.include_router(playit_router, prefix="/api/v1")
app.include_router(userusage_router, prefix="/api/v1")
app.include_router(workspaces_router, prefix="/api/v1")
app.include_router(jupyter_proxy_router, prefix="/api/v1")
app.include_router(mcp_readonly_router, prefix="/api/v1")
app.add_middleware(MCPWebSocketGuard)



_gpu_cache = {"at": 0.0, "data": None}

_net_previous = None

_io_previous = {}

_metrics_history: deque[dict] = deque(maxlen=5760)  # ~24h at 15s
_metrics_lock = threading.Lock()
_metrics_sampler_started = False


def _sample_metrics_once():
    try:
        cpu = round(psutil.cpu_percent(interval=None), 1)
        mem = psutil.virtual_memory()
        mem_pct = round(mem.percent, 1)
        up, down = network_rates()
        sample = {
            "t": int(time.time() * 1000),
            "cpu": cpu,
            "mem": mem_pct,
            "memUsedGiB": round(mem.used / (1024 ** 3), 2),
            "netUpMbps": up,
            "netDownMbps": down,
        }
        with _metrics_lock:
            _metrics_history.append(sample)
    except Exception:
        pass


def _metrics_sampler_loop():
    # prime cpu_percent
    try:
        psutil.cpu_percent(interval=None)
    except Exception:
        pass
    while True:
        _sample_metrics_once()
        time.sleep(15)


@app.on_event("startup")
def _start_metrics_sampler():
    global _metrics_sampler_started
    if _metrics_sampler_started:
        return
    _metrics_sampler_started = True
    _sample_metrics_once()
    threading.Thread(target=_metrics_sampler_loop, daemon=True, name="kdg-metrics").start()





def number(value):

    try:

        return float(value)

    except (TypeError, ValueError):

        return None





def os_name():

    try:

        for line in Path("/etc/os-release").read_text().splitlines():

            if line.startswith("PRETTY_NAME="):

                return line.split("=", 1)[1].strip().strip('"')

    except OSError:

        pass

    return platform.platform()





def cpu_model():

    try:

        for line in Path("/proc/cpuinfo").read_text().splitlines():

            if line.lower().startswith("model name"):

                return line.split(":", 1)[1].strip()

    except (OSError, IndexError):

        pass

    return platform.processor() or "Unknown CPU"





def gpu_info():

    now = time.monotonic()

    if _gpu_cache["data"] is not None and now - _gpu_cache["at"] < 5:

        return _gpu_cache["data"]



    result = {

        "name": "NVIDIA GPU unavailable",

        "driver": "N/A",

        "cuda": "N/A",

        "utilPercent": 0,

        "vramUsedMiB": 0,

        "vramTotalMiB": 0,

        "tempC": 0,

        "powerW": None,

        "powerLimitW": None,

        "processes": [],

    }



    try:

        query = (

            "name,driver_version,utilization.gpu,memory.used,memory.total,"

            "temperature.gpu,power.draw,power.limit"

        )

        output = subprocess.run(

            ["nvidia-smi", f"--query-gpu={query}",

             "--format=csv,noheader,nounits"],

            capture_output=True, text=True, timeout=3, check=True,

        ).stdout.strip()



        row = next(csv.reader([output], skipinitialspace=True))

        result.update({

            "name": row[0],

            "driver": row[1],

            "utilPercent": int(number(row[2]) or 0),

            "vramUsedMiB": int(number(row[3]) or 0),

            "vramTotalMiB": int(number(row[4]) or 0),

            "tempC": int(number(row[5]) or 0),

            "powerW": number(row[6]),

            "powerLimitW": number(row[7]),

        })



        proc_query = "pid,process_name,used_memory"

        proc_output = subprocess.run(

            ["nvidia-smi", f"--query-compute-apps={proc_query}",

             "--format=csv,noheader,nounits"],

            capture_output=True, text=True, timeout=3, check=True,

        ).stdout.strip()



        if proc_output and "No running processes" not in proc_output:

            for proc_row in csv.reader(proc_output.splitlines(), skipinitialspace=True):

                if len(proc_row) >= 3:

                    result["processes"].append({

                        "pid": int(proc_row[0]),

                        "name": proc_row[1],

                        "vramMiB": int(number(proc_row[2]) or 0),

                        "utilPercent": None,

                    })



    except (OSError, subprocess.SubprocessError, ValueError, IndexError):

        pass



    _gpu_cache.update({"at": now, "data": result})

    return result





def network_rates():

    global _net_previous

    counters = psutil.net_io_counters()

    now = time.monotonic()



    if _net_previous is None:

        _net_previous = (now, counters.bytes_sent, counters.bytes_recv)

        return 0.0, 0.0



    old_time, old_sent, old_recv = _net_previous

    elapsed = max(now - old_time, 0.001)

    upload = max(0, counters.bytes_sent - old_sent) * 8 / elapsed / 1_000_000

    download = max(0, counters.bytes_recv - old_recv) * 8 / elapsed / 1_000_000

    _net_previous = (now, counters.bytes_sent, counters.bytes_recv)

    return round(upload, 2), round(download, 2)





@app.get("/api/v1/health")

def health():

    return {"ok": True, "service": "kdg-api"}





@app.get("/api/v1/overview")

def overview():

    memory = psutil.virtual_memory()

    swap = psutil.swap_memory()

    disk = psutil.disk_usage("/")
    data_disk = psutil.disk_usage("/srv/kdg") if os.path.exists("/srv/kdg") else disk
    gpu = gpu_info()

    upload, download = network_rates()

    containers = get_containers()
    return {

        "hostname": socket.gethostname(),

        "online": True,

        "os": os_name(),

        "cpuModel": cpu_model(),

        "uptimeSeconds": int(time.time() - psutil.boot_time()),

        "cpuPercent": round(psutil.cpu_percent(interval=None), 1),

        "memUsedGiB": round(memory.used / (1024 ** 3), 2),

        "memTotalGiB": round(memory.total / (1024 ** 3), 2),

        "swapUsedGiB": round(swap.used / (1024 ** 3), 2),

        "swapTotalGiB": round(swap.total / (1024 ** 3), 2),

        "diskUsedGiB": round(disk.used / (1024 ** 3), 2),

        "diskTotalGiB": round(disk.total / (1024 ** 3), 2),

        "dataDiskUsedGiB": round(data_disk.used / (1024 ** 3), 2),
        "dataDiskTotalGiB": round(data_disk.total / (1024 ** 3), 2),
        "netUpMbps": upload,

        "netDownMbps": download,

        "gpu": {

            "utilPercent": gpu["utilPercent"],

            "vramUsedMiB": gpu["vramUsedMiB"],

            "vramTotalMiB": gpu["vramTotalMiB"],

            "tempC": gpu["tempC"],

        },

        "runningContainers": sum(1 for item in containers if item["state"] == "running"),

        "runningApps": 0,

        "activeUsers": active_user_count(),

        "alerts": [],

    }





@app.get("/api/v1/gpu")

def gpu():

    return gpu_info()





@app.get("/api/v1/processes")

def processes(sort: str = Query(default="memory", pattern="^(cpu|memory)$")):

    now = time.monotonic()

    rows = []



    for proc in psutil.process_iter():

        try:

            info = proc.as_dict(attrs=[

                "pid", "ppid", "name", "username", "status",

                "memory_info", "memory_percent", "cmdline", "cpu_percent",

                "io_counters",

            ])



            pid = info["pid"]

            io = info.get("io_counters")

            previous = _io_previous.get(pid)

            read_rate = write_rate = 0.0



            if io and previous:

                elapsed = max(now - previous[0], 0.001)

                read_rate = max(0, io.read_bytes - previous[1]) / elapsed / 1024

                write_rate = max(0, io.write_bytes - previous[2]) / elapsed / 1024



            if io:

                _io_previous[pid] = (now, io.read_bytes, io.write_bytes)



            memory_info = info.get("memory_info")

            rss = memory_info.rss if memory_info else 0

            raw_status = info.get("status", "sleeping")

            status_map = {

                "running": "R",

                "sleeping": "S",

                "disk-sleep": "D",

                "zombie": "Z",

                "idle": "I",

            }



            try:

                cgroup = Path(f"/proc/{pid}/cgroup").read_text().strip().splitlines()

                cgroup_name = cgroup[-1].split(":")[-1].strip("/") if cgroup else ""

                unit = next(

                    (part for part in cgroup_name.split("/")

                     if part.endswith((".service", ".scope"))),

                    None,

                )

            except (OSError, IndexError):

                cgroup_name = ""

                unit = None



            command = " ".join(info.get("cmdline") or []) or info.get("name") or ""



            rows.append({

                "pid": pid,

                "ppid": info.get("ppid") or 0,

                "name": info.get("name") or "unknown",

                "user": info.get("username") or "unknown",

                "cpu": round(info.get("cpu_percent") or 0, 1),

                "memPercent": round(info.get("memory_percent") or 0, 1),

                "rssMiB": round(rss / (1024 ** 2), 1),

                "readKBs": round(read_rate, 1),

                "writeKBs": round(write_rate, 1),

                "cgroup": cgroup_name,

                "unit": unit,

                "status": status_map.get(raw_status, "S"),

                "command": command[:500],

            })



        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):

            continue



    _io_previous_keys = set(_io_previous)

    current_pids = {row["pid"] for row in rows}

    for stale_pid in _io_previous_keys - current_pids:

        _io_previous.pop(stale_pid, None)



    key = "cpu" if sort == "cpu" else "rssMiB"

    rows = enrich_process_rows(rows)

    rows.sort(key=lambda row: row[key], reverse=True)

    return rows[:250]





@app.get("/api/v1/containers")
def containers_endpoint():
    try:
        return get_containers(strict=True)
    except DockerInventoryError as exc:
        return JSONResponse(status_code=502, content={"error": {"code": "docker_inventory_unavailable", "message": str(exc)}})


def _has_control_access(request: Request) -> bool:
    user = current_user(request)
    if user and user.role in {"owner", "admin"}:
        return True
    key = getattr(request.state, "api_key", None)
    if key and (set(key.get("scopes") or []) & {"admin", "control", "write"}):
        return True
    return False


class ContainerActionRequest(BaseModel):
    action: str


@app.post("/api/v1/containers/{container_id}/action")
def container_action(container_id: str, payload: ContainerActionRequest, request: Request):
    if not _has_control_access(request):
        record("container.action", actor=getattr(current_user(request), 'username', 'apikey'), resource=container_id, action=payload.action, result="denied", ip=_client_ip(request))
        raise HTTPException(status_code=403, detail="Not allowed")
    try:
        result = control_container(container_id, payload.action)
        record("container.action", actor=getattr(current_user(request), 'username', 'apikey'), resource=container_id, action=payload.action, result="success", ip=_client_ip(request))
        _op_user = current_user(request)
        if _op_user:
            try:
                from app.userusage import attribute_container
                attribute_container(container_id, _op_user.username)
            except Exception:
                pass
        return result
    except DockerControlError as exc:
        record("container.action", actor=getattr(current_user(request), 'username', 'apikey'), resource=container_id, action=payload.action, result="error", ip=_client_ip(request), detail={"error": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc))


class ProcessSignalRequest(BaseModel):
    signal: str = "TERM"


@app.post("/api/v1/processes/{pid}/signal")
def signal_process(pid: int, payload: ProcessSignalRequest, request: Request):
    if not _has_control_access(request):
        record("process.signal", actor=getattr(current_user(request), 'username', 'apikey'), resource=str(pid), action=payload.signal.upper(), result="denied", ip=_client_ip(request))
        raise HTTPException(status_code=403, detail="Not allowed")
    if pid <= 1 or pid == os.getpid():
        raise HTTPException(status_code=400, detail="Refusing to signal this process")
    sig = signal.SIGTERM if payload.signal.upper() == "TERM" else signal.SIGKILL if payload.signal.upper() == "KILL" else None
    if sig is None:
        raise HTTPException(status_code=400, detail="Unsupported signal")
    try:
        os.kill(pid, sig)
        record("process.signal", actor=getattr(current_user(request), 'username', 'apikey'), resource=str(pid), action=payload.signal.upper(), result="success", ip=_client_ip(request))
    except ProcessLookupError:
        record("process.signal", actor=getattr(current_user(request), 'username', 'apikey'), resource=str(pid), action=payload.signal.upper(), result="error", ip=_client_ip(request), detail={"error": "not_found"})
        raise HTTPException(status_code=404, detail="Process not found")
    except PermissionError:
        record("process.signal", actor=getattr(current_user(request), 'username', 'apikey'), resource=str(pid), action=payload.signal.upper(), result="error", ip=_client_ip(request), detail={"error": "permission_denied"})
        raise HTTPException(status_code=403, detail="Permission denied")
    return {"ok": True, "pid": pid, "signal": payload.signal.upper()}


@app.get("/api/v1/metrics/history")
def metrics_history(minutes: int = Query(default=360, ge=1, le=1440)):
    cutoff = int(time.time() * 1000) - minutes * 60 * 1000
    with _metrics_lock:
        data = [s for s in _metrics_history if s.get("t", 0) >= cutoff]
    # downsample if too many points for frontend
    if len(data) > 360:
        step = max(1, len(data) // 360)
        data = data[::step]
    return {"samples": data, "count": len(data)}


def _svc_unit_active(name: str) -> bool:
    try:
        r = subprocess.run(["systemctl", "is-active", name], capture_output=True, text=True, timeout=3)
        return r.stdout.strip() == "active"
    except Exception:
        return False


@app.get("/api/v1/services")
def services():
    try:
        containers = get_containers(strict=True)
    except Exception:
        containers = []
    cmap = {str(c.get("name", "")).lower(): c for c in containers}

    def cstate(name: str) -> str:
        c = cmap.get(name.lower())
        if not c:
            return "installed-stopped"
        st = str(c.get("state", "")).lower()
        if st == "running":
            return "installed-running"
        if st in {"restarting"}:
            return "installed-running"
        return "installed-stopped"

    items = [
        {"id": "nextcloud", "name": "Nextcloud", "category": "Files and collaboration", "description": "Files, sharing and collaboration (Nextcloud app, DB, Redis).", "status": cstate("kdg-nextcloud"), "access": ["owner", "admin", "moderator"], "url": "/nextcloud"},
        {"id": "kdg-drive", "name": "KDG Drive", "category": "Files and collaboration", "description": "Dashboard-integrated Drive backed by Nextcloud WebDAV/OCS.", "status": "installed-running" if _svc_unit_active("kdg-api.service") else "installed-stopped", "access": ["owner", "admin", "moderator"], "url": "/kdg-drive"},
        {"id": "kdg-api", "name": "KDG API", "category": "Core platform", "description": "FastAPI backend for dashboard, auth, Drive, metrics and controls.", "status": "installed-running" if _svc_unit_active("kdg-api.service") else "installed-stopped", "access": ["owner", "admin"]},
        {"id": "kdg-frontend", "name": "KDG Dashboard", "category": "Core platform", "description": "KDG Cloud Console web frontend.", "status": "installed-running" if _svc_unit_active("kdg-frontend.service") else "installed-stopped", "access": ["owner", "admin", "moderator"], "url": "/"},
        {"id": "traefik", "name": "Traefik", "category": "Networking", "description": "Reverse proxy and routing for KDG services.", "status": cstate("kdg-traefik"), "access": ["owner", "admin"]},
        {"id": "netdata", "name": "Netdata", "category": "Monitoring", "description": "Real-time system and performance monitoring.", "status": "installed-running" if _svc_unit_active("netdata.service") else "installed-stopped", "access": ["owner", "admin"]},
        {"id": "docker", "name": "Docker Engine", "category": "Infrastructure", "description": "Container runtime for KDG workloads.", "status": "installed-running" if _svc_unit_active("docker.service") else "installed-stopped", "access": ["owner", "admin"]},
        {"id": "tailscale", "name": "Tailscale", "category": "Networking", "description": "Secure remote access and Funnel/public endpoint.", "status": "installed-running" if _svc_unit_active("tailscaled.service") else "installed-stopped", "access": ["owner", "admin"]},
        {"id": "cockpit", "name": "Cockpit", "category": "Management", "description": "Web-based server administration interface.", "status": "installed-running" if _svc_unit_active("cockpit.service") else "installed-stopped", "access": ["owner", "admin"]},
    ]
    return items





@app.get("/api/v1/audit")
def audit(limit: int = Query(default=100, ge=1, le=500)):
    events = read_events(limit)
    filtered = [e for e in events if not (e.get("event") == "auth.required" and e.get("actor") == "anonymous")]
    return filtered[:limit]
