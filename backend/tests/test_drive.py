from __future__ import annotations

import io
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from app import auth
from app.drive.nextcloud import DownloadStream, DriveError, NextcloudClient, NextcloudConfig, NextcloudConfigError, normalize_path
from app.main import app


class FakeDrive:
    def __init__(self):
        self.items = [{
            "name": "notes.txt", "path": "/notes.txt", "fileType": "file", "mimeType": "text/plain",
            "sizeBytes": 5, "modified": "2026-01-01T00:00:00Z", "etag": "abc", "fileId": "42",
            "owner": "service", "starred": False, "shared": False, "trashed": False,
        }]
        self.calls: list[tuple[str, object]] = []

    def list_directory(self, path):
        self.calls.append(("list_directory", path))
        return self.items

    def list_recursive(self, path="/", favorites_only=False):
        self.calls.append(("list_recursive", (path, favorites_only)))
        return [item for item in self.items if not favorites_only or item["starred"]]

    def create_folder(self, path, name):
        self.calls.append(("create_folder", (path, name)))
        return {"ok": True, "path": f"{path.rstrip('/')}/{name}"}

    def move(self, path, name=None, destination=None):
        self.calls.append(("move", (path, name, destination)))
        return destination or f"/{name}"

    def delete(self, path):
        self.calls.append(("delete", path))

    def upload(self, path, filename, fileobj, size, content_type):
        self.calls.append(("upload", (path, filename, fileobj.read(), size, content_type)))
        return {"ok": True, "path": f"{path.rstrip('/')}/{filename}", "name": filename, "sizeBytes": size}

    def download(self, path):
        self.calls.append(("download", path))
        return DownloadStream(iter([b"hello"]), "text/plain", "5", "notes.txt")

    def storage(self):
        return {"usedBytes": 5, "freeBytes": 95, "totalBytes": 100, "percentageUsed": 5.0, "unlimited": False}

    def set_favorite(self, file_id, favorite):
        self.calls.append(("favorite", (file_id, favorite)))
        return {"ok": True, "fileId": file_id, "favorite": favorite}

    def shares(self):
        return [{"id": 7, "path": "/notes.txt", "share_type": 0, "share_with": "parth", "permissions": 1}]

    def create_share(self, *args):
        self.calls.append(("share", args))
        return {"id": 8, "path": args[0], "share_type": 0, "permissions": args[3]}

    def delete_share(self, share_id):
        self.calls.append(("delete_share", share_id))

    def trash(self):
        return [{**self.items[0], "path": "/notes.txt.d123", "originalPath": "/notes.txt"}]

    def restore(self, path):
        self.calls.append(("restore", path))

    def delete_trash(self, path):
        self.calls.append(("delete_trash", path))


