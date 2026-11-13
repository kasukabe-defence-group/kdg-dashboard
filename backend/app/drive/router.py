from __future__ import annotations

import os
from typing import Annotated
from urllib.parse import urlsplit

import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Header, Query, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from app.auth import current_user
from app.drive.nextcloud import DriveError, NextcloudClient, NextcloudConfig, normalize_path, obtain_nextcloud_sso_cookies, validate_name
from app.drive.schemas import (
    DriveItem,
    FavoriteRequest,
    FileListResponse,
    FolderCreateRequest,
    ItemDeleteRequest,
    ItemPatchRequest,
    ShareCreateRequest,
    StorageResponse,
    TrashDeleteRequest,
    TrashRestoreRequest,
)

router = APIRouter(prefix="/drive", tags=["drive"])


def require_safe_origin(request: Request, origin: str | None = Header(default=None)):
    allowed = {value.strip().rstrip("/") for value in os.getenv("KDG_ALLOWED_ORIGINS", "").split(",") if value.strip()}
    host = request.headers.get("x-forwarded-host", "").split(",")[0].strip() or request.headers.get("host", "").strip()
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip() or request.url.scheme
    if host:
        allowed.add(f"{proto}://{host}".rstrip("/"))
    if not origin:
        ref = request.headers.get("referer")
        if ref:
            try:
                p = urlsplit(ref)
                if p.scheme and p.netloc:
                    origin = f"{p.scheme}://{p.netloc}"
            except Exception:
                origin = None
    if origin and allowed and origin.rstrip("/") not in allowed:
        raise DriveError(403, "origin_not_allowed", "This browser origin is not allowed to modify Drive data.")


def client() -> NextcloudClient:
    return NextcloudClient(NextcloudConfig.from_env())


def to_item(raw: dict) -> DriveItem:
    return DriveItem(**{key: value for key, value in raw.items() if key in DriveItem.model_fields})


@router.get("/files", response_model=FileListResponse)
def files(
    path: str = Query("/"),
    page: int = Query(1, ge=1, le=100000),
    limit: int = Query(100, ge=1, le=500),
    sort: str = Query("name", pattern="^(name|size|modified)$"),
    order: str = Query("asc", pattern="^(asc|desc)$"),
    search: str | None = Query(None, max_length=200),
):
    normalized = normalize_path(path)
    nc = client()
    items = nc.list_recursive(normalized) if search else nc.list_directory(normalized)
    if search:
        needle = search.casefold()
        items = [item for item in items if needle in item["name"].casefold() or needle in item["path"].casefold()]
    items.sort(key=lambda item: (item["fileType"] != "folder", str(item.get(sort) or "").casefold() if sort == "name" else item.get(sort) or 0), reverse=order == "desc")
    start = (page - 1) * limit
    return FileListResponse(items=[to_item(item) for item in items[start : start + limit]], path=normalized, page=page, limit=limit, total=len(items))


@router.post("/folders", response_model=dict, dependencies=[Depends(require_safe_origin)])
def folders(payload: FolderCreateRequest):
    return client().create_folder(payload.path, payload.name)


@router.patch("/items", response_model=dict, dependencies=[Depends(require_safe_origin)])
def patch_item(payload: ItemPatchRequest):
    return {"ok": True, "path": client().move(payload.path, payload.name, payload.destination)}


@router.delete("/items", response_model=dict, dependencies=[Depends(require_safe_origin)])
def delete_item(payload: ItemDeleteRequest):
    client().delete(payload.path)
    return {"ok": True, "path": normalize_path(payload.path, allow_root=False)}


@router.post("/upload", response_model=dict, dependencies=[Depends(require_safe_origin)])
def upload(path: Annotated[str, Form()] = "/", file: UploadFile = File(...)):
    if not file.filename:
        raise DriveError(400, "invalid_upload", "The uploaded file has no filename.")
    try:
        file.file.seek(0, 2)
        size = file.file.tell()
        file.file.seek(0)
    except (OSError, AttributeError) as exc:
        raise DriveError(400, "invalid_upload", "The uploaded file could not be read.") from exc
    result = client().upload(path, validate_name(file.filename), file.file, size, file.content_type)
    file.file.close()
    return result


@router.get("/download")
def download(path: str = Query(..., min_length=2), inline: bool = Query(False)):
    stream = client().download(path)
    disposition = "inline" if inline else "attachment"
    safe_name = stream.filename.replace(chr(34), "").replace("\r", "").replace("\n", "")
    headers = {"Content-Disposition": f'{disposition}; filename="{safe_name}"', "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"}
    if stream.content_length:
        headers["Content-Length"] = stream.content_length
    if stream.etag:
        headers["ETag"] = stream.etag
    if stream.last_modified:
        headers["Last-Modified"] = stream.last_modified
    return StreamingResponse(stream.iterator, media_type=stream.content_type, headers=headers)


