from __future__ import annotations

import mimetypes
import os
import re
import shutil
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse

from app.auth import require_user
from app.audit import record

router = APIRouter(prefix="/s3", tags=["s3"])

ROOT = Path(os.getenv("KDG_S3_ROOT", "/home/tabahi/kdg-dev/kdg-api/kdg-s3")).resolve()
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")


def _ensure_root() -> None:
    if ROOT.exists():
        return
    try:
        ROOT.mkdir(parents=True, exist_ok=True)
    except OSError:
        # if it appeared concurrently or mount quirks, ignore when usable
        if not ROOT.exists():
            raise


def _validate_bucket(name: str) -> str:
    name = (name or "").strip()
    if not BUCKET_RE.match(name) or ".." in name:
        raise HTTPException(status_code=400, detail="Invalid bucket name")
    return name


def _bucket_path(name: str) -> Path:
    name = _validate_bucket(name)
    p = (ROOT / name).resolve()
    if p != ROOT / name or ROOT not in p.parents:
        raise HTTPException(status_code=400, detail="Invalid bucket path")
    return p


def _safe_object_path(bucket: str, key: str) -> Path:
    b = _bucket_path(bucket)
    key = (key or "").lstrip("/")
    if not key or "\x00" in key:
        raise HTTPException(status_code=400, detail="Invalid object key")
    p = (b / key).resolve()
    if b != p and b not in p.parents:
        raise HTTPException(status_code=400, detail="Invalid object path")
    return p


def _bucket_info(name: str) -> dict[str, Any]:
    p = _bucket_path(name)
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=404, detail="Bucket not found")
    objects = 0
    size_bytes = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                st = os.stat(os.path.join(root, f))
                if stat.S_ISREG(st.st_mode):
                    objects += 1
                    size_bytes += st.st_size
            except OSError:
                pass
    try:
        created = datetime.fromtimestamp(p.stat().st_ctime, tz=timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        created = ""
    return {
        "name": name,
        "region": "kdg-local",
        "objects": objects,
        "sizeBytes": size_bytes,
        "versioning": "Disabled",
        "access": "Private",
        "created": created,
    }


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else ""


@router.get("/buckets")
def list_buckets(request: Request):
    require_user(request)
    _ensure_root()
    items = []
    try:
        for child in sorted(ROOT.iterdir(), key=lambda x: x.name.lower()):
            if child.is_dir() and BUCKET_RE.match(child.name):
                try:
                    items.append(_bucket_info(child.name))
                except Exception:
                    pass
    except Exception:
        pass
    return items


@router.post("/buckets")
def create_bucket(payload: dict, request: Request):
    user = require_user(request)
    _ensure_root()
    name = _validate_bucket(str(payload.get("name", "")))
    p = _bucket_path(name)
    if p.exists():
        raise HTTPException(status_code=409, detail="Bucket already exists")
    p.mkdir(parents=False, exist_ok=False)
    record("s3.bucket.create", actor=user.username, resource=name, action="create", result="success", ip=_client_ip(request))
    return _bucket_info(name)


@router.delete("/buckets/{bucket}")
def delete_bucket(bucket: str, request: Request):
    user = require_user(request)
    p = _bucket_path(bucket)
    if not p.exists() or not p.is_dir():
        raise HTTPException(status_code=404, detail="Bucket not found")
    # only allow deleting empty buckets for safety
    try:
        next(p.iterdir())
        raise HTTPException(status_code=400, detail="Bucket is not empty")
    except StopIteration:
        pass
    p.rmdir()
    record("s3.bucket.delete", actor=user.username, resource=bucket, action="delete", result="success", ip=_client_ip(request))
    return {"ok": True}


@router.get("/buckets/{bucket}/objects")
def list_objects(bucket: str, request: Request, prefix: str = Query(default="")):
    require_user(request)
    b = _bucket_path(bucket)
    if not b.exists() or not b.is_dir():
        raise HTTPException(status_code=404, detail="Bucket not found")
    prefix = (prefix or "").lstrip("/")
    if "\x00" in prefix or ".." in prefix.split("/"):
        raise HTTPException(status_code=400, detail="Invalid prefix")
    base = (b / prefix).resolve() if prefix else b
    if b != base and b not in base.parents:
        raise HTTPException(status_code=400, detail="Invalid prefix")
    if not base.exists():
        return []
    items = []
    try:
        for child in sorted(base.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            rel = str(child.relative_to(b)).replace("\\", "/")
            if child.is_dir():
                items.append({"key": rel.rstrip("/") + "/", "sizeBytes": 0, "modified": "", "contentType": "", "isPrefix": True})
            elif child.is_file():
                try:
                    st = child.stat()
                    mt = mimetypes.guess_type(child.name)[0] or "application/octet-stream"
                    mod = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
                    items.append({"key": rel, "sizeBytes": st.st_size, "modified": mod, "contentType": mt})
                except OSError:
                    pass
    except OSError:
        pass
    return items


@router.post("/buckets/{bucket}/objects")
async def upload_object(bucket: str, request: Request, key: str = Form(default=""), file: UploadFile = File(...)):
    user = require_user(request)
    b = _bucket_path(bucket)
    if not b.exists() or not b.is_dir():
        raise HTTPException(status_code=404, detail="Bucket not found")
    name = key.strip() if key and key.strip() else (file.filename or "upload.bin")
    name = name.lstrip("/")
    target = _safe_object_path(bucket, name)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        with target.open("wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    finally:
        await file.close()
    record("s3.object.put", actor=user.username, resource=f"{bucket}/{name}", action="write", result="success", ip=_client_ip(request))
    try:
        st = target.stat()
        mt = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        mod = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")
        return {"key": name, "sizeBytes": st.st_size, "modified": mod, "contentType": mt}
    except Exception:
        return {"key": name, "sizeBytes": 0, "modified": "", "contentType": "application/octet-stream"}


@router.get("/buckets/{bucket}/download")
def download_object(bucket: str, request: Request, key: str = Query(...)):
    require_user(request)
    target = _safe_object_path(bucket, key)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="Object not found")
    mt = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    return FileResponse(str(target), filename=target.name, media_type=mt)


@router.delete("/buckets/{bucket}/objects")
def delete_object(bucket: str, request: Request, key: str = Query(...)):
    user = require_user(request)
    target = _safe_object_path(bucket, key)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Object not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    record("s3.object.delete", actor=user.username, resource=f"{bucket}/{key}", action="delete", result="success", ip=_client_ip(request))
    return {"ok": True}
