from __future__ import annotations

import hashlib
import html
import os
import re
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterator
import urllib.request, urllib.parse, http.cookiejar
from urllib.parse import quote, unquote, urlencode, urlsplit
from xml.etree import ElementTree

import httpx


class DriveError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class NextcloudConfigError(DriveError):
    def __init__(self, message: str):
        super().__init__(503, "nextcloud_not_configured", message)


@dataclass(frozen=True)
class NextcloudConfig:
    base_url: str
    public_url: str | None
    username: str
    app_password: str
    timeout: float = 30.0
    max_upload_bytes: int = 5 * 1024 * 1024 * 1024

    @classmethod
    def from_env(cls) -> "NextcloudConfig":
        base_url = os.getenv("NEXTCLOUD_INTERNAL_URL", "").strip().rstrip("/")
        username = os.getenv("NEXTCLOUD_USERNAME", "").strip()
        app_password = os.getenv("NEXTCLOUD_APP_PASSWORD", "")
        if not base_url or not username or not app_password:
            raise NextcloudConfigError(
                "Nextcloud Drive is not configured on the server. Contact an administrator."
            )
        try:
            timeout = max(1.0, float(os.getenv("NEXTCLOUD_TIMEOUT", "30")))
            max_upload = int(os.getenv("NEXTCLOUD_MAX_UPLOAD_BYTES", str(5 * 1024**3)))
        except ValueError as exc:
            raise NextcloudConfigError("Nextcloud configuration contains an invalid limit.") from exc
        if urlsplit(base_url).scheme not in {"http", "https"} or not urlsplit(base_url).netloc:
            raise NextcloudConfigError("Nextcloud internal URL is invalid.")
        return cls(
            base_url=base_url,
            public_url=os.getenv("NEXTCLOUD_PUBLIC_URL", "").strip().rstrip("/") or None,
            username=username,
            app_password=app_password,
            timeout=timeout,
            max_upload_bytes=max(1, max_upload),
        )


def normalize_path(value: str | None, *, allow_root: bool = True) -> str:
    raw = value or "/"
    if "\x00" in raw or "\\" in raw:
        raise DriveError(400, "invalid_path", "The path is invalid.")
    decoded = raw
    for _ in range(3):
        next_value = unquote(decoded)
        if next_value == decoded:
            break
        decoded = next_value
    if "\x00" in decoded or "\\" in decoded or not decoded.startswith("/"):
        raise DriveError(400, "invalid_path", "The path must be rooted at /.")
    parts = [part for part in decoded.split("/") if part]
    if any(part in {".", ".."} for part in parts):
        raise DriveError(400, "invalid_path", "Path traversal is not allowed.")
    if any(any(ord(char) < 32 for char in part) for part in parts):
        raise DriveError(400, "invalid_path", "The path contains invalid characters.")
    normalized = "/" + "/".join(parts)
    if not allow_root and normalized == "/":
        raise DriveError(400, "invalid_path", "The root path cannot be modified.")
    return normalized


def validate_name(value: str) -> str:
    if not value or value in {".", ".."} or "/" in value or "\\" in value or "\x00" in value:
        raise DriveError(400, "invalid_name", "The file or folder name is invalid.")
    if any(ord(char) < 32 for char in value):
        raise DriveError(400, "invalid_name", "The file or folder name is invalid.")
    return value


@dataclass
class DownloadStream:
    iterator: Iterator[bytes]
    content_type: str
    content_length: str | None
    filename: str
    etag: str | None = None
    last_modified: str | None = None


@dataclass
class PreviewResult:
    content: bytes
    content_type: str
    etag: str
    cache_hit: bool = False
    not_modified: bool = False

PREVIEW_CACHE_DIR = Path(os.getenv("KDG_DRIVE_CACHE_DIR", "/home/tabahi/kdg-dev/kdg-api/kdg-cache/previews"))
PREVIEW_CACHE_TTL = int(os.getenv("KDG_DRIVE_PREVIEW_TTL", "86400"))
PREVIEW_CACHE_MAX_BYTES = int(os.getenv("KDG_DRIVE_PREVIEW_CACHE_MAX_BYTES", str(512 * 1024 * 1024)))


def _preview_cache_key(path: str, size: int, token: str) -> Path:
    h = hashlib.sha256(f"{path}\n{size}\n{token}".encode("utf-8", "ignore")).hexdigest()
    return PREVIEW_CACHE_DIR / h[:2] / h[2:4] / f"{h}.bin"


