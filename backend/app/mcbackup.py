"""Minecraft world backup to Google Drive (one-time rclone authorize token).

Everything for a server lives under /home/tabahi/kdg-dev/minecraft:

    data/<sid>/                     world, plugins, config, *.properties, whitelist...
    backups/<sid>/<sid>-<ts>.tar.gz  local tarballs (kept: 3)
    backups/<sid>/pre-restore-<ts>/  world stash before a Drive restore (kept: 2)
    .kdg-backup/<sid>.json           per-server backup config (0600)
    .kdg-backup/rclone.conf          single remote `mcbackup` holding the Drive
                                      refresh token (0600; never returned)
    .kdg-backup/settings.json        global defaults (remote folder, retention)

Flow:
  * Trigger points: every 10 minutes (systemd timer), before stop/restart, and
    manually from the dashboard ("Backup now").
  * If the server is running we RCON `save-off`, `save-all flush`, then tar, then
    `save-on`. If it is stopped we just tar.
  * Uploads go to `mcbackup:<folder>/<sid>/<tarball>` via rclone. Remote retention
    keeps `keepLast` files per server. Anything that cannot be uploaded stays in
    the local backups dir and is re-sent by the timer (self-healing of the queue).
  * Restore-on-START (always, if enabled and Drive authorized): the latest tarball
    in Drive is downloaded, the current world is stashed under
    backups/<sid>/pre-restore-<ts>/, and the archive is extracted. Whatever is
    not in Drive (i.e. un-backed-up progress) is then gone.
  * A local tarball is also written before every Drive upload so an offline node
    keeps protection between flushes.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.minecraft import DATA_DIR as _DATA_ROOT, _container_name, _docker_status, _find, _load
from app.audit import record
from app.auth import _load_users, require_user

router = APIRouter(tags=["minecraft-backup"])

ROOT = Path(os.getenv("KDG_MINECRAFT_ROOT", "/home/tabahi/kdg-dev/minecraft"))
DATA_DIR = ROOT / "data"
BACKUP_DIR = ROOT / "backups"
CONFIG_DIR = ROOT / ".kdg-backup"
SETTINGS_FILE = CONFIG_DIR / "settings.json"
REMOTE = "mcbackup"
DEFAULT_FOLDER = "KDG Minecraft Backups"


def _data(sid: str) -> Path:
    return _DATA_ROOT / sid

_lock = threading.RLock()


def _ensure_dirs() -> None:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(CONFIG_DIR, 0o700)
    except OSError:
        pass


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _require_access(request: Request):
    user = require_user(request)
    if user.role not in {"owner", "admin", "moderator"}:
        raise HTTPException(status_code=403, detail="Not allowed")
    return user


def _server(sid: str) -> dict[str, Any]:
    with _lock:
        server = _find(_load(), sid)
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    return server


def _settings() -> dict[str, Any]:
    _ensure_dirs()
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_settings(settings: dict[str, Any]) -> None:
    _ensure_dirs()
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_FILE)
    try:
        os.chmod(SETTINGS_FILE, 0o600)
    except OSError:
        pass


def _authorized() -> bool:
    return (CONFIG_DIR / "rclone.conf").exists() and bool(_settings().get("authorized"))


def _server_conf_path(sid: str) -> Path:
    return CONFIG_DIR / f"{sid}.json"


def _load_server_conf(sid: str) -> dict[str, Any]:
    _ensure_dirs()
    try:
        data = json.loads(_server_conf_path(sid).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_server_conf(sid: str, conf: dict[str, Any]) -> None:
    _ensure_dirs()
    tmp = _server_conf_path(sid).with_suffix(".tmp")
    tmp.write_text(json.dumps(conf, indent=2), encoding="utf-8")
    tmp.replace(_server_conf_path(sid))
    try:
        os.chmod(_server_conf_path(sid), 0o600)
    except OSError:
        pass


def _conf_defaults(conf: dict[str, Any]) -> dict[str, Any]:
    settings = _settings()
    merged = {
        "enabled": False,
        "folder": settings.get("folder", DEFAULT_FOLDER),
        "keepLast": int(settings.get("keepLast", 6)),
        "restoreOnStart": bool(settings.get("restoreOnStart", True)),
        "lastRun": None,
        "lastResult": None,
        "lastError": "",
        "totalBackups": 0,
    }
    merged.update(conf)
    return merged


def _folder_segments(folder: str) -> list[str]:
    raw = str(folder or DEFAULT_FOLDER).replace("\\", "/").strip().strip("/") or DEFAULT_FOLDER
    out: list[str] = []
    for segment in raw.split("/"):
        cleaned = re.sub(r'[:*?"<>|/\\]+', "-", segment).strip(". ").strip()
        if cleaned and cleaned not in {".", ".."}:
            out.append(cleaned[:100])
    return out or [DEFAULT_FOLDER]


def _remote_dir(conf: dict[str, Any], sid: str) -> str:
    return "/".join(_folder_segments(str(conf.get("folder") or DEFAULT_FOLDER))) + f"/{sid}"


def _rclone(args: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    return _run(["rclone", "--config", str(CONFIG_DIR / "rclone.conf"), *args], timeout=timeout)


def _run(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", f"timed out after {timeout}s")


def _rcon(sid: str, command: str) -> tuple[bool, str]:
    r = _run(["docker", "exec", _container_name(sid), "rcon-cli", command], timeout=20)
    if r.returncode == 0:
        return True, (r.stdout or "").strip()
    return False, (r.stderr or r.stdout or "RCON command failed").strip()


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def _tar_entries(sid: str) -> list[str]:
    data = _data(sid)
    wanted = (
        "world", "world_nether", "world_the_end", "plugins", "config", "mods", "maps",
        "ops.json", "whitelist.json", "allowlist.json", "banned-ips.json", "banned-players.json",
        "server.properties", "eula.txt", "usercache.json", "permissions.yml",
    )
    return [entry for entry in wanted if (data / entry).exists()]


def _prune_local_backups(sid: str, keep: int = 3) -> None:
    folder = BACKUP_DIR / sid
    if not folder.exists():
        return
    tars = sorted(folder.glob("*.tar.gz"), key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    for stale in tars[keep:]:
        try:
            stale.unlink()
        except OSError:
            pass


def _prune_pre_restores(sid: str, keep: int = 2) -> None:
    folder = BACKUP_DIR / sid
    if not folder.exists():
        return
    stashes = sorted((p for p in folder.glob("pre-restore-*") if p.is_dir()),
                     key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    for stale in stashes[keep:]:
        shutil.rmtree(stale, ignore_errors=True)


def _settings_update_server(sid: str, **updates: Any) -> dict[str, Any]:
    conf = _conf_defaults(_load_server_conf(sid))
    conf.update(updates)
    _save_server_conf(sid, conf)
    return conf


def backup_server(sid: str, reason: str = "manual") -> dict[str, Any]:
    """Create a tarball, upload it to Drive (best effort), prune old copies."""
    with _lock:
        _server(sid)
        _ensure_dirs()
        data = _data(sid)
        if not data.exists():
            raise HTTPException(status_code=400, detail="World data directory does not exist (is the server created?)")
        entries = _tar_entries(sid)
        if not entries:
            raise HTTPException(status_code=400, detail="Nothing to back up yet (no world files)")

        conf = _conf_defaults(_load_server_conf(sid))
        sid_dir = BACKUP_DIR / sid
        sid_dir.mkdir(parents=True, exist_ok=True)

        running = bool(_docker_status(_container_name(sid)).get("running"))
        # millisecond precision so two backups in the same second never collide
        now = datetime.now()
        ts = now.strftime("%Y%m%d-%H%M%S") + f"-{now.microsecond // 1000:03d}"
        tar_path = sid_dir / f"{sid}-{ts}.tar.gz"

        save_out = ""
        if running:
            _rcon(sid, "save-off")
            ok, out = _rcon(sid, "save-all flush")
            if not ok:
                time.sleep(1)
                ok, out = _rcon(sid, "save-all flush")
            save_out = out or "save-all issued"
            time.sleep(1)

        r = _run(["tar", "-czf", str(tar_path), "-C", str(data), *entries], timeout=600)
        if running:
            _rcon(sid, "save-on")
        if r.returncode != 0 or not tar_path.exists():
            tar_path.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Tarball failed: {(r.stderr or r.stdout or 'unknown error')[:300]}")

        size = tar_path.stat().st_size
        _prune_local_backups(sid, keep=3)
        _prune_pre_restores(sid, keep=2)

        uploaded = False
        upload_reason = "drive-not-authorized"
        remote_total = None
        if _authorized():
            remote_dir = _remote_dir(conf, sid)
            r2 = _rclone(["copy", str(tar_path), f"{REMOTE}:{remote_dir}", "--fast-list"], timeout=900)
            if r2.returncode == 0:
                uploaded = True
                upload_reason = "ok"
                _prune_remote(sid, conf)
                remote_total = _count_remote(sid, conf)
            else:
                upload_reason = (r2.stderr or r2.stdout or "rclone copy failed").strip().splitlines()
                upload_reason = upload_reason[-1][:300] if upload_reason else "rclone copy failed"

        conf = _settings_update_server(
            sid,
            lastRun=time.time(),
            lastResult="ok" if upload_reason == "ok" else "partial",
            lastError="" if upload_reason == "ok" else upload_reason,
            totalBackups=int(conf.get("totalBackups") or 0) + 1,
        )
        payload = {
            "ok": True,
            "tarball": tar_path.name,
            "sizeBytes": size,
            "savedWorld": save_out,
            "running": running,
            "reason": reason,
            "uploaded": uploaded,
            "uploadReason": upload_reason,
            "remoteFiles": remote_total,
        }
        record("minecraft.backup.run", actor="system", resource=sid, action="backup", result="success" if uploaded else "partial",
               ip="127.0.0.1", detail={"tarball": tar_path.name, "sizeBytes": size, "uploaded": uploaded, "reason": reason})
        return payload


def _prune_remote(sid: str, conf: dict[str, Any]) -> None:
    keep = int(conf.get("keepLast") or 6)
    remote_dir = _remote_dir(conf, sid)
    r = _rclone(["lsjson", f"{REMOTE}:{remote_dir}"], timeout=90)
    if r.returncode != 0 or not (r.stdout or "").strip():
        return
    try:
        files = json.loads(r.stdout)
    except ValueError:
        return
    files = [f for f in files if isinstance(f, dict) and str(f.get("Name", "")).endswith(".tar.gz")]
    files.sort(key=lambda f: str(f.get("ModTime") or ""), reverse=True)
    for stale in files[keep:]:
        name = stale.get("Name")
        if name:
            _rclone(["deletefile", f"{REMOTE}:{remote_dir}/{name}"], timeout=60)


def _count_remote(sid: str, conf: dict[str, Any]) -> int | None:
    remote_dir = _remote_dir(conf, sid)
    r = _rclone(["lsjson", f"{REMOTE}:{remote_dir}"], timeout=60)
    if r.returncode != 0:
        return None
    try:
        files = json.loads(r.stdout or "[]")
        return len(files)
    except ValueError:
        return None


def _latest_remote(sid: str, conf: dict[str, Any]) -> dict[str, Any] | None:
    remote_dir = _remote_dir(conf, sid)
    r = _rclone(["lsjson", f"{REMOTE}:{remote_dir}"], timeout=90)
    if r.returncode != 0:
        return None
    try:
        files = json.loads(r.stdout or "[]")
    except ValueError:
        return None
    files = [f for f in files if isinstance(f, dict) and str(f.get("Name", "")).endswith(".tar.gz")]
    if not files:
        return None
    files.sort(key=lambda f: str(f.get("ModTime") or ""), reverse=True)
    return files[0]


def restore_from_drive(sid: str, reason: str = "manual") -> dict[str, Any]:
    """Download the newest Drive tarball and replace the local world with it."""
    with _lock:
        _server(sid)
        _ensure_dirs()
        if not _authorized():
            raise HTTPException(status_code=400, detail="Google Drive is not connected for backups (add the token first)")
        conf = _conf_defaults(_load_server_conf(sid))
        latest = _latest_remote(sid, conf)
        if not latest:
            raise HTTPException(status_code=404, detail="No backups found in Drive for this server yet")

        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        tmp_tar = BACKUP_DIR / sid / f"restore-{ts}.tar.gz"
        data = _data(sid)
        sid_dir = BACKUP_DIR / sid
        sid_dir.mkdir(parents=True, exist_ok=True)

        remote_path = f"{REMOTE}:{_remote_dir(conf, sid)}/{latest['Name']}"
        r = _rclone(["copyto", remote_path, str(tmp_tar)], timeout=900)
        if r.returncode != 0 or not tmp_tar.exists():
            tmp_tar.unlink(missing_ok=True)
            raise HTTPException(status_code=502, detail=f"Could not download the backup: {(r.stderr or r.stdout)[:250]}")

        listing = _run(["tar", "-tzf", str(tmp_tar)], timeout=120)
        if listing.returncode != 0 or "world" not in (listing.stdout or ""):
            tmp_tar.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail="Downloaded tarball is not a valid world backup")

        stash = sid_dir / f"pre-restore-{ts}"
        stash.mkdir(parents=True, exist_ok=True)
        moved: list[str] = []
        if data.exists():
            for child in data.iterdir():
                if child.name == ".kdg":
                    continue
                target = stash / child.name
                shutil.move(str(child), str(target))
                moved.append(child.name)
        else:
            data.mkdir(parents=True, exist_ok=True)

        r2 = _run(["tar", "-xzf", str(tmp_tar), "-C", str(data)], timeout=600)
        if r2.returncode != 0:
            raise HTTPException(status_code=500, detail=f"Extraction failed (stash kept at {stash}): {(r2.stderr or r2.stdout)[:250]}")
        tmp_tar.unlink(missing_ok=True)

        conf = _settings_update_server(sid, lastRun=time.time(), lastResult="ok", lastError="", restoredFrom=latest["Name"])
        record("minecraft.backup.restore", actor="system", resource=sid, action="restore", result="success",
               ip="127.0.0.1", detail={"file": latest["Name"], "stashed": str(stash), "reason": reason})
        return {
            "ok": True,
            "restored": latest["Name"],
            "stashedTo": str(stash) if moved else None,
            "bytes": latest.get("Size"),
        }


def restore_on_start_if_enabled(sid: str) -> str | None:
    """Return a warning string if the restore was requested but did not complete."""
    try:
        conf = _conf_defaults(_load_server_conf(sid))
        if not conf.get("enabled") or not conf.get("restoreOnStart"):
            return None
        if not _authorized():
            return "Drive restore enabled but Drive is not authorized — starting with local world"
        running = bool(_docker_status(_container_name(sid)).get("running"))
        if running:
            _run(["docker", "stop", _container_name(sid)], timeout=120)
        out = restore_from_drive(sid, reason="start")
        if not out.get("restored"):
            return "Restore did not complete — starting with local world"
        return None
    except HTTPException as exc:
        record("minecraft.backup.restore_warning", actor="system", resource=sid, action="restore", result="partial",
               ip="127.0.0.1", detail={"error": str(exc.detail)[:200]})
        detail = exc.detail
        return detail if isinstance(detail, str) else json.dumps(detail)[:200]
    except Exception as exc:  # never block the start path
        record("minecraft.backup.restore_failed", actor="system", resource=sid, action="restore", result="failed",
               ip="127.0.0.1", detail={"error": str(exc)[:200]})
        return str(exc)[:200]


def backup_on_transition_if_enabled(sid: str, reason: str) -> str | None:
    """Best-effort backup for stop/restart; returns a warning string on failure."""
    try:
        conf = _conf_defaults(_load_server_conf(sid))
        if not conf.get("enabled"):
            return None
        backup_server(sid, reason=reason)
        return None
    except HTTPException as exc:
        record("minecraft.backup.stop_warning", actor="system", resource=sid, action="backup", result="partial",
               ip="127.0.0.1", detail={"reason": reason, "error": str(exc.detail)[:200]})
        detail = exc.detail
        return detail if isinstance(detail, str) else json.dumps(detail)[:200]
    except Exception as exc:
        record("minecraft.backup.stop_failed", actor="system", resource=sid, action="backup", result="failed",
               ip="127.0.0.1", detail={"reason": reason, "error": str(exc)[:200]})
        return str(exc)[:200]


def backup_status(sid: str) -> dict[str, Any]:
    conf = _conf_defaults(_load_server_conf(sid))
    sid_dir = BACKUP_DIR / sid
    local = 0
    if sid_dir.exists():
        local = len(list(sid_dir.glob("*.tar.gz")))
    authorized = _authorized()
    return {
        "serverId": sid,
        "authorized": authorized,
        "enabled": bool(conf.get("enabled")),
        "folder": conf.get("folder"),
        "keepLast": conf.get("keepLast"),
        "restoreOnStart": bool(conf.get("restoreOnStart")),
        "lastRun": conf.get("lastRun"),
        "lastRunIso": _iso(conf.get("lastRun")),
        "lastResult": conf.get("lastResult"),
        "lastError": conf.get("lastError"),
        "totalBackups": conf.get("totalBackups"),
        "localTarballs": local,
        "remoteFolder": f"{_remote_dir(conf, sid)}" if authorized else None,
    }


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

@router.get("/minecraft/servers/{sid}/backup")
def get_backup(sid: str, request: Request):
    _require_access(request)
    return backup_status(sid)


class AuthPayload(BaseModel):
    token: str = Field(min_length=10, max_length=8000)
    folder: str = Field(default="", max_length=120)
    keepLast: int = Field(default=6, ge=1, le=100)
    restoreOnStart: bool = True


@router.post("/minecraft/servers/{sid}/backup/auth")
def connect_drive(sid: str, payload: AuthPayload, request: Request):
    _require_access(request)
    _server(sid)
    settings = _settings()
    folder = payload.folder.strip() or str(settings.get("folder") or DEFAULT_FOLDER)
    _write_rclone_conf(payload.token, folder)
    settings.update({
        "authorized": True,
        "folder": "/".join(_folder_segments(folder)),
        "keepLast": payload.keepLast,
        "restoreOnStart": bool(payload.restoreOnStart),
    })
    _save_settings(settings)
    _save_server_conf(sid, _conf_defaults({**_load_server_conf(sid), "enabled": True,
                                           "folder": settings["folder"], "keepLast": payload.keepLast,
                                           "restoreOnStart": bool(payload.restoreOnStart)}))
    record("minecraft.backup.connect", actor=_require_access(request).username, resource=sid, action="connect", result="success",
           ip=_client_ip(request), detail={"folder": settings["folder"]})
    return backup_status(sid)


def _write_rclone_conf(token: str, folder: str) -> None:
    raw = token.strip()
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="That is not valid JSON. Paste the exact output of `rclone authorize \"drive\"` (starts with `{`).") from exc
    if not isinstance(data, dict) or ("refresh_token" not in data and "access_token" not in data):
        raise HTTPException(status_code=400, detail="No refresh_token/access_token in the JSON. Run `rclone authorize \"drive\"` again and paste the full output.")
    try:
        _ensure_dirs()
        safe = {k: data[k] for k in ("access_token", "token_type", "refresh_token", "expiry", "expires_in") if k in data}
        conf = f"[{REMOTE}]\ntype = drive\nscope = drive\ntoken = {json.dumps(safe, separators=(',', ':'))}\n"
        tmp_path = CONFIG_DIR / "rclone.conf.tmp"
        tmp_path.write_text(conf, encoding="utf-8")
        tmp_path.replace(CONFIG_DIR / "rclone.conf")
        os.chmod(CONFIG_DIR / "rclone.conf", 0o600)
        probe = _rclone(["lsd", f"{REMOTE}:"], timeout=90)
        if probe.returncode != 0:
            (CONFIG_DIR / "rclone.conf").unlink(missing_ok=True)
            detail = (probe.stderr or probe.stdout or "rclone could not reach Drive").strip().splitlines()
            raise HTTPException(status_code=400, detail=f"Token rejected by Google Drive: {detail[-1][:220] if detail else 'unknown error'}")
    except HTTPException:
        raise
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not store the token: {exc}") from exc


@router.delete("/minecraft/servers/{sid}/backup/auth")
def disconnect_drive(sid: str, request: Request):
    _require_access(request)
    _server(sid)
    conf_dir = CONFIG_DIR
    removed: list[str] = []
    for name in ("rclone.conf",):
        target = conf_dir / name
        if target.exists():
            target.unlink()
            removed.append(name)
    settings = _settings()
    settings["authorized"] = False
    _save_settings(settings)
    _save_server_conf(sid, {**_load_server_conf(sid), "enabled": False})
    record("minecraft.backup.disconnect", actor=_require_access(request).username, resource=sid, action="disconnect", result="success",
           ip=_client_ip(request), detail={"removed": removed})
    return backup_status(sid)


class SettingsPayload(BaseModel):
    enabled: bool | None = None
    keepLast: int | None = Field(default=None, ge=1, le=100)
    restoreOnStart: bool | None = None
    folder: str | None = Field(default=None, max_length=120)


@router.patch("/minecraft/servers/{sid}/backup/settings")
def update_settings(sid: str, payload: SettingsPayload, request: Request):
    user = _require_access(request)
    _server(sid)
    settings = _settings()
    conf = _conf_defaults(_load_server_conf(sid))
    if payload.folder is not None:
        folder = payload.folder.strip() or conf["folder"]
        settings["folder"] = "/".join(_folder_segments(folder))
        conf["folder"] = settings["folder"]
    if payload.keepLast is not None:
        conf["keepLast"] = payload.keepLast
        settings["keepLast"] = payload.keepLast
    if payload.restoreOnStart is not None:
        conf["restoreOnStart"] = payload.restoreOnStart
        settings["restoreOnStart"] = payload.restoreOnStart
    if payload.enabled is not None:
        if payload.enabled and not _authorized():
            raise HTTPException(status_code=400, detail="Authorize Google Drive before enabling backups")
        conf["enabled"] = payload.enabled
    _save_settings(settings)
    _save_server_conf(sid, conf)
    record("minecraft.backup.settings", actor=user.username, resource=sid, action="settings", result="success",
           ip=_client_ip(request), detail={"enabled": conf.get("enabled")})
    return backup_status(sid)


@router.post("/minecraft/servers/{sid}/backup/run")
def run_backup(sid: str, request: Request):
    user = _require_access(request)
    result = backup_server(sid, reason="manual")
    record("minecraft.backup.run", actor=user.username, resource=sid, action="run", result="success", ip=_client_ip(request), detail={"uploaded": result["uploaded"]})
    return result


@router.post("/minecraft/servers/{sid}/backup/restore")
def restore(sid: str, request: Request, confirm: bool = Query(default=False)):
    user = _require_access(request)
    if not confirm:
        raise HTTPException(status_code=400, detail="Confirm with ?confirm=true — this replaces the current world")
    result = restore_from_drive(sid, reason="manual")
    record("minecraft.backup.restore", actor=user.username, resource=sid, action="restore", result="success", ip=_client_ip(request), detail={"file": result.get("restored")})
    return result


def authorized() -> bool:
    return _authorized()


def run_autosave(reason: str = "timer") -> None:
    """Called from the systemd timer every 10 minutes."""
    try:
        servers = _load()
    except Exception:
        servers = []
    for server in servers:
        sid = str(server.get("id") or "")
        if not sid:
            continue
        conf = _conf_defaults(_load_server_conf(sid))
        if not conf.get("enabled"):
            continue
        try:
            backup_server(sid, reason=reason)
        except Exception as exc:
            record("minecraft.backup.autosave_failed", actor="timer", resource=sid, action="backup", result="failed",
                   ip="127.0.0.1", detail={"error": str(exc)[:200]})


def emergency_save() -> None:
    """Called from the charger-unplug helper and the shutdown unit."""
    try:
        servers = _load()
    except Exception:
        servers = []
    for server in servers:
        sid = str(server.get("id") or "")
        if not sid:
            continue
        try:
            if _docker_status(_container_name(sid)).get("running"):
                _rcon(sid, "save-off")
                for _ in range(3):
                    ok, _ = _rcon(sid, "save-all flush")
                    if ok:
                        break
                    time.sleep(1)
                _rcon(sid, "save-on")
            backup_server(sid, reason="emergency-unplug")
        except Exception as exc:
            record("minecraft.backup.emergency_failed", actor="emergency", resource=sid, action="backup", result="failed",
                   ip="127.0.0.1", detail={"error": str(exc)[:200]})


if __name__ == "__main__" and len(__import__("sys").argv) > 1 and __import__("sys").argv[1] == "autosave":
    run_autosave(reason="timer")
elif __name__ == "__main__" and len(__import__("sys").argv) > 1 and __import__("sys").argv[1] == "emergency":
    emergency_save()
