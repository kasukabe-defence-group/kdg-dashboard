import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from app.auth import _sessions, current_user, require_user, _users_file
from app.audit import read_events

router = APIRouter(tags=["modules"])


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _require_admin(request: Request):
    user = require_user(request)
    if user.role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="Not allowed")
    return user


def _docker_proxy_get(path: str):
    # try to discover/reach docker socket proxy similar to docker_readonly
    candidates = [
        os.getenv("KDG_DOCKER_PROXY", "http://127.0.0.1:2376").rstrip("/"),
        "http://127.0.0.1:2376",
        "http://172.20.0.2:2375",
        "http://172.20.0.3:2375",
    ]
    # discover socket-proxy IP via docker CLI if possible (may fail under NoNewPrivileges/sudo)
    try:
        r = subprocess.run(["/usr/bin/docker", "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", "kdg-socket-proxy"], capture_output=True, text=True, timeout=5)
        for ip in (r.stdout or "").split():
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
                candidates.append(f"http://{ip}:2375")
    except Exception:
        pass
    seen = set()
    last = None
    for base in candidates:
        if not base or base in seen:
            continue
        seen.add(base)
        try:
            req = urllib.request.Request(f"{base}{path}", headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=3) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last = e
    raise RuntimeError(f"docker proxy unavailable: {last}")


@router.get("/networks")
def networks(request: Request):
    require_user(request)
    try:
        data = _docker_proxy_get("/networks")
        items = []
        for n in (data or []):
            items.append({
                "id": (n.get("Id") or "")[:12],
                "name": n.get("Name", ""),
                "driver": n.get("Driver", ""),
                "scope": n.get("Scope", ""),
            })
        items.sort(key=lambda x: x.get("name", ""))
        return items
    except Exception:
        # fallback to sudo docker (works when allowed)
        try:
            r = subprocess.run(["/usr/bin/sudo", "-n", "/usr/bin/docker", "network", "ls", "--format", "{{json .}}"], capture_output=True, text=True, timeout=8)
            items = []
            for line in (r.stdout or "").splitlines():
                try:
                    obj = json.loads(line.strip())
                    items.append({"id": obj.get("ID", ""), "name": obj.get("Name", ""), "driver": obj.get("Driver", ""), "scope": obj.get("Scope", "")})
                except Exception:
                    pass
            return items
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Docker networks unavailable: {e}")


def _read_traefik_files() -> list[dict[str, Any]]:
    base = Path("/opt/kdg/config/traefik")
    files = []
    try:
        if base.exists():
            for p in sorted(base.iterdir()):
                if p.is_file() and p.suffix in {".yml", ".yaml"}:
                    try:
                        files.append({"name": p.name, "path": str(p), "content": p.read_text(encoding="utf-8", errors="replace")})
                    except Exception:
                        pass
    except Exception:
        pass
    return files


def _parse_traefik_routes(files: list[dict[str, Any]]) -> dict[str, Any]:
    routers = []
    middlewares = []
    services = []
    for f in files:
        content = f.get("content", "")
        section = None
        current_name = None
        mw_list_mode = False
        for raw in content.splitlines():
            line = raw.rstrip()
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            indent = len(line) - len(line.lstrip(' '))
            if line.startswith('  routers:'):
                section = 'routers'; current_name = None; mw_list_mode = False; continue
            if line.startswith('  middlewares:'):
                section = 'middlewares'; current_name = None; mw_list_mode = False; continue
            if line.startswith('  services:'):
                section = 'services'; current_name = None; mw_list_mode = False; continue
            if line.startswith('http:') or line.startswith('tcp:'):
                section = None; continue
            if section and indent == 4 and s.endswith(':'):
                current_name = s[:-1]
                mw_list_mode = False
                if section == 'routers':
                    routers.append({"name": current_name, "file": f.get("name"), "rule": None, "entryPoints": [], "priority": None, "service": None, "middlewares": []})
                elif section == 'middlewares':
                    middlewares.append({"name": current_name, "file": f.get("name"), "type": None})
                elif section == 'services':
                    services.append({"name": current_name, "file": f.get("name"), "url": None})
                continue
            if section == 'routers' and routers and current_name == routers[-1]["name"]:
                r = routers[-1]
                if s.startswith('rule:'):
                    r["rule"] = s.split(':',1)[1].strip().strip('"').strip("'")
                    mw_list_mode = False
                elif s.startswith('priority:'):
                    try: r["priority"] = int(s.split(':',1)[1].strip())
                    except: pass
                    mw_list_mode = False
                elif s.startswith('service:'):
                    r["service"] = s.split(':',1)[1].strip().strip('"').strip("'")
                    mw_list_mode = False
                elif s == 'middlewares:':
                    mw_list_mode = True
                elif s == 'entryPoints:':
                    mw_list_mode = False
                elif s.startswith('- ') and mw_list_mode:
                    r["middlewares"].append(s[2:].strip())
                elif s.startswith('- ') and not mw_list_mode:
                    # likely entrypoint
                    ep = s[2:].strip().strip('"').strip("'")
                    if ep and ep not in r["entryPoints"]:
                        r["entryPoints"].append(ep)
                else:
                    mw_list_mode = False
            if section == 'services' and services and current_name == services[-1]["name"]:
                if s.startswith('- url:'):
                    services[-1]["url"] = s.split('- url:',1)[1].strip().strip('"').strip("'")
            if section == 'middlewares' and middlewares and current_name == middlewares[-1]["name"]:
                if indent == 6 and s.endswith(':') and middlewares[-1]["type"] is None:
                    middlewares[-1]["type"] = s[:-1]
    return {"routers": routers, "middlewares": middlewares, "services": services, "files": [{"name": f.get("name"), "path": f.get("path")} for f in files]}