def _preview_cache_meta(key: Path) -> Path:
    return key.with_suffix(".meta")


def _cache_get(path: str, size: int, token: str, etag: str | None = None) -> tuple[bytes, str] | None:
    key = _preview_cache_key(path, size, token)
    meta_path = _preview_cache_meta(key)
    try:
        if not key.exists() or not meta_path.exists():
            return None
        meta = meta_path.read_text(encoding="utf-8").splitlines()
        content_type = meta[0] if meta else "image/jpeg"
        saved_etag = meta[1] if len(meta) > 1 else ""
        saved_at = float(meta[2]) if len(meta) > 2 else 0
        if etag and saved_etag and etag != saved_etag:
            return None
        if not etag and PREVIEW_CACHE_TTL > 0 and (time.time() - saved_at) > PREVIEW_CACHE_TTL:
            return None
        return key.read_bytes(), content_type
    except Exception:
        return None


def _cache_put(path: str, size: int, token: str, content: bytes, content_type: str, etag_value: str) -> None:
    try:
        PREVIEW_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        key = _preview_cache_key(path, size, token)
        key.parent.mkdir(parents=True, exist_ok=True)
        key.write_bytes(content)
        _preview_cache_meta(key).write_text(f"{content_type}\n{etag_value}\n{time.time()}", encoding="utf-8")
    except Exception:
        pass


def _cache_prune_if_needed(max_bytes: int = PREVIEW_CACHE_MAX_BYTES) -> None:
    try:
        if not PREVIEW_CACHE_DIR.exists():
            return
        files = [p for p in PREVIEW_CACHE_DIR.rglob("*.bin") if p.is_file()]
        total = sum(p.stat().st_size for p in files)
        if total <= max_bytes:
            return
        files.sort(key=lambda p: p.stat().st_mtime)
        for p in files:
            try:
                size = p.stat().st_size
                p.unlink(missing_ok=True)
                _preview_cache_meta(p).unlink(missing_ok=True)
                total -= size
                if total <= int(max_bytes * 0.8):
                    break
            except Exception:
                pass
    except Exception:
        pass


