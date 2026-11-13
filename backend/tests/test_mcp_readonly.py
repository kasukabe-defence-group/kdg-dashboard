import hashlib
import json
import subprocess
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import apikeys, auth, main, mcp_readonly, minecraft, workspaces

TOKEN = "kdg_" + "x" * 43


@pytest.fixture
def api(tmp_path, monkeypatch):
    keys = tmp_path / "keys.json"
    users = tmp_path / "users.json"
    audit = tmp_path / "audit.jsonl"
    key = {"id": "mcp-test", "tokenHash": hashlib.sha256(TOKEN.encode()).hexdigest(), "scopes": ["mcp:read"],
           "createdBy": "owner", "enabled": True, "expiresAt": None}
    keys.write_text(json.dumps([key]))
    users.write_text(json.dumps([{"username": "owner", "displayName": "Owner", "role": "owner", "passwordHash": "dummy"}]))
    monkeypatch.setenv("KDG_API_KEYS_FILE", str(keys))
    monkeypatch.setenv("KDG_AUTH_USERS_FILE", str(users))
    monkeypatch.setenv("KDG_AUDIT_FILE", str(audit))
    monkeypatch.setattr(main, "current_user", lambda request: None)
    monkeypatch.setattr(mcp_readonly.rate_limiter, "allow", lambda *args, **kwargs: (True, 0))
    monkeypatch.setattr(main, "check_key_anomaly", lambda *args, **kwargs: False)
    client = TestClient(main.app)
    client.headers["Authorization"] = f"Bearer {TOKEN}"
    return client, key, keys, users, audit


def test_health_and_audit_without_secrets(api):
    client, _, _, _, audit = api
    assert client.get("/api/v1/mcp-readonly/health").status_code == 200
    text = audit.read_text()
    assert "mcp.api.read" in text and "success" in text
    assert TOKEN not in text and "password" not in text


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/v1/minecraft/servers"), ("DELETE", "/api/v1/drive/items"),
    ("PATCH", "/api/v1/minecraft/servers/valid-id"), ("GET", "/api/v1/containers"),
    ("GET", "/api/v1/drive/download"), ("GET", "/api/v1/workspaces/jupyter/owner/"),
    ("GET", "/api/v1/auth/users"), ("POST", "/api/v1/auth/logout"),
    ("GET", "/api/v1/health"), ("GET", "/docs"), ("HEAD", "/api/v1/mcp-readonly/health"),
    ("OPTIONS", "/api/v1/drive/files"), ("POST", "/api/v1/mcp-readonly/health"),
    ("GET", "/api/v1/mcp-readonly/minecraft/servers/bad_id/logs"),
])
def test_exclusive_key_cannot_escape_even_with_cookie(api, monkeypatch, method, path):
    client, _, _, _, audit = api
    monkeypatch.setattr(main, "current_user", lambda request: auth.AuthUser(username="owner", displayName="Owner", role="owner"))
    client.cookies.set("kdg_session", "a-browser-cookie")
    assert client.request(method, path).status_code == 403
    assert '"result": "denied"' in audit.read_text()


@pytest.mark.parametrize("changes,expected", [
    ({"enabled": False}, 403), ({"expiresAt": "2020-01-01"}, 403),
    ({"expiresAt": ""}, 403), ({"expiresAt": 0}, 403),
    ({"expiresAt": "not-an-expiry"}, 403), ({"expiresAt": "2040-01-01T00:00:00"}, 403),
    ({"scopes": ["mcp:read", "write"]}, 403), ({"scopes": ["read"]}, 403),
    ({"createdBy": "missing"}, 403), ({"tokenHash": "wrong"}, 401),
])
def test_invalid_key_is_rejected(api, changes, expected):
    client, key, keys, _, _ = api
    keys.write_text(json.dumps([{**key, **changes}]))
    assert client.get("/api/v1/mcp-readonly/health").status_code == expected


def test_missing_key_cookie_only_and_demoted_creator(api, monkeypatch):
    client, _, _, users, _ = api
    users.write_text(json.dumps([{"username": "owner", "displayName": "Owner", "role": "moderator", "passwordHash": "dummy"}]))
    assert client.get("/api/v1/mcp-readonly/health").status_code == 403
    client.headers.pop("Authorization")
    assert client.get("/api/v1/mcp-readonly/health").status_code == 401
    monkeypatch.setattr(main, "current_user", lambda request: auth.AuthUser(username="owner", displayName="Owner", role="owner"))
    assert client.get("/api/v1/mcp-readonly/health").status_code == 403


def test_rate_limit(api, monkeypatch):
    client, _, _, _, _ = api
    monkeypatch.setattr(mcp_readonly.rate_limiter, "allow", lambda *args, **kwargs: (False, 30))
    result = client.get("/api/v1/mcp-readonly/health")
    assert result.status_code == 429 and result.headers["Retry-After"] == "30"


@pytest.mark.parametrize("changes", [{"enabled": False}, {"expiresAt": "2020-01-01"}, {"scopes": ["mcp:read", "control"]}])
def test_invalid_mcp_key_cannot_fall_back_to_cookie_or_websocket(api, monkeypatch, changes):
    client, key, keys, _, _ = api
    keys.write_text(json.dumps([{**key, **changes}]))
    monkeypatch.setattr(main, "current_user", lambda request: auth.AuthUser(username="owner", displayName="Owner", role="owner"))
    client.cookies.set("kdg_session", "browser-cookie")
    assert client.post("/api/v1/auth/logout").status_code == 403
    for path in ("/api/v1/terminal/ws", "/api/v1/workspaces/jupyter/owner/api/kernels/123/channels"):
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect(path):
                pytest.fail("MCP credentials must not open a WebSocket")
        assert error.value.code == 4403


