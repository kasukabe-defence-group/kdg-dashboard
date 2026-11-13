import json
import os
import re
import subprocess
import urllib.request

DOCKER_PROXY = os.getenv("KDG_DOCKER_PROXY", "http://127.0.0.1:2376")
_CONTAINER_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
_last_proxy = None


class DockerInventoryError(Exception):
    pass


class DockerControlError(Exception):
    pass


def _proxy_candidates():
    cands = []
    for v in [DOCKER_PROXY, "http://127.0.0.1:2376", "http://172.20.0.2:2375", "http://172.20.0.3:2375"]:
        v = (v or "").strip().rstrip("/")
        if v and v not in cands:
            cands.append(v)
    # try to discover current socket-proxy IP on docker network
    try:
        out = _run_docker(["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", "kdg-socket-proxy"]).strip()
        for ip in out.split():
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
                v = f"http://{ip}:2375"
                if v not in cands:
                    cands.append(v)
    except Exception:
        pass
    # prefer last working
    global _last_proxy
    if _last_proxy and _last_proxy in cands:
        cands.remove(_last_proxy)
        cands.insert(0, _last_proxy)
    return cands


def get_containers(*, strict: bool = False):
    global _last_proxy
    last_err = None
    for proxy in _proxy_candidates():
        url = f"{proxy}/containers/json?all=1"
        request = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                containers = json.loads(response.read().decode("utf-8"))
            _last_proxy = proxy
            return [
                {
                    "id": item.get("Id", "")[:12],
                    "name": (item.get("Names") or ["/unknown"])[0].lstrip("/"),
                    "image": item.get("Image", ""),
                    "state": item.get("State", "unknown"),
                    "status": item.get("Status", ""),
                }
                for item in containers
            ]
        except Exception as exc:
            last_err = exc
            continue
    if strict:
        raise DockerInventoryError(f"Cannot reach Docker socket proxy (tried configured/discovered endpoints)") from last_err
    return []


def _run_docker(args: list[str]) -> str:
    env = os.environ.copy()
    sudo_pw = os.getenv("KDG_SUDO_PASSWORD", "")
    try:
        p = subprocess.run(["docker", *args], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30, env=env)
        if p.returncode == 0:
            return p.stdout
        if sudo_pw:
            p2 = subprocess.run(["sudo", "-S", "-p", "", "docker", *args], input=sudo_pw + "\n", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=30, env=env)
            if p2.returncode == 0:
                return p2.stdout
            raise DockerControlError((p2.stdout or p.stdout or "Docker command failed").strip()[:300])
        raise DockerControlError((p.stdout or "Docker command failed").strip()[:300])
    except subprocess.TimeoutExpired as exc:
        raise DockerControlError("Docker command timed out.") from exc


def control_container(container: str, action: str) -> dict:
    if action not in {"start", "stop", "restart"}:
        raise DockerControlError("Unsupported container action.")
    container = (container or "").strip()
    if not _CONTAINER_RE.match(container):
        raise DockerControlError("Invalid container identifier.")
    out = _run_docker([action, container])
    # best-effort: fetch restart policy for visibility
    try:
        inspect = _run_docker(["inspect", "--format", "{{.HostConfig.RestartPolicy.Name}}", container]).strip()
    except Exception:
        inspect = ""
    return {"ok": True, "container": container, "action": action, "restartPolicy": inspect, "output": out.strip()[:200]}
