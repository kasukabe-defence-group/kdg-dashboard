"""playit.gg agent status for the Minecraft creation flow.

Reports whether the playit agent is installed, running and provisioned. Tunnels
are managed in the playit.gg dashboard (accounts are registered) — there is no
CLI for creating them. The dashboard URL is shown next to every new Minecraft
server so friends can be invited without port forwarding or Tailscale.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from typing import Any

from fastapi import APIRouter, Request

from app.audit import record
from app.auth import require_user

router = APIRouter(tags=["playit"])

DASHBOARD = "https://playit.gg/dashboard"
AGENTS = "https://playit.gg/account/agents"
CLAIM = "https://playit.gg/claim"


def _run(cmd: list[str], timeout: int = 10) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return subprocess.CompletedProcess(cmd, 1, "", "unavailable")


def _parse_status(out: str) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    for raw in out.splitlines():
        line = raw.strip()
        for key, name, cast in (("Phase", "phase", str), ("PID", "pid", int),
                                 ("Uptime", "uptimeSeconds", int), ("Version", "version", str),
                                 ("Secret configured", "secretConfigured", str), ("IPC version", "ipcVersion", int)):
            m = re.match(rf"^{re.escape(key)}:\s*(.+)$", line)
            if not m:
                continue
            value = m.group(1).strip()
            if cast is int:
                num = re.sub(r"[^0-9]", "", value)
                parsed[name] = int(num) if num else None
            elif name == "secretConfigured":
                parsed[name] = value.lower() in {"true", "yes", "1"}
            else:
                parsed[name] = value
    return parsed


@router.get("/playit/status")
def playit_status(request: Request):
    user = require_user(request)
    installed = shutil.which("playit-cli") is not None
    payload: dict[str, Any] = {
        "installed": installed,
        "serviceActive": None,
        "phase": None,
        "pid": None,
        "uptimeSeconds": None,
        "version": None,
        "secretConfigured": None,
        "ipcVersion": None,
        "dashboardUrl": DASHBOARD,
        "agentUrl": AGENTS,
        "claimUrl": CLAIM,
    }
    if installed:
        active = _run(["systemctl", "is-active", "playit.service"])
        payload["serviceActive"] = active.stdout.strip() == "active"
        out = _run(["playit-cli", "status"])
        if out.returncode == 0:
            payload.update(_parse_status(out.stdout))
        record("playit.status", actor=user.username, resource="playit", action="status", result="success", ip="127.0.0.1")
    return payload