def obtain_nextcloud_sso_cookies(base_url: str, username: str, password: str) -> list[tuple[str, str, dict[str, Any]]]:
    base = base_url.rstrip("/")
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    login_url = f"{base}/login"
    try:
        with opener.open(urllib.request.Request(login_url), timeout=15) as resp:
            html = resp.read().decode("utf-8", "ignore")
    except Exception as exc:
        raise DriveError(502, "nextcloud_unavailable", "Could not reach Nextcloud for SSO login.") from exc
    match = re.search(r'data-requesttoken="([^"]+)"', html) or re.search(r'name="requesttoken" value="([^"]+)"', html)
    if not match:
        raise DriveError(502, "nextcloud_sso_failed", "Could not start a Nextcloud login session.")
    token = match.group(1)
    data = urllib.parse.urlencode({"user": username, "password": password, "requesttoken": token}).encode()
    req = urllib.request.Request(login_url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with opener.open(req, timeout=15):
            pass
    except Exception as exc:
        raise DriveError(502, "nextcloud_sso_failed", "Nextcloud rejected the SSO login.") from exc
    cookies = []
    for cookie in cj:
        if cookie.name and cookie.value:
            cookies.append((cookie.name, cookie.value, {"path": cookie.path or "/drive", "secure": False, "httponly": True, "samesite": "lax"}))
    if not cookies:
        raise DriveError(502, "nextcloud_sso_failed", "Nextcloud did not establish a session.")
    return cookies


class NextcloudClient:
    def __init__(self, config: NextcloudConfig):
        self.config = config

    def _client(self) -> httpx.Client:
        return httpx.Client(
            auth=(self.config.username, self.config.app_password),
            timeout=httpx.Timeout(self.config.timeout),
            follow_redirects=False,
        )

    def _url(self, suffix: str) -> str:
        return f"{self.config.base_url}/{suffix.lstrip('/')}"

    def _dav_url(self, path: str = "/") -> str:
        path = normalize_path(path)
        root = f"remote.php/dav/files/{quote(self.config.username, safe='')}"
        suffix = "/".join(quote(part, safe="") for part in path.strip("/").split("/") if part)
        return self._url(f"{root}/{suffix}" if suffix else f"{root}/")

    def _trash_url(self, path: str = "/") -> str:
        path = normalize_path(path)
        root = f"remote.php/dav/trash-bin/{quote(self.config.username, safe='')}"
        suffix = "/".join(quote(part, safe="") for part in path.strip("/").split("/") if part)
        return self._url(f"{root}/{suffix}" if suffix else f"{root}/")

    @staticmethod
    def _error(response: httpx.Response, fallback: str) -> DriveError:
        status = response.status_code
        if status in {401, 403}:
            return DriveError(502, "nextcloud_authentication", "Nextcloud rejected the server credentials.")
        if status == 404:
            return DriveError(404, "not_found", "The requested Drive item was not found.")
        if status in {409, 412}:
            return DriveError(409, "already_exists", "An item with that name already exists.")
        if status == 507:
            return DriveError(507, "quota_exceeded", "Nextcloud does not have enough available storage.")
        if status >= 500:
            return DriveError(502, "nextcloud_unavailable", "Nextcloud is temporarily unavailable.")
        return DriveError(502, "nextcloud_error", fallback)

    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        try:
            with self._client() as client:
                response = client.request(method, url, **kwargs)
        except httpx.TimeoutException as exc:
            raise DriveError(504, "nextcloud_timeout", "Nextcloud did not respond in time.") from exc
        except httpx.HTTPError as exc:
            raise DriveError(502, "nextcloud_unavailable", "Nextcloud could not be reached.") from exc
        if response.status_code >= 400:
            raise self._error(response, "Nextcloud rejected the request.")
        return response

    @staticmethod
    def _local_name(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    def _parse_propfind(self, response: httpx.Response, requested_path: str, trash: bool = False) -> list[dict[str, Any]]:
        try:
            root = ElementTree.fromstring(response.content)
        except ElementTree.ParseError as exc:
            raise DriveError(502, "invalid_nextcloud_response", "Nextcloud returned invalid file metadata.") from exc
        base = urlsplit(self._trash_url() if trash else self._dav_url()).path.rstrip("/")
        requested_path = normalize_path(requested_path)
        result: list[dict[str, Any]] = []
        for response_node in root.iter():
            if self._local_name(response_node.tag) != "response":
                continue
            href = next((child.text or "" for child in response_node if self._local_name(child.tag) == "href"), "")
            href_path = unquote(urlsplit(href).path or href).rstrip("/") or "/"
            if href_path == base:
                item_path = "/"
            elif href_path.startswith(base + "/"):
                item_path = normalize_path(href_path[len(base):])
            else:
                continue
            prop: dict[str, str] = {}
            for child in response_node.iter():
                if self._local_name(child.tag) == "prop":
                    for prop_node in child:
                        prop[self._local_name(prop_node.tag)] = (prop_node.text or "").strip()
            is_folder = any(self._local_name(node.tag) == "collection" for node in response_node.iter())
            name = item_path.rsplit("/", 1)[-1] or "/"
            size = 0
            try:
                size = max(0, int(prop.get("getcontentlength", "0")))
            except ValueError:
                pass
            result.append({
                "name": name,
                "path": item_path,
                "fileType": "folder" if is_folder else "file",
                "mimeType": prop.get("getcontenttype") or None,
                "sizeBytes": size,
                "modified": prop.get("getlastmodified") or None,
                "etag": prop.get("getetag") or None,
                "fileId": prop.get("fileid") or None,
                "owner": prop.get("owner-display-name") or prop.get("owner-id") or None,
                "starred": prop.get("favorite", "0").lower() in {"1", "true"},
                "shared": bool(prop.get("share-types", "").strip("0 ")),
                "originalPath": prop.get("trashbin-original-location") or prop.get("original-location") or None,
                "deletedAt": prop.get("trashbin-deletion-time") or None,
            })
        return [item for item in result if item["path"] != requested_path]

    def list_directory(self, path: str = "/") -> list[dict[str, Any]]:
        path = normalize_path(path)
        body = """<?xml version=\"1.0\" encoding=\"utf-8\"?>
<d:propfind xmlns:d=\"DAV:\" xmlns:oc=\"http://owncloud.org/ns\">
  <d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/>
  <oc:fileid/><oc:owner-id/><oc:owner-display-name/><oc:favorite/><oc:permissions/><oc:share-types/></d:prop>
</d:propfind>"""
        response = self._request("PROPFIND", self._dav_url(path), headers={"Depth": "1", "Content-Type": "application/xml"}, content=body)
        return self._parse_propfind(response, path)

    def list_recursive(self, path: str = "/", *, favorites_only: bool = False, limit: int = 10000) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        queue = [normalize_path(path)]
        visited: set[str] = set()
        while queue and len(found) < limit:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)
            for item in self.list_directory(current):
                if item["fileType"] == "folder":
                    queue.append(item["path"])
                if not favorites_only or item.get("starred"):
                    found.append(item)
                    if len(found) >= limit:
                        break
        return found

    def create_folder(self, parent: str, name: str) -> dict[str, Any]:
        parent = normalize_path(parent)
        name = validate_name(name.strip())
        path = normalize_path(f"{parent.rstrip('/')}/{name}")
        response = self._request("MKCOL", self._dav_url(path))
        return {"ok": True, "path": path, "name": name, "status": response.status_code}

    def move(self, path: str, name: str | None = None, destination: str | None = None) -> str:
        source = normalize_path(path, allow_root=False)
        if destination is not None:
            destination_path = normalize_path(destination, allow_root=False)
        else:
            if not name:
                raise DriveError(400, "invalid_move", "A destination or new name is required.")
            destination_path = normalize_path(f"{source.rsplit('/', 1)[0] or '/'}/{validate_name(name.strip())}")
        response = self._request("MOVE", self._dav_url(source), headers={"Destination": self._dav_url(destination_path), "Overwrite": "F"})
        return destination_path

    def delete(self, path: str) -> None:
        self._request("DELETE", self._dav_url(normalize_path(path, allow_root=False)))

    def upload(self, parent: str, filename: str, fileobj: BinaryIO, size: int, content_type: str | None) -> dict[str, Any]:
        parent = normalize_path(parent)
        filename = validate_name(filename)
        if size > self.config.max_upload_bytes:
            raise DriveError(413, "upload_too_large", "The upload exceeds the configured size limit.")
        path = normalize_path(f"{parent.rstrip('/')}/{filename}")
        try:
            fileobj.seek(0)
        except (AttributeError, OSError) as exc:
            raise DriveError(400, "invalid_upload", "The uploaded file could not be read.") from exc

        def chunks() -> Iterator[bytes]:
            remaining = size
            while remaining:
                chunk = fileobj.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

        headers = {"Content-Length": str(size), "If-None-Match": "*"}
        if content_type:
            headers["Content-Type"] = content_type
        self._request("PUT", self._dav_url(path), headers=headers, content=chunks())
        metadata = next((item for item in self.list_directory(parent) if item["path"] == path), None)
        return {"ok": True, **(metadata or {"path": path, "name": filename, "sizeBytes": size})}

    def download(self, path: str) -> DownloadStream:
        path = normalize_path(path, allow_root=False)
        client = self._client()
        try:
            stream_cm = client.stream("GET", self._dav_url(path))
            response = stream_cm.__enter__()
            if response.status_code >= 400:
                error = self._error(response, "Nextcloud rejected the download.")
                try:
                    stream_cm.__exit__(None, None, None)
                except Exception:
                    pass
                client.close()
                raise error
        except DriveError:
            raise
        except httpx.TimeoutException as exc:
            try:
                client.close()
            except Exception:
                pass
            raise DriveError(504, "nextcloud_timeout", "Nextcloud did not respond in time.") from exc
        except httpx.HTTPError as exc:
            try:
                client.close()
            except Exception:
                pass
            raise DriveError(502, "nextcloud_unavailable", "Nextcloud could not be reached.") from exc

        def iterator() -> Iterator[bytes]:
            try:
                yield from response.iter_bytes(1024 * 1024)
            finally:
                try:
                    stream_cm.__exit__(None, None, None)
                except Exception:
                    pass
                try:
                    client.close()
                except Exception:
                    pass

        return DownloadStream(
            iterator=iterator(),
            content_type=response.headers.get("content-type", "application/octet-stream"),
            content_length=response.headers.get("content-length"),
            filename=path.rsplit("/", 1)[-1],
            etag=response.headers.get("etag"),
            last_modified=response.headers.get("last-modified"),
        )

    def preview(self, path: str, size: int = 256, token: str = "", if_none_match: str | None = None) -> PreviewResult:
        path = normalize_path(path, allow_root=False)
        size = max(32, min(int(size or 256), 2048))
        token = (token or "").strip().strip('"')
        cache_key = _preview_cache_key(path, size, token)
        cached = _cache_get(path, size, token, etag=token or None)
        if cached:
            content, content_type = cached
            etag_value = hashlib.sha1(f"{path}|{size}|{token}|{len(content)}".encode()).hexdigest()
            if if_none_match and etag_value in {v.strip().strip('"') for v in if_none_match.split(',')}:
                return PreviewResult(content=b"", content_type=content_type, etag=etag_value, cache_hit=True, not_modified=True)
            return PreviewResult(content=content, content_type=content_type, etag=etag_value, cache_hit=True)

        # Try Nextcloud core preview endpoint
        params = {"file": path, "x": str(size), "y": str(size), "a": "1", "mode": "cover"}
        url = self._url(f"index.php/core/preview.png?{urlencode(params)}")
        try:
            with self._client() as client:
                response = client.get(url, headers={"Accept": "image/*,*/*"})
        except httpx.TimeoutException as exc:
            raise DriveError(504, "nextcloud_timeout", "Nextcloud did not respond in time.") from exc
        except httpx.HTTPError as exc:
            raise DriveError(502, "nextcloud_unavailable", "Nextcloud could not be reached.") from exc

        if response.status_code == 404:
            raise DriveError(404, "preview_not_available", "No preview is available for this file.")
        if response.status_code in {415, 400}:
            raise DriveError(415, "preview_not_supported", "Preview is not supported for this file type.")
        if response.status_code >= 400:
            # fallback: for images try direct download content as preview (small)
            raise self._error(response, "Nextcloud could not generate a preview.")

        content = response.content
        content_type = response.headers.get("content-type", "image/png").split(";")[0].strip() or "image/png"
        if not content_type.startswith("image/"):
            raise DriveError(415, "preview_not_supported", "Preview is not supported for this file type.")
        etag_value = (response.headers.get("etag") or hashlib.sha1(f"{path}|{size}|{token}|{len(content)}".encode()).hexdigest()).strip('"')
        _cache_put(path, size, token, content, content_type, etag_value)
        _cache_prune_if_needed()
        if if_none_match and etag_value in {v.strip().strip('"') for v in if_none_match.split(',')}:
            return PreviewResult(content=b"", content_type=content_type, etag=etag_value, not_modified=True)
        return PreviewResult(content=content, content_type=content_type, etag=etag_value)

    def storage(self) -> dict[str, Any]:
        body = """<?xml version=\"1.0\" encoding=\"utf-8\"?>
<d:propfind xmlns:d=\"DAV:\" xmlns:oc=\"http://owncloud.org/ns\"><d:prop>
<oc:quota-used-bytes/><oc:quota-available-bytes/><d:quota-used-bytes/><d:quota-available-bytes/>
</d:prop></d:propfind>"""
        response = self._request("PROPFIND", self._dav_url("/"), headers={"Depth": "0", "Content-Type": "application/xml"}, content=body)
        parsed = self._parse_propfind_root_properties(response)
        used = self._number_property(parsed, "quota-used-bytes") or 0
        available = self._number_property(parsed, "quota-available-bytes")
        unlimited = available is None or available < 0
        free = None if unlimited else max(0, available)
        total = None if unlimited else used + free
        return {"usedBytes": used, "freeBytes": free, "totalBytes": total, "percentageUsed": None if unlimited or not total else round(used / total * 100, 2), "unlimited": unlimited}

    def _parse_propfind_root_properties(self, response: httpx.Response) -> dict[str, str]:
        try:
            root = ElementTree.fromstring(response.content)
        except ElementTree.ParseError as exc:
            raise DriveError(502, "invalid_nextcloud_response", "Nextcloud returned invalid storage metadata.") from exc
        props: dict[str, str] = {}
        for node in root.iter():
            if self._local_name(node.tag) == "prop":
                for child in node:
                    props[self._local_name(child.tag)] = (child.text or "").strip()
        return props

    @staticmethod
    def _number_property(props: dict[str, str], name: str) -> int | None:
        for key in (name, name.replace("quota-", "")):
            try:
                if key in props:
                    return int(props[key])
            except ValueError:
                return None
        return None

    def set_favorite(self, file_id: str, favorite: bool) -> dict[str, Any]:
        if not file_id or len(file_id) > 128 or not re.fullmatch(r"[A-Za-z0-9_-]+", file_id):
            raise DriveError(400, "invalid_file_id", "The file ID is invalid.")
        matches = [item for item in self.list_recursive(favorites_only=False) if item.get("fileId") == file_id]
        if not matches:
            raise DriveError(404, "not_found", "The requested Drive item was not found.")
        path = matches[0]["path"]
        value = "1" if favorite else "0"
        body = f"""<?xml version=\"1.0\" encoding=\"utf-8\"?>
<d:propertyupdate xmlns:d=\"DAV:\" xmlns:oc=\"http://owncloud.org/ns\"><d:set><d:prop><oc:favorite>{value}</oc:favorite></d:prop></d:set></d:propertyupdate>"""
        self._request("PROPPATCH", self._dav_url(path), headers={"Content-Type": "application/xml"}, content=body)
        return {"ok": True, "fileId": file_id, "favorite": favorite}

    def shares(self) -> list[dict[str, Any]]:
        payload = self._ocs("GET", "remote.php/dav", params={})
        return payload if isinstance(payload, list) else []

    def _ocs(self, method: str, _unused: str = "", *, params: dict[str, Any] | None = None, data: dict[str, Any] | None = None, share_id: int | None = None) -> Any:
        suffix = "ocs/v2.php/apps/files_sharing/api/v1/shares"
        if share_id is not None:
            suffix += f"/{share_id}"
        query = {"format": "json"}
        if params:
            query.update(params)
        url = self._url(f"{suffix}?{urlencode(query)}")
        try:
            with self._client() as client:
                response = client.request(method, url, headers={"OCS-APIRequest": "true", "Accept": "application/json"}, data=data)
        except httpx.TimeoutException as exc:
            raise DriveError(504, "nextcloud_timeout", "Nextcloud did not respond in time.") from exc
        except httpx.HTTPError as exc:
            raise DriveError(502, "nextcloud_unavailable", "Nextcloud could not be reached.") from exc
        if response.status_code >= 400:
            raise self._error(response, "Nextcloud rejected the sharing request.")
        try:
            parsed = response.json()
            meta = parsed.get("ocs", {}).get("meta", {})
            if int(meta.get("statuscode", 200)) >= 400:
                raise DriveError(502, "ocs_error", "Nextcloud rejected the sharing request.")
            return parsed.get("ocs", {}).get("data", [])
        except (ValueError, TypeError) as exc:
            raise DriveError(502, "invalid_nextcloud_response", "Nextcloud returned invalid share metadata.") from exc

    def create_share(self, path: str, share_type: str, share_with: str | None, permissions: int, expire_date: str | None) -> Any:
        path = normalize_path(path, allow_root=False)
        type_map = {"user": "0", "group": "1", "link": "3"}
        if share_type not in type_map:
            raise DriveError(400, "invalid_share_type", "The share type is invalid.")
        if share_type in {"user", "group"} and not share_with:
            raise DriveError(400, "share_recipient_required", "A user or group is required for this share.")
        if share_type == "link" and share_with:
            raise DriveError(400, "invalid_share_recipient", "Public links do not accept a recipient.")
        data: dict[str, Any] = {"path": path, "shareType": type_map[share_type], "permissions": str(permissions)}
        if share_with:
            data["shareWith"] = share_with.strip()
        if expire_date:
            data["expireDate"] = expire_date
        return self._ocs("POST", data=data)

    def delete_share(self, share_id: int) -> None:
        if share_id < 1:
            raise DriveError(400, "invalid_share_id", "The share ID is invalid.")
        self._ocs("DELETE", share_id=share_id)

    def trash(self) -> list[dict[str, Any]]:
        body = """<?xml version=\"1.0\" encoding=\"utf-8\"?>
<d:propfind xmlns:d=\"DAV:\" xmlns:oc=\"http://owncloud.org/ns\"><d:prop>
<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:getcontenttype/>
<oc:fileid/><oc:trashbin-original-location/><oc:trashbin-deletion-time/><oc:trashbin-original-filename/>
</d:prop></d:propfind>"""
        response = self._request("PROPFIND", self._trash_url("/"), headers={"Depth": "1", "Content-Type": "application/xml"}, content=body)
        return self._parse_propfind(response, "/", trash=True)

    def _trash_item(self, path: str) -> dict[str, Any]:
        path = normalize_path(path, allow_root=False)
        return next((item for item in self.trash() if item["path"] == path), None) or self._missing()

    @staticmethod
    def _missing() -> dict[str, Any]:
        raise DriveError(404, "not_found", "The requested trash item was not found.")

    def restore(self, path: str) -> None:
        item = self._trash_item(path)
        original = item.get("originalPath")
        if not original:
            raise DriveError(409, "restore_unavailable", "Nextcloud did not provide the original item path.")
        self._request("MOVE", self._trash_url(path), headers={"Destination": self._dav_url(normalize_path(original)), "Overwrite": "F"})

    def delete_trash(self, path: str) -> None:
        self._request("DELETE", self._trash_url(normalize_path(path, allow_root=False)))