def _traefik_container_info():
    info = {"name": "kdg-traefik", "status": "unknown", "image": ""}
    try:
        # try socket proxy containers list
        containers = _docker_proxy_get("/containers/json?all=1")
        for c in containers or []:
            names = [n.lstrip('/') for n in (c.get('Names') or [])]
            if 'kdg-traefik' in names:
                info["status"] = c.get("State") or "unknown"
                info["image"] = c.get("Image") or ""
                return info
    except Exception:
        pass
    try:
        r = subprocess.run(["/usr/bin/sudo", "-n", "/usr/bin/docker", "inspect", "kdg-traefik", "--format", "{{.State.Status}}|{{.Config.Image}}"], capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            parts = r.stdout.strip().split("|", 1)
            info["status"] = parts[0]
            info["image"] = parts[1] if len(parts)>1 else ""
    except Exception:
        pass
    return info


@router.get("/reverse-proxy")
def reverse_proxy(request: Request):
    require_user(request)
    files = _read_traefik_files()
    parsed = _parse_traefik_routes(files)
    traefik = _traefik_container_info()
    return {
        "provider": "Traefik",
        "container": traefik,
        "entryPoints": [{"name": "web", "address": ":80", "ports": ["0.0.0.0:8080->80", "127.0.0.1:18080->80"]}],
        "providers": ["docker (socket-proxy)", "file (/opt/kdg/config/traefik)"],
        "configFiles": parsed.get("files", []),
        "routersCount": len(parsed.get("routers", [])),
        "servicesCount": len(parsed.get("services", [])),
        "middlewaresCount": len(parsed.get("middlewares", [])),
        "notes": [
            "Traefik routes dashboard/API and Nextcloud paths on port 8080 (LAN/Tailscale).",
            "Public HTTPS is provided by Tailscale Funnel in front of local services.",
        ],
    }


@router.get("/domains-routes")
def domains_routes(request: Request):
    require_user(request)
    files = _read_traefik_files()
    parsed = _parse_traefik_routes(files)
    domains = [
        {"host": "kasukabedefensegroup.taila4fe10.ts.net", "type": "Tailscale Funnel (public HTTPS)", "port": 8443, "notes": "Public dashboard/API/terminal access"},
        {"host": "192.168.1.18", "type": "LAN", "port": 8080, "notes": "Local network access via Traefik"},
        {"host": "100.119.120.20", "type": "Tailscale IP", "port": 8080, "notes": "Tailnet access via Traefik"},
    ]
    return {"domains": domains, "routes": parsed.get("routers", []), "middlewares": parsed.get("middlewares", []), "services": parsed.get("services", [])}


@router.get("/sessions")
def sessions(request: Request):
    _require_admin(request)
    now = time.time()
    items = []
    for token, (expires_at, u) in list(_sessions.items()):
        if expires_at <= now:
            continue
        items.append({"username": u.username, "displayName": u.displayName, "role": u.role, "expiresAt": int(expires_at), "current": (current_user(request).username == u.username if current_user(request) else False)})
    items.sort(key=lambda x: (not x.get("current"), -x.get("expiresAt", 0)))
    return {"sessions": items, "count": len(items)}


@router.get("/roles")
def roles(request: Request):
    require_user(request)
    defs = [
        {"role": "owner", "description": "Full control over dashboard, infrastructure actions, users, keys, and sensitive operations.", "capabilities": ["all"]},
        {"role": "admin", "description": "Administrative access to manage services, containers, users/keys (as permitted), and operations.", "capabilities": ["read", "write", "drive", "control", "manage_keys"]},
        {"role": "moderator", "description": "Operational access for day-to-day management without full administrative control.", "capabilities": ["read", "write", "drive"]},
        {"role": "member", "description": "Standard access for using allowed services and resources.", "capabilities": ["read"]},
    ]
    counts = {"owner": 0, "admin": 0, "moderator": 0, "member": 0}
    try:
        raw = json.loads(_users_file().read_text(encoding="utf-8"))
        if isinstance(raw, list):
            for e in raw:
                r = str((e or {}).get("role", "")).strip()
                if r in counts:
                    counts[r] += 1
    except Exception:
        pass
    for d in defs:
        d["userCount"] = counts.get(d["role"], 0)
    return defs


@router.get("/security/summary")
def security_summary(request: Request):
    _require_admin(request)
    events = read_events(200)
    failed_logins = [e for e in events if e.get("event") in {"auth.login.failure", "auth.login.blocked", "auth.login.rate_limited"}]
    denied = [e for e in events if e.get("result") == "denied"]
    key_events = [e for e in events if str(e.get("event", "")).startswith("api.key")]
    return {"activeSessions": sum(1 for _, (exp, _) in _sessions.items() if exp > time.time()), "recentFailedLogins": failed_logins[:20], "recentDenied": denied[:20], "keyEvents": key_events[:20], "totals": {"eventsScanned": len(events), "failedLogins": len(failed_logins), "denied": len(denied)}}


@router.get("/storage/analytics")
def storage_analytics(request: Request):
    require_user(request)
    fs = []
    try:
        import psutil
        wanted = ["/", "/srv/kdg", "/home"]
        seen = set()
        for p in psutil.disk_partitions(all=False):
            if p.mountpoint not in wanted and not p.mountpoint.startswith("/srv"):
                continue
            if p.mountpoint in seen:
                continue
            seen.add(p.mountpoint)
            try:
                u = psutil.disk_usage(p.mountpoint)
                fs.append({"mount": p.mountpoint, "device": p.device, "fstype": p.fstype, "totalBytes": u.total, "usedBytes": u.used, "freeBytes": u.free, "percent": u.percent})
            except Exception:
                pass
    except Exception:
        pass
    s3 = {"buckets": 0, "objects": 0, "sizeBytes": 0}
    try:
        from app.s3store import ROOT as S3ROOT
        if S3ROOT.exists():
            for b in S3ROOT.iterdir():
                if b.is_dir():
                    s3["buckets"] += 1
                    for r, _, files in os.walk(b):
                        for f in files:
                            try:
                                st = os.stat(os.path.join(r, f))
                                s3["objects"] += 1
                                s3["sizeBytes"] += st.st_size
                            except Exception:
                                pass
    except Exception:
        pass
    return {"filesystems": fs, "s3": s3}


@router.get("/endpoints")
def endpoints(request: Request):
    require_user(request)
    return {
        "public": {"dashboard": "https://kasukabedefensegroup.taila4fe10.ts.net:8443/", "api": "https://kasukabedefensegroup.taila4fe10.ts.net:8443/api/v1", "health": "https://kasukabedefensegroup.taila4fe10.ts.net:8443/api/v1/health", "terminalWs": "wss://kasukabedefensegroup.taila4fe10.ts.net:8443/api/v1/terminal/ws", "provider": "Tailscale Funnel"},
        "lan": {"dashboard": "http://192.168.1.18:8080", "api": "http://192.168.1.18:8080/api/v1"},
        "tailscale": {"dashboard": "http://100.119.120.20:8080", "api": "http://100.119.120.20:8080/api/v1"},
        "notes": ["Traefik routes / and /api/v1 on port 8080 to frontend/API.", "Public HTTPS is provided via Tailscale Funnel (no Tailscale client required for visitors)."],
    }