def test_existing_browser_and_non_mcp_key_remain_usable(api, monkeypatch):
    client, key, keys, _, _ = api
    monkeypatch.setattr(main, "get_containers", lambda strict=False: [])
    keys.write_text(json.dumps([{**key, "scopes": ["read"]}]))
    assert client.get("/api/v1/containers").status_code == 200
    client.headers.pop("Authorization")
    monkeypatch.setattr(main, "current_user", lambda request: auth.AuthUser(username="owner", displayName="Owner", role="owner"))
    assert client.get("/api/v1/containers").status_code == 200
    assert client.get("/api/v1/health").status_code == 200


def test_minecraft_and_logs_are_read_only_and_redacted(api, tmp_path, monkeypatch):
    client, _, _, _, _ = api
    registry = tmp_path / "servers.json"
    registry.write_text(json.dumps([{"id": "safe-id", "name": "Survival", "rconPassword": "private-rcon-value"}]))
    monkeypatch.setattr(minecraft, "SERVERS_FILE", registry)
    monkeypatch.setattr(minecraft, "_docker_status", lambda sid: {"running": False, "token": "private"})
    ensure = Mock(side_effect=AssertionError("must never initialize world state"))
    monkeypatch.setattr(minecraft, "_ensure", ensure)
    result = client.get("/api/v1/mcp-readonly/minecraft/servers")
    assert result.status_code == 200 and "rcon" not in result.text and "token" not in result.text
    def run(command, timeout):
        assert command == ["docker", "logs", "--tail", "100", "mc-safe-id"]
        return subprocess.CompletedProcess(command, 0, f"private-rcon-value {TOKEN} token=private-value", "")
    monkeypatch.setattr(minecraft, "_run", run)
    logs = client.get("/api/v1/mcp-readonly/minecraft/servers/safe-id/logs")
    assert logs.status_code == 200
    assert "private-rcon-value" not in logs.text and TOKEN not in logs.text and "private-value" not in logs.text
    assert client.get("/api/v1/mcp-readonly/minecraft/servers/safe-id/logs?tail=501").status_code == 422
    ensure.assert_not_called()


def test_workspace_summaries_do_not_initialize_or_leak(api, tmp_path, monkeypatch):
    client, _, _, _, _ = api
    root = tmp_path / "workspaces"
    settings = root / "owner" / ".kdg"
    settings.mkdir(parents=True)
    (settings / "workspace.json").write_text(json.dumps({"token": "jupyter-private", "cpus": 2, "memoryMiB": 1024}))
    monkeypatch.setattr(workspaces, "ROOT", root.resolve())
    monkeypatch.setattr(workspaces, "_ensure", Mock(side_effect=AssertionError("must not initialize")))
    monkeypatch.setattr(workspaces, "_docker_status", lambda name: {"state": "stopped", "running": False})
    result = client.get("/api/v1/mcp-readonly/workspaces")
    assert result.status_code == 200 and result.json()[0]["username"] == "owner"
    assert "jupyter-private" not in result.text and "token" not in result.text
    workspaces._ensure.assert_not_called()


def test_drive_metadata_only_and_paths(api, monkeypatch):
    from app.drive.router import FileListResponse
    client, _, _, _, _ = api
    def files(**kwargs):
        assert kwargs["search"] is None and kwargs["limit"] <= 100
        return FileListResponse(items=[], path=kwargs["path"], page=kwargs["page"], limit=kwargs["limit"], total=0)
    monkeypatch.setattr("app.drive.router.files", files)
    result = client.get("/api/v1/mcp-readonly/drive/files")
    assert result.status_code == 200 and result.json()["access"] == "administrative-service-account-root"
    assert client.get("/api/v1/mcp-readonly/drive/files?limit=101").status_code == 422
    for path in ("/../etc", "/%252e%252e/secret", "/a\\b", "/\x00"):
        assert client.get("/api/v1/mcp-readonly/drive/files", params={"path": path}).status_code == 400


def test_resources_and_containers_exclude_private_fields(api, monkeypatch):
    from app import docker_readonly
    client, _, _, _, _ = api
    monkeypatch.setattr(main, "overview", lambda: {"cpuPercent": 2, "hostname": "private-host",
                                                "processes": [{"cmdline": "private-command"}],
                                                "gpu": {"utilPercent": 1, "token": "private-token"}})
    resources = client.get("/api/v1/mcp-readonly/resources")
    assert resources.status_code == 200
    assert resources.json() == {"cpuPercent": 2, "gpu": {"utilPercent": 1}}
    monkeypatch.setattr(docker_readonly, "get_containers", lambda strict: [{"name": "container", "state": "running",
                                                                         "environment": {"PASSWORD": "private"}, "mounts": ["/private"]}])
    containers = client.get("/api/v1/mcp-readonly/containers")
    assert containers.status_code == 200 and containers.json() == [{"name": "container", "state": "running"}]


def test_absent_registry_does_not_create_state(api, tmp_path, monkeypatch):
    client, _, _, _, _ = api
    missing = tmp_path / "not-created" / "servers.json"
    monkeypatch.setattr(minecraft, "SERVERS_FILE", missing)
    assert client.get("/api/v1/mcp-readonly/minecraft/servers").json() == []
    assert not missing.parent.exists()