class DriveApiTests(unittest.TestCase):
    def setUp(self):
        state = Path(self.enterContext(TemporaryDirectory()))
        users = state / "users.json"
        password = "isolated-drive-test-password"
        users.write_text(json.dumps([{"username": "drive-test", "displayName": "Drive Test", "role": "owner",
                                      "passwordHash": auth.hash_password(password)}]))
        self.enterContext(patch.dict("os.environ", {"KDG_STATE_DIR": str(state), "KDG_AUTH_USERS_FILE": str(users),
                                                   "KDG_API_KEYS_FILE": str(state / "keys.json"),
                                                   "KDG_AUDIT_FILE": str(state / "audit.jsonl")}))
        self.enterContext(patch.object(auth, "_sessions", {}))
        self.client = TestClient(app, base_url="https://testserver")
        self.addCleanup(self.client.close)
        self.assertEqual(self.client.post("/api/v1/auth/login", json={"username": "drive-test", "password": password}).status_code, 200)
        self.fake = FakeDrive()
        self.patch_client = patch("app.drive.router.client", return_value=self.fake)
        self.patch_client.start()
        self.addCleanup(self.patch_client.stop)

    def test_anonymous_drive_reads_and_writes_are_denied(self):
        self.client.cookies.clear()
        self.assertEqual(self.client.get("/api/v1/drive/files").status_code, 401)
        self.assertEqual(self.client.post("/api/v1/drive/folders", json={"path": "/", "name": "Docs"}).status_code, 401)
        self.assertEqual(self.fake.calls, [])

    def test_listing_and_folder_creation(self):
        response = self.client.get("/api/v1/drive/files?path=/&sort=name&order=asc")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["items"][0]["name"], "notes.txt")
        response = self.client.post("/api/v1/drive/folders", json={"path": "/", "name": "Docs"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["path"], "/Docs")

    def test_upload_download_rename_move_delete(self):
        response = self.client.post("/api/v1/drive/upload", data={"path": "/"}, files={"file": ("new.txt", b"hello", "text/plain")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["sizeBytes"], 5)
        response = self.client.get("/api/v1/drive/download?path=/notes.txt")
        self.assertEqual((response.status_code, response.content), (200, b"hello"))
        self.assertEqual(self.client.patch("/api/v1/drive/items", json={"path": "/notes.txt", "name": "renamed.txt"}).status_code, 200)
        self.assertEqual(self.client.patch("/api/v1/drive/items", json={"path": "/renamed.txt", "destination": "/Docs/renamed.txt"}).status_code, 200)
        self.assertEqual(self.client.request("DELETE", "/api/v1/drive/items", json={"path": "/Docs/renamed.txt"}).status_code, 200)

    def test_storage_favorites_shares_and_trash(self):
        self.assertEqual(self.client.get("/api/v1/drive/storage").json()["usedBytes"], 5)
        self.assertEqual(self.client.post("/api/v1/drive/favorites", json={"path": "/notes.txt", "favorite": True}).status_code, 200)
        self.assertEqual(self.client.delete("/api/v1/drive/favorites/42").status_code, 200)
        self.assertEqual(self.client.get("/api/v1/drive/shares").json()[0]["id"], 7)
        self.assertEqual(self.client.post("/api/v1/drive/shares", json={"path": "/notes.txt", "shareType": "user", "shareWith": "parth", "permissions": 1}).status_code, 200)
        self.assertEqual(self.client.delete("/api/v1/drive/shares/7").status_code, 200)
        self.assertTrue(self.client.get("/api/v1/drive/trash").json()[0]["trashed"])
        self.assertEqual(self.client.post("/api/v1/drive/trash/restore", json={"path": "/notes.txt.d123"}).status_code, 200)
        self.assertEqual(self.client.request("DELETE", "/api/v1/drive/trash", json={"path": "/notes.txt.d123"}).status_code, 200)

    def test_invalid_paths_and_connection_failure_are_explicit(self):
        response = self.client.get("/api/v1/drive/files?path=/../secrets")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_path")
        with patch("app.drive.router.client", side_effect=DriveError(502, "nextcloud_unavailable", "Nextcloud could not be reached.")):
            response = self.client.get("/api/v1/drive/storage")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["error"]["code"], "nextcloud_unavailable")

    def test_nextcloud_listing_parses_webdav_response(self):
        config = NextcloudConfig("http://nextcloud", None, "service", "secret")
        nc = NextcloudClient(config)
        xml = b'''<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
        <d:response><d:href>/remote.php/dav/files/service/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
        <d:response><d:href>/remote.php/dav/files/service/notes.txt</d:href><d:propstat><d:prop><d:getcontentlength>5</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype><oc:fileid>42</oc:fileid></d:prop></d:propstat></d:response>
        </d:multistatus>'''
        with patch.object(nc, "_request", return_value=httpx.Response(207, content=xml)):
            items = nc.list_directory("/")
        self.assertEqual(items[0]["fileId"], "42")


class DriveValidationTests(unittest.TestCase):
    def test_path_traversal_is_rejected(self):
        for value in ("/../etc/passwd", "/%2e%2e/etc", "/%252e%252e/etc", "../outside"):
            with self.assertRaises(DriveError):
                normalize_path(value)

    def test_missing_configuration_does_not_fallback(self):
        with patch.dict("os.environ", {"NEXTCLOUD_INTERNAL_URL": "", "NEXTCLOUD_USERNAME": "", "NEXTCLOUD_APP_PASSWORD": ""}, clear=False):
            with self.assertRaises(NextcloudConfigError):
                NextcloudConfig.from_env()


if __name__ == "__main__":
    unittest.main()
