"""Same-origin reverse proxy for the embedded per-user JupyterLab.

The dashboard iframe loads ``/api/v1/workspaces/jupyter/<slug>/...`` and FastAPI
proxies it to the workspace container, which runs with ``--ServerApp.base_url``
set to the same prefix. Jupyter's generated URLs resolve to the proxy, so:

* the browser only ever talks to the dashboard's own origin,
* the Jupyter token stays server-side (the proxy injects it),
* LAN, Tailscale and public Funnel all work without opening extra ports.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast
from urllib.parse import parse_qsl, urlencode

import httpx
import websockets
from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import StreamingResponse

from app.auth import current_user
from app.workspaces import _canonical, _container_name, _docker_status, _load_state, lab_base

router = APIRouter(prefix="/workspaces/jupyter", tags=["jupyter"])

_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
    "trailer", "trailers", "transfer-encoding", "upgrade", "content-length",
    "host", "origin", "referer",
}
_TIMEOUT = httpx.Timeout(600.0, connect=5.0)


def _entry_for(actor: Any, username: str) -> dict[str, Any]:
    entry = _canonical(username)
    is_self = str(actor.username).casefold() == str(entry["username"]).casefold()
    if not is_self and actor.role not in {"owner", "admin"}:
        raise HTTPException(status_code=403, detail="You can only open your own workspace")
    return entry


def _upstream(entry: dict[str, Any]) -> tuple[int, str, str]:
    state = _load_state(entry)
    token = str(state.get("token") or "")
    port = int(state.get("port") or 0)
    status = _docker_status(_container_name(entry))
    if not status.get("running"):
        raise HTTPException(status_code=503, detail={
            "code": "workspace_stopped",
            "message": "Workspace is not running. Start it first.",
        })
    if not port or not token:
        raise HTTPException(status_code=503, detail={
            "code": "workspace_not_ready",
            "message": "Workspace is not ready yet. Restart it once.",
        })
    return port, token, lab_base(entry)


def _rewrite_location(location: str, port: int) -> str:
    prefix = f"http://127.0.0.1:{port}"
    if location.startswith(prefix):
        return location[len(prefix):] or "/"
    return location


@router.api_route("/{username}/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
async def jupyter_http(username: str, path: str, request: Request):
    actor = current_user(request)
    if not actor:
        raise HTTPException(status_code=401, detail="Authentication required")
    entry = _entry_for(actor, username)
    port, token, base = _upstream(entry)

    url = f"http://127.0.0.1:{port}{base}{path}"
    if request.url.query:
        url += "?" + request.url.query

    headers = {}
    for key, value in request.headers.items():
        if key.lower() in _HOP:
            continue
        headers[key.lower()] = value
    headers["host"] = f"127.0.0.1:{port}"
    headers["authorization"] = f"token {token}"
    headers["accept-encoding"] = "identity"

    client = httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False)
    try:
        content = request.stream() if request.method not in {"GET", "HEAD", "OPTIONS"} else None
        upstream_request = client.build_request(request.method, url, headers=headers, content=content)
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"JupyterLab is not reachable: {exc}") from exc

    out_headers: dict[str, str] = {}
    cookies: list[str] = []
    for key, value in upstream.headers.multi_items():
        lower = key.lower()
        if lower in _HOP or lower == "content-length":
            continue
        if lower == "set-cookie":
            cookies.append(value)
            continue
        if lower == "location":
            value = _rewrite_location(value, port)
        out_headers[lower] = value

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    response = StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        headers=out_headers,
    )
    for cookie in cookies:
        response.headers.append("set-cookie", cookie)
    return response


@router.websocket("/{username}/{path:path}")
async def jupyter_ws(websocket: WebSocket, username: str, path: str):
    actor = current_user(cast(Any, websocket))
    if not actor:
        await websocket.close(code=4401)
        return
    try:
        entry = _entry_for(actor, username)
        port, token, base = _upstream(entry)
    except HTTPException:
        await websocket.close(code=4403)
        return

    params = [(key, value) for key, value in parse_qsl(websocket.url.query, keep_blank_values=True)
              if key.lower() != "token"]
    params.append(("token", token))
    upstream_url = f"ws://127.0.0.1:{port}{base}{path}?{urlencode(params)}"

    try:
        subprotocols = list(websocket.scope.get("subprotocols") or [])
        conn = await websockets.connect(
            upstream_url,
            subprotocols=subprotocols or None,
            max_size=64 * 1024 * 1024,
            open_timeout=10,
            ping_interval=25,
        )
    except Exception:
        await websocket.close(code=1011)
        return

    await websocket.accept(subprotocol=conn.subprotocol)

    async def client_to_upstream() -> None:
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                text = message.get("text")
                data = message.get("bytes")
                if text is not None:
                    await conn.send(text)
                elif data is not None:
                    await conn.send(data)
        except Exception:
            return

    async def upstream_to_client() -> None:
        try:
            async for message in conn:
                if isinstance(message, bytes):
                    await websocket.send_bytes(message)
                else:
                    await websocket.send_text(message)
        except Exception:
            return

    try:
        tasks = {
            asyncio.create_task(client_to_upstream()),
            asyncio.create_task(upstream_to_client()),
        }
        _done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    finally:
        try:
            await conn.close()
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
