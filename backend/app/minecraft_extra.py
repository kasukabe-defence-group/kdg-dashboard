"""Aternos-style extras for managed Minecraft servers.

Adds the pieces the basic CRUD module does not cover:

* software/version catalogue (Paper, Purpur, Fabric, Forge, NeoForge, Vanilla)
* players: online list, whitelist, ops, bans (works stopped via JSON files)
* worlds: list, create, activate, regenerate, delete, upload (.zip)
* plugins/mods: upload, delete, Modrinth search + install

All endpoints live under ``/api/v1/minecraft`` and require the same roles as the
rest of the Minecraft module.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import urllib.parse
import uuid as uuidlib
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from app.audit import record
from app.minecraft import (
    DATA_DIR,
    _container_name,
    _docker_status,
    _find,
    _load,
    _lock as _server_lock,
    _require_access,
    _run,
    _save,
)

router = APIRouter(prefix="/minecraft", tags=["minecraft"])

UA = "kdg-dashboard/1.1 (minecraft manager)"
MODRINTH = "https://api.modrinth.com/v2"
PLUGIN_TYPES = {"PAPER", "SPIGOT", "PURPUR", "BUKKIT", "PAPERMC"}
MOD_TYPES = {"FABRIC", "FORGE", "NEOFORGE", "QUILT"}

_catalog_cache: dict[str, Any] = {"at": 0.0, "data": None}
_catalog_lock = threading.Lock()

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")
_JAR_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ +()-]{0,180}\.jar$", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# generic helpers
# --------------------------------------------------------------------------- #

def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


def _server(sid: str) -> dict[str, Any]:
    with _server_lock:
        s = _find(_load(), sid)
    if not s:
        raise HTTPException(status_code=404, detail="Server not found")
    return s


def _data(sid: str) -> Path:
    return DATA_DIR / sid


def _running(sid: str) -> bool:
    return bool(_docker_status(sid).get("running"))


def _require_stopped(sid: str, what: str = "this action") -> None:
    if _running(sid):
        raise HTTPException(status_code=400, detail=f"Stop the server before {what}")


def _fsize(path: Path) -> int:
    r = _run(["du", "-sb", str(path)], timeout=20)
    if r.returncode == 0:
        first = r.stdout.split()
        if first and first[0].isdigit():
            return int(first[0])
    return 0


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9.-]+", "-", text.lower()).strip("-") or "server"


def _json_read(path: Path, default: Any) -> Any:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, type(default)) else default
    except (OSError, ValueError):
        return default


def _json_write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------- #
# server.properties
# --------------------------------------------------------------------------- #

def _props_path(sid: str) -> Path:
    return _data(sid) / "server.properties"


def _props(sid: str) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        for line in _props_path(sid).read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip()
    except OSError:
        pass
    return out


def _set_props(sid: str, updates: dict[str, str]) -> None:
    path = _props_path(sid)
    lines: list[str] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        lines = []
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in updates:
                out.append(f"{key}={updates[key]}")
                seen.add(key)
                continue
        out.append(line)
    for key, value in updates.items():
        if key not in seen:
            out.append(f"{key}={value}")
    tmp = path.with_suffix(".tmp")
    tmp.write_text("\n".join(out) + "\n", encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------- #
# software catalogue
# --------------------------------------------------------------------------- #

def _get_json(url: str, timeout: float = 10.0) -> Any:
    try:
        with httpx.Client(timeout=timeout, headers={"User-Agent": UA}, follow_redirects=True) as client:
            resp = client.get(url)
            if resp.status_code == 200:
                return resp.json()
    except Exception:
        return None
    return None


def _vkey(version: str) -> tuple:
    parts = re.split(r"[.\-+_]", version)
    out: list[Any] = []
    for part in parts[:4]:
        out.append(int(part) if part.isdigit() else 0)
    while len(out) < 4:
        out.append(0)
    out.append(str(version))
    return tuple(out)


def _sorted_versions(values: list[str], limit: int = 40) -> list[str]:
    clean = sorted({v for v in values if re.match(r"^[0-9]", str(v))}, key=_vkey, reverse=True)
    return clean[:limit]


def _vanilla_versions() -> list[str]:
    data = _get_json("https://launchermeta.mojang.com/mc/game/version_manifest_v2.json")
    if not isinstance(data, dict):
        return []
    return [v["id"] for v in data.get("versions", []) if v.get("type") == "release"]


def _paper_versions() -> list[str]:
    data = _get_json("https://api.papermc.io/v2/projects/paper")
    return list((data or {}).get("versions", [])) if isinstance(data, dict) else []


def _purpur_versions() -> list[str]:
    data = _get_json("https://api.purpurmc.org/v2/purpur")
    return list((data or {}).get("versions", [])) if isinstance(data, dict) else []


def _fabric_versions() -> list[str]:
    data = _get_json("https://meta.fabricmc.net/v2/versions/game")
    if not isinstance(data, list):
        return []
    return [row["version"] for row in data if isinstance(row, dict) and row.get("stable")]


def _forge_versions() -> list[str]:
    data = _get_json("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json")
    if not isinstance(data, dict):
        return []
    out = set()
    for key in (data.get("promotions") or {}):
        mc = str(key).rsplit("-", 1)[0]
        if re.match(r"^[0-9]", mc):
            out.add(mc)
    return sorted(out)


def _catalog() -> dict[str, Any]:
    with _catalog_lock:
        now = time.time()
        if _catalog_cache["data"] and now - _catalog_cache["at"] < 3600:
            return _catalog_cache["data"]

        with ThreadPoolExecutor(max_workers=5) as pool:
            vanilla_f = pool.submit(_vanilla_versions)
            paper_f = pool.submit(_paper_versions)
            purpur_f = pool.submit(_purpur_versions)
            fabric_f = pool.submit(_fabric_versions)
            forge_f = pool.submit(_forge_versions)
            try:
                vanilla = vanilla_f.result(timeout=20)
            except Exception:
                vanilla = []
            try:
                paper = paper_f.result(timeout=20)
            except Exception:
                paper = []
            try:
                purpur = purpur_f.result(timeout=20)
            except Exception:
                purpur = []
            try:
                fabric = fabric_f.result(timeout=20)
            except Exception:
                fabric = []
            try:
                forge = forge_f.result(timeout=20)
            except Exception:
                forge = []

        neoforge = [v for v in vanilla if _vkey(v) >= _vkey("1.20.2")]
        types = [
            {"id": "PAPER", "label": "Paper", "kind": "plugins", "versions": _sorted_versions(paper or vanilla)},
            {"id": "PURPUR", "label": "Purpur", "kind": "plugins", "versions": _sorted_versions(purpur or paper or vanilla)},
            {"id": "FABRIC", "label": "Fabric", "kind": "mods", "versions": _sorted_versions(fabric or vanilla)},
            {"id": "FORGE", "label": "Forge", "kind": "mods", "versions": _sorted_versions(forge or vanilla)},
            {"id": "NEOFORGE", "label": "NeoForge", "kind": "mods", "versions": _sorted_versions(neoforge or vanilla)},
            {"id": "VANILLA", "label": "Vanilla", "kind": "none", "versions": _sorted_versions(vanilla)},
            {"id": "SPIGOT", "label": "Spigot", "kind": "plugins", "versions": _sorted_versions(vanilla)},
            {"id": "QUILT", "label": "Quilt", "kind": "mods", "versions": _sorted_versions(fabric or vanilla)},
        ]
        data = {"types": types, "mcVersions": _sorted_versions(vanilla, 60), "fetchedAt": int(time.time())}
        _catalog_cache.update({"at": now, "data": data})
        return data


# --------------------------------------------------------------------------- #
# players
# --------------------------------------------------------------------------- #

def _rcon(sid: str, command: str) -> tuple[bool, str]:
    r = _run(["docker", "exec", _container_name(sid), "rcon-cli", command], timeout=20)
    if r.returncode == 0:
        return True, (r.stdout or "").strip()
    return False, (r.stderr or r.stdout or "RCON command failed").strip()


def _offline_uuid(name: str) -> str:
    digest = hashlib.md5(f"OfflinePlayer:{name}".encode("utf-8")).digest()
    return str(uuidlib.UUID(bytes=digest, version=3))


def _resolve_uuid(name: str) -> str:
    data = _get_json(f"https://api.mojang.com/users/profiles/minecraft/{urllib.parse.quote(name)}", timeout=6)
    if isinstance(data, dict) and data.get("id"):
        raw = str(data["id"])
        if len(raw) == 32:
            return f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"
    return _offline_uuid(name)


def _parse_player_list(text: str) -> list[str]:
    match = re.search(r"players online:?\s*(.*)$", text, re.IGNORECASE | re.DOTALL)
    body = match.group(1) if match else text
    return [p.strip() for p in body.split(",") if p.strip() and p.strip() not in {"", "—"}]


def _parse_whitelist(text: str) -> list[str]:
    match = re.search(r"whitelisted players?:?\s*(.*)$", text, re.IGNORECASE | re.DOTALL)
    body = match.group(1) if match else text
    return [p.strip() for p in body.split(",") if p.strip()]


def _players_payload(sid: str, server: dict[str, Any]) -> dict[str, Any]:
    data = _data(sid)
    online: list[str] = []
    max_players = int(server.get("maxPlayers") or 20)
    running = _running(sid)
    whitelist: list[str] = []
    if running:
        ok, out = _rcon(sid, "list")
        if ok:
            match = re.search(r"There are (\d+) of a max of (\d+) players online", out, re.IGNORECASE)
            if match:
                max_players = int(match.group(2))
            online = _parse_player_list(out)
        ok, out = _rcon(sid, "whitelist list")
        if ok:
            whitelist = _parse_whitelist(out)
    whitelist_file = _json_read(data / "whitelist.json", [])
    if not whitelist and isinstance(whitelist_file, list):
        whitelist = [str(row.get("name")) for row in whitelist_file if isinstance(row, dict) and row.get("name")]
    ops_rows = _json_read(data / "ops.json", [])
    ops = [str(row.get("name")) for row in ops_rows if isinstance(row, dict) and row.get("name")] if isinstance(ops_rows, list) else []
    banned_rows = _json_read(data / "banned-players.json", [])
    banned = [
        {
            "name": str(row.get("name") or ""),
            "reason": str(row.get("reason") or ""),
            "source": str(row.get("source") or ""),
            "created": str(row.get("created") or ""),
            "expires": str(row.get("expires") or ""),
        }
        for row in banned_rows
        if isinstance(row, dict) and row.get("name")
    ] if isinstance(banned_rows, list) else []
    ips_rows = _json_read(data / "banned-ips.json", [])
    banned_ips = [str(row.get("ip")) for row in ips_rows if isinstance(row, dict) and row.get("ip")] if isinstance(ips_rows, list) else []
    props = _props(sid)
    return {
        "online": online,
        "maxPlayers": max_players,
        "whitelist": sorted(set(whitelist), key=str.lower),
        "ops": sorted(set(ops), key=str.lower),
        "banned": banned,
        "bannedIps": banned_ips,
        "whitelistEnabled": str(props.get("white-list", "false")).lower() == "true",
    }


class PlayerAction(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    action: str = Field(pattern="^(whitelist-add|whitelist-remove|op|deop|kick|ban|pardon|ban-ip|pardon-ip)$")


@router.get("/servers/{sid}/players")
def get_players(sid: str, request: Request):
    _require_access(request)
    return _players_payload(sid, _server(sid))


@router.post("/servers/{sid}/players")
def player_action(sid: str, payload: PlayerAction, request: Request):
    user = _require_access(request)
    server = _server(sid)
    name = payload.name.strip()
    if not re.match(r"^[A-Za-z0-9_]{1,32}$", name):
        raise HTTPException(status_code=400, detail="Invalid player name")
    data = _data(sid)
    running = _running(sid)
    action = payload.action
    message = ""

    if running:
        rcon_map = {
            "whitelist-add": f"whitelist add {name}",
            "whitelist-remove": f"whitelist remove {name}",
            "op": f"op {name}",
            "deop": f"deop {name}",
            "kick": f"kick {name}",
            "ban": f"ban {name}",
            "pardon": f"pardon {name}",
            "ban-ip": f"ban-ip {name}",
            "pardon-ip": f"pardon-ip {name}",
        }
        ok, out = _rcon(sid, rcon_map[action])
        if not ok:
            raise HTTPException(status_code=400, detail=out[:300])
        message = out or "Command sent"
    else:
        if action in {"kick", "ban-ip", "pardon-ip"}:
            raise HTTPException(status_code=400, detail="Start the server to use this action")
        if action in {"whitelist-add", "whitelist-remove"}:
            rows = _json_read(data / "whitelist.json", [])
            rows = rows if isinstance(rows, list) else []
            rows = [row for row in rows if not (isinstance(row, dict) and str(row.get("name", "")).lower() == name.lower())]
            if action == "whitelist-add":
                rows.append({"uuid": _resolve_uuid(name), "name": name})
            _json_write(data / "whitelist.json", rows)
            message = f"{name} {'added to' if action == 'whitelist-add' else 'removed from'} the whitelist"
        elif action in {"op", "deop"}:
            rows = _json_read(data / "ops.json", [])
            rows = rows if isinstance(rows, list) else []
            rows = [row for row in rows if not (isinstance(row, dict) and str(row.get("name", "")).lower() == name.lower())]
            if action == "op":
                rows.append({"uuid": _resolve_uuid(name), "name": name, "level": 4, "bypassesPlayerLimit": False})
            _json_write(data / "ops.json", rows)
            message = f"{name} {'is now an operator' if action == 'op' else 'is no longer an operator'}"
        elif action in {"ban", "pardon"}:
            rows = _json_read(data / "banned-players.json", [])
            rows = rows if isinstance(rows, list) else []
            rows = [row for row in rows if not (isinstance(row, dict) and str(row.get("name", "")).lower() == name.lower())]
            if action == "ban":
                rows.append({
                    "uuid": _resolve_uuid(name),
                    "name": name,
                    "created": datetime.now(timezone.utc).isoformat(),
                    "source": "Server",
                    "expires": "forever",
                    "reason": "Banned by an operator.",
                })
            _json_write(data / "banned-players.json", rows)
            message = f"{name} {'banned' if action == 'ban' else 'unbanned'}"

    record("minecraft.players.action", actor=user.username, resource=sid, action=action, result="success",
           ip=_client_ip(request), detail={"player": name, "online": running})
    return {"ok": True, "message": message, "players": _players_payload(sid, server)}


# --------------------------------------------------------------------------- #
# worlds
# --------------------------------------------------------------------------- #

def _world_dirs(sid: str) -> list[Path]:
    base = _data(sid)
    if not base.exists():
        return []
    out = []
    for child in sorted(base.iterdir()):
        if not child.is_dir():
            continue
        if child.name.endswith("_nether") or child.name.endswith("_the_end"):
            continue
        if (child / "level.dat").exists():
            out.append(child)
    return out


def _world_size(name: str, base: Path) -> int:
    total = 0
    for suffix in ("", "_nether", "_the_end"):
        path = base / f"{name}{suffix}"
        if path.exists():
            total += _fsize(path)
    return total


def _worlds_payload(sid: str) -> dict[str, Any]:
    base = _data(sid)
    active = _props(sid).get("level-name", "world")
    worlds = []
    for path in _world_dirs(sid):
        stat = path.stat()
        worlds.append({
            "name": path.name,
            "active": path.name == active,
            "sizeBytes": _world_size(path.name, base),
            "modifiedAt": _iso(stat.st_mtime),
        })
    return {"active": active, "worlds": worlds, "running": _running(sid), "maxUploadBytes": 4 * 1024 ** 3}


class WorldCreate(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    seed: str = Field(default="", max_length=64)
    levelType: str = Field(default="minecraft:normal", max_length=40)


@router.get("/servers/{sid}/worlds")
def list_worlds(sid: str, request: Request):
    _require_access(request)
    _server(sid)
    return _worlds_payload(sid)


@router.post("/servers/{sid}/worlds")
def create_world(sid: str, payload: WorldCreate, request: Request):
    user = _require_access(request)
    _server(sid)
    _require_stopped(sid, "creating a world")
    name = payload.name.strip()
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="World name may only contain letters, numbers, dot, dash and underscore")
    base = _data(sid)
    target = base / name
    if (target / "level.dat").exists():
        raise HTTPException(status_code=409, detail="A world with that name already exists")
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    for suffix in ("_nether", "_the_end"):
        shutil.rmtree(base / f"{name}{suffix}", ignore_errors=True)
    seed = payload.seed.strip()
    level_type = payload.levelType.strip() or "minecraft:normal"
    updates = {"level-name": name, "level-type": level_type}
    if seed:
        updates["level-seed"] = seed
    _set_props(sid, updates)
    record("minecraft.world.create", actor=user.username, resource=sid, action="create", result="success",
           ip=_client_ip(request), detail={"world": name, "seed": bool(seed), "levelType": level_type})
    return {"ok": True, "world": name, "message": f"World '{name}' will be generated on the next start"}


@router.post("/servers/{sid}/worlds/{name}/activate")
def activate_world(sid: str, name: str, request: Request):
    user = _require_access(request)
    _server(sid)
    _require_stopped(sid, "switching worlds")
    if not _NAME_RE.match(name) or not (_data(sid) / name / "level.dat").exists():
        raise HTTPException(status_code=404, detail="World not found")
    _set_props(sid, {"level-name": name})
    record("minecraft.world.activate", actor=user.username, resource=sid, action="activate", result="success",
           ip=_client_ip(request), detail={"world": name})
    return {"ok": True, "message": f"'{name}' is now the active world"}


@router.post("/servers/{sid}/worlds/{name}/regenerate")
def regenerate_world(sid: str, name: str, request: Request):
    user = _require_access(request)
    _server(sid)
    _require_stopped(sid, "regenerating a world")
    base = _data(sid)
    target = base / name
    if not _NAME_RE.match(name) or not (target / "level.dat").exists():
        raise HTTPException(status_code=404, detail="World not found")
    shutil.rmtree(target, ignore_errors=True)
    for suffix in ("_nether", "_the_end"):
        shutil.rmtree(base / f"{name}{suffix}", ignore_errors=True)
    record("minecraft.world.regenerate", actor=user.username, resource=sid, action="regenerate", result="success",
           ip=_client_ip(request), detail={"world": name})
    return {"ok": True, "message": f"'{name}' will be regenerated on the next start"}


@router.delete("/servers/{sid}/worlds/{name}")
def delete_world(sid: str, name: str, request: Request):
    user = _require_access(request)
    _server(sid)
    _require_stopped(sid, "deleting a world")
    base = _data(sid)
    if not _NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid world name")
    if _props(sid).get("level-name", "world") == name:
        raise HTTPException(status_code=400, detail="This world is active. Switch to another world first.")
    target = base / name
    if not target.exists():
        raise HTTPException(status_code=404, detail="World not found")
    shutil.rmtree(target, ignore_errors=True)
    for suffix in ("_nether", "_the_end"):
        shutil.rmtree(base / f"{name}{suffix}", ignore_errors=True)
    record("minecraft.world.delete", actor=user.username, resource=sid, action="delete", result="success",
           ip=_client_ip(request), detail={"world": name})
    return {"ok": True, "message": f"Deleted '{name}'"}


@router.post("/servers/{sid}/worlds/upload")
async def upload_world(sid: str, request: Request, file: UploadFile = File(...), name: str = Form(default="")):
    user = _require_access(request)
    _server(sid)
    _require_stopped(sid, "uploading a world")
    raw_name = (name or Path(file.filename or "upload").stem).strip()
    world_name = re.sub(r"[^A-Za-z0-9._-]", "-", raw_name).strip(".-")[:32] or f"upload-{secrets.token_hex(3)}"
    if not _NAME_RE.match(world_name):
        raise HTTPException(status_code=400, detail="Invalid world name")

    base = _data(sid)
    target = base / world_name
    if (target / "level.dat").exists():
        raise HTTPException(status_code=409, detail="A world with that name already exists")
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)

    tmp_zip = base / f".upload-{secrets.token_hex(4)}.zip"
    tmp_dir = Path(tempfile.mkdtemp(prefix="kdg-world-", dir=str(base)))
    try:
        size = 0
        with tmp_zip.open("wb") as handle:
            while True:
                chunk = await file.read(4 * 1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > 4 * 1024 ** 3:
                    raise HTTPException(status_code=413, detail="World archive is larger than 4 GiB")
                handle.write(chunk)
        try:
            with zipfile.ZipFile(tmp_zip) as archive:
                total = sum(item.file_size for item in archive.infolist())
                if total > 12 * 1024 ** 3:
                    raise HTTPException(status_code=413, detail="Uncompressed world is too large")
                for item in archive.infolist():
                    parts = Path(item.filename).parts
                    if item.filename.startswith("/") or ".." in parts:
                        raise HTTPException(status_code=400, detail="Archive contains unsafe paths")
                archive.extractall(tmp_dir)
        except zipfile.BadZipFile as exc:
            raise HTTPException(status_code=400, detail="Upload must be a .zip archive") from exc

        source = None
        if (tmp_dir / "level.dat").exists():
            source = tmp_dir
        else:
            candidates = [p for p in tmp_dir.iterdir() if p.is_dir() and (p / "level.dat").exists()]
            if len(candidates) == 1:
                source = candidates[0]
        if source is None:
            raise HTTPException(status_code=400, detail="No level.dat found in the archive (zip the world folder itself)")
        shutil.move(str(source), str(target))
        _set_props(sid, {"level-name": world_name})
        record("minecraft.world.upload", actor=user.username, resource=sid, action="upload", result="success",
               ip=_client_ip(request), detail={"world": world_name, "bytes": size})
        return {"ok": True, "world": world_name, "message": f"Uploaded '{world_name}' and made it active"}
    finally:
        tmp_zip.unlink(missing_ok=True)
        shutil.rmtree(tmp_dir, ignore_errors=True)


# --------------------------------------------------------------------------- #
# plugins / mods
# --------------------------------------------------------------------------- #

def _addon_kind(server: dict[str, Any]) -> str:
    server_type = str(server.get("type") or "").upper()
    if server_type in PLUGIN_TYPES:
        return "plugins"
    if server_type in MOD_TYPES:
        return "mods"
    raise HTTPException(status_code=400, detail="Vanilla servers do not support plugins or mods")


def _addon_loaders(server: dict[str, Any]) -> list[str]:
    server_type = str(server.get("type") or "").upper()
    return {
        "PAPER": ["paper", "spigot", "bukkit"],
        "PURPUR": ["purpur", "paper", "spigot", "bukkit"],
        "SPIGOT": ["spigot", "bukkit"],
        "BUKKIT": ["bukkit"],
        "PAPERMC": ["paper", "spigot", "bukkit"],
        "FABRIC": ["fabric"],
        "QUILT": ["quilt", "fabric"],
        "FORGE": ["forge"],
        "NEOFORGE": ["neoforge"],
    }.get(server_type, [])


def _installed_addons(sid: str, kind: str) -> list[dict[str, Any]]:
    folder = _data(sid) / kind
    if not folder.exists():
        return []
    out = []
    for path in sorted(folder.iterdir()):
        if path.is_file() and path.suffix.lower() == ".jar":
            stat = path.stat()
            out.append({"name": path.name, "sizeBytes": stat.st_size, "modifiedAt": _iso(stat.st_mtime)})
    return out


@router.get("/servers/{sid}/addons")
def list_addons(sid: str, request: Request):
    _require_access(request)
    server = _server(sid)
    kind = _addon_kind(server)
    return {"kind": kind, "installed": _installed_addons(sid, kind), "running": _running(sid)}


@router.post("/servers/{sid}/addons/upload")
async def upload_addon(sid: str, request: Request, file: UploadFile = File(...)):
    user = _require_access(request)
    server = _server(sid)
    kind = _addon_kind(server)
    filename = Path(file.filename or "").name
    if not filename.lower().endswith(".jar"):
        raise HTTPException(status_code=400, detail="Only .jar files can be installed")
    if not _JAR_RE.match(filename):
        raise HTTPException(status_code=400, detail="Invalid jar file name")
    folder = _data(sid) / kind
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / filename
    size = 0
    with target.open("wb") as handle:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > 500 * 1024 ** 2:
                handle.close()
                target.unlink(missing_ok=True)
                raise HTTPException(status_code=413, detail="Addon is larger than 500 MiB")
            handle.write(chunk)
    record("minecraft.addon.upload", actor=user.username, resource=sid, action="upload", result="success",
           ip=_client_ip(request), detail={"kind": kind, "file": filename, "bytes": size})
    return {"ok": True, "file": filename, "message": f"Installed {filename}. Restart the server to load it."}


@router.delete("/servers/{sid}/addons/{name}")
def delete_addon(sid: str, name: str, request: Request):
    user = _require_access(request)
    server = _server(sid)
    kind = _addon_kind(server)
    filename = Path(name).name
    if not filename.lower().endswith(".jar"):
        raise HTTPException(status_code=400, detail="Invalid file name")
    target = _data(sid) / kind / filename
    if not target.exists():
        raise HTTPException(status_code=404, detail="Addon not found")
    target.unlink()
    record("minecraft.addon.delete", actor=user.username, resource=sid, action="delete", result="success",
           ip=_client_ip(request), detail={"kind": kind, "file": filename})
    return {"ok": True, "message": f"Removed {filename}"}


@router.get("/servers/{sid}/addons/search")
def search_addons(sid: str, request: Request, q: str = Query(min_length=1, max_length=80), limit: int = Query(default=12, ge=1, le=30)):
    _require_access(request)
    server = _server(sid)
    kind = _addon_kind(server)
    project_type = "plugin" if kind == "plugins" else "mod"
    loaders = _addon_loaders(server)
    version = str(server.get("version") or "").strip()
    facets: list[list[str]] = [[f"project_type:{project_type}"]]
    if loaders:
        facets.append([f"categories:{loader}" for loader in loaders])
    if version and version.upper() != "LATEST":
        facets.append([f"versions:{version}"])
    params = {
        "query": q,
        "limit": str(limit),
        "index": "downloads",
        "facets": json.dumps(facets),
    }
    url = f"{MODRINTH}/search?{urllib.parse.urlencode(params)}"
    data = _get_json(url, timeout=15)
    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="Modrinth search is unavailable right now")
    hits = []
    for row in data.get("hits", []):
        if not isinstance(row, dict):
            continue
        hits.append({
            "id": row.get("project_id"),
            "slug": row.get("slug"),
            "title": row.get("title"),
            "description": row.get("description"),
            "downloads": row.get("downloads"),
            "author": row.get("author"),
            "iconUrl": row.get("icon_url"),
            "categories": row.get("categories") or [],
        })
    return {"results": hits, "kind": kind, "loaders": loaders, "version": version}


class AddonInstall(BaseModel):
    projectId: str = Field(min_length=2, max_length=64)


@router.post("/servers/{sid}/addons/install")
def install_addon(sid: str, payload: AddonInstall, request: Request):
    user = _require_access(request)
    server = _server(sid)
    kind = _addon_kind(server)
    loaders = _addon_loaders(server)
    version = str(server.get("version") or "").strip()
    params: list[tuple[str, str]] = []
    if loaders:
        params.append(("loaders", json.dumps(loaders)))
    if version and version.upper() != "LATEST":
        params.append(("game_versions", json.dumps([version])))
    query = urllib.parse.urlencode(params)
    url = f"{MODRINTH}/project/{urllib.parse.quote(payload.projectId)}/version"
    if query:
        url += f"?{query}"
    versions = _get_json(url, timeout=15)
    if not isinstance(versions, list) or not versions:
        raise HTTPException(status_code=404, detail=f"No release found for {server.get('type')} {version or ''}".strip())
    chosen = versions[0]
    files = chosen.get("files") or []
    primary = next((f for f in files if f.get("primary")), files[0] if files else None)
    if not primary or not primary.get("url"):
        raise HTTPException(status_code=502, detail="Modrinth returned no downloadable file")
    file_url = str(primary["url"])
    host = urllib.parse.urlparse(file_url).hostname or ""
    if not host.endswith("modrinth.com"):
        raise HTTPException(status_code=502, detail="Unexpected download host")
    filename = Path(str(primary.get("filename") or "addon.jar")).name
    if not filename.lower().endswith(".jar"):
        filename += ".jar"
    filename = re.sub(r"[^A-Za-z0-9._ +()-]", "-", filename)[:180]
    folder = _data(sid) / kind
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / filename
    size = 0
    try:
        with httpx.Client(timeout=120, headers={"User-Agent": UA}, follow_redirects=True) as client:
            with client.stream("GET", file_url) as response:
                if response.status_code != 200:
                    raise HTTPException(status_code=502, detail=f"Download failed ({response.status_code})")
                with target.open("wb") as handle:
                    for chunk in response.iter_bytes(1024 * 1024):
                        size += len(chunk)
                        if size > 500 * 1024 ** 2:
                            raise HTTPException(status_code=413, detail="Addon is larger than 500 MiB")
                        handle.write(chunk)
    except HTTPException:
        target.unlink(missing_ok=True)
        raise
    except Exception as exc:
        target.unlink(missing_ok=True)
        raise HTTPException(status_code=502, detail=f"Download failed: {exc}") from exc
    record("minecraft.addon.install", actor=user.username, resource=sid, action="install", result="success",
           ip=_client_ip(request), detail={"kind": kind, "file": filename, "project": payload.projectId})
    return {
        "ok": True,
        "file": filename,
        "project": chosen.get("name") or payload.projectId,
        "versionNumber": chosen.get("version_number"),
        "message": f"Installed {filename}. Restart the server to load it.",
    }


# --------------------------------------------------------------------------- #
# catalogue + software change
# --------------------------------------------------------------------------- #

@router.get("/catalog")
def catalog(request: Request):
    _require_access(request)
    return _catalog()


class SoftwareChange(BaseModel):
    type: str = Field(min_length=3, max_length=20)
    version: str = Field(min_length=1, max_length=40)


@router.post("/servers/{sid}/software")
def change_software(sid: str, payload: SoftwareChange, request: Request):
    user = _require_access(request)
    server = _server(sid)
    _require_stopped(sid, "changing the server software")
    allowed = {"PAPER", "VANILLA", "FABRIC", "FORGE", "NEOFORGE", "PURPUR", "SPIGOT", "QUILT", "BUKKIT", "PAPERMC"}
    kind = payload.type.upper()
    if kind not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported server software")
    version = payload.version.strip()
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$", version):
        raise HTTPException(status_code=400, detail="Invalid version")
    with _server_lock:
        servers = _load()
        target = _find(servers, sid)
        if not target:
            raise HTTPException(status_code=404, detail="Server not found")
        target["type"] = kind
        target["version"] = version
        _save(servers)
    if _docker_status(sid).get("exists"):
        _run(["docker", "rm", "-f", _container_name(sid)], timeout=90)
    record("minecraft.software.change", actor=user.username, resource=sid, action="change", result="success",
           ip=_client_ip(request), detail={"type": kind, "version": version})
    return {
        "ok": True,
        "type": kind,
        "version": version,
        "message": f"Server software set to {kind} {version}. Start the server to install it.",
        "previous": {"type": server.get("type"), "version": server.get("version")},
    }