@router.get("/preview")
def preview(path: str = Query(..., min_length=2), size: int = Query(256, ge=32, le=2048), token: str = Query(""), if_none_match: str | None = Header(default=None)):
    result = client().preview(path, size=size, token=token, if_none_match=if_none_match)
    etag = f'"{result.etag.strip("\"")}"'
    headers = {"Cache-Control": "private, max-age=86400, stale-while-revalidate=604800", "ETag": etag, "X-Content-Type-Options": "nosniff"}
    if result.not_modified:
        return Response(status_code=304, headers=headers)
    headers["X-Cache"] = "HIT" if result.cache_hit else "MISS"
    return Response(content=result.content, media_type=result.content_type, headers=headers)


@router.get("/storage", response_model=StorageResponse)
def storage():
    return client().storage()


@router.get("/favorites", response_model=list[DriveItem])
def favorites():
    return [to_item(item) for item in client().list_recursive(favorites_only=True)]


@router.post("/favorites", response_model=dict, dependencies=[Depends(require_safe_origin)])
def add_favorite(payload: FavoriteRequest):
    return client().set_favorite(_file_id_from_path(payload.path), payload.favorite)


@router.delete("/favorites/{file_id}", response_model=dict, dependencies=[Depends(require_safe_origin)])
def remove_favorite(file_id: str):
    return client().set_favorite(file_id, False)


def _file_id_from_path(path: str) -> str:
    normalized = normalize_path(path, allow_root=False)
    match = next((item for item in client().list_recursive() if item["path"] == normalized), None)
    if not match or not match.get("fileId"):
        raise DriveError(404, "not_found", "The requested Drive item was not found.")
    return str(match["fileId"])


@router.get("/shares", response_model=list[dict])
def shares():
    result = []
    for share in client().shares():
        if not isinstance(share, dict):
            continue
        result.append({
            "id": int(share.get("id") or share.get("share_id") or 0),
            "path": share.get("path", ""),
            "shareType": int(share.get("share_type") or share.get("shareType") or 0),
            "shareWith": share.get("share_with") or share.get("shareWith"),
            "shareWithDisplayName": share.get("share_with_displayname") or share.get("shareWithDisplayName"),
            "permissions": int(share.get("permissions") or 1),
            "url": share.get("url"),
            "expiration": share.get("expiration_date") or share.get("expireDate"),
        })
    return result


@router.post("/shares", response_model=dict, dependencies=[Depends(require_safe_origin)])
def create_share(payload: ShareCreateRequest):
    return client().create_share(payload.path, payload.shareType, payload.shareWith, payload.permissions, payload.expireDate.isoformat() if payload.expireDate else None)


@router.delete("/shares/{share_id}", response_model=dict, dependencies=[Depends(require_safe_origin)])
def remove_share(share_id: int):
    client().delete_share(share_id)
    return {"ok": True, "shareId": share_id}


@router.get("/trash", response_model=list[DriveItem])
def trash():
    return [to_item({**item, "trashed": True}) for item in client().trash()]


@router.post("/trash/restore", response_model=dict, dependencies=[Depends(require_safe_origin)])
def restore_trash(payload: TrashRestoreRequest):
    client().restore(payload.path)
    return {"ok": True, "path": normalize_path(payload.path, allow_root=False)}


@router.delete("/trash", response_model=dict, dependencies=[Depends(require_safe_origin)])
def delete_trash(payload: TrashDeleteRequest):
    nc = client()
    if payload.empty:
        for item in nc.trash():
            nc.delete_trash(item["path"])
        return {"ok": True, "emptied": True}
    if not payload.path:
        raise DriveError(400, "trash_path_required", "Specify a trash item or set empty=true.")
    nc.delete_trash(payload.path)
    return {"ok": True, "path": normalize_path(payload.path, allow_root=False)}


@router.post("/nextcloud/sso", response_model=dict, dependencies=[Depends(require_safe_origin)])
def nextcloud_sso(request: Request):
    user = current_user(request)
    base = os.getenv("NEXTCLOUD_SSO_BASE_URL", os.getenv("NEXTCLOUD_INTERNAL_URL", "")).strip().rstrip("/")
    username = os.getenv("NEXTCLOUD_SSO_USERNAME", "kdgadmin").strip()
    password = os.getenv("NEXTCLOUD_SSO_PASSWORD", "")
    map_path = Path(os.getenv("KDG_NC_SSO_MAP_FILE", "/home/tabahi/kdg-dev/kdg-api/kdg-nc-sso-map.json"))
    if user and map_path.exists():
        try:
            mapping = json.loads(map_path.read_text(encoding="utf-8"))
            entry = mapping.get(user.username) or mapping.get(user.username.casefold())
            if isinstance(entry, dict) and entry.get("nc_user") and entry.get("nc_password"):
                username = str(entry["nc_user"])
                password = str(entry["nc_password"])
        except Exception:
            pass
    if not base or not password:
        raise DriveError(503, "nextcloud_sso_not_configured", "Nextcloud SSO is not configured on the server.")
    cookies = obtain_nextcloud_sso_cookies(base, username, password)
    secure = str(request.url.scheme).lower() == "https" or request.headers.get("x-forwarded-proto", "").lower() == "https"
    response = JSONResponse({"ok": True, "redirectPath": "/drive/", "nextcloudUser": username})
    for name, value, opts in cookies:
        response.set_cookie(name, value, path=opts.get("path", "/drive"), secure=secure, httponly=bool(opts.get("httponly", True)), samesite=opts.get("samesite", "lax"))
    return response
