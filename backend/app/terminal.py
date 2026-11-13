from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
import termios
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth import current_user
from app.apikeys import authenticate_bearer

router = APIRouter()


def _has_terminal_access(websocket: WebSocket) -> bool:
    # session auth
    token = websocket.cookies.get("kdg_session")
    if token:
        # access internal sessions via auth module
        from app.auth import _sessions
        import time
        sess = _sessions.get(token)
        if sess and sess[0] > time.time():
            user = sess[1]
            return user.role in {"owner", "admin"}
    # bearer token
    authz = websocket.headers.get("authorization", "")
    if authz.lower().startswith("bearer "):
        key = authenticate_bearer(authz.split(" ", 1)[1].strip())
        if key and (set(key.get("scopes") or []) & {"admin", "control"}):
            return True
    return False


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", max(2, rows), max(2, cols), 0, 0))
    except Exception:
        pass


@router.websocket("/api/v1/terminal/ws")
async def terminal_ws(websocket: WebSocket):
    await websocket.accept()
    try:
        if not _has_terminal_access(websocket):
            await websocket.send_text(json.dumps({"type": "error", "message": "Not authorized"}))
            await websocket.close(code=4401)
            return

        target = (websocket.query_params.get("target") or "host").strip()
        cols = int(websocket.query_params.get("cols") or 120)
        rows = int(websocket.query_params.get("rows") or 30)

        if target == "host":
            cmd = [os.environ.get("SHELL") or "/bin/bash", "-l"]
        else:
            # container exec: validate simple name/id
            import re
            if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$", target):
                await websocket.send_text(json.dumps({"type": "error", "message": "Invalid container target"}))
                await websocket.close(code=4400)
                return
            # try bash then sh
            cmd = ["docker", "exec", "-it", target, "/bin/bash", "-l"]

        master_fd, slave_fd = pty.openpty()
        _set_winsize(slave_fd, rows, cols)

        def preexec():
            try:
                os.setsid()
            except Exception:
                pass
            try:
                fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            except Exception:
                pass

        import subprocess
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                preexec_fn=preexec,
                env={**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor"},
                close_fds=True,
            )
        except Exception:
            # fallback for containers without bash
            if target != "host":
                try:
                    proc = subprocess.Popen(
                        ["docker", "exec", "-it", target, "/bin/sh"],
                        stdin=slave_fd,
                        stdout=slave_fd,
                        stderr=slave_fd,
                        preexec_fn=preexec,
                        env={**os.environ, "TERM": "xterm-256color"},
                        close_fds=True,
                    )
                except Exception as e:
                    os.close(master_fd); os.close(slave_fd)
                    await websocket.send_text(json.dumps({"type": "error", "message": f"Failed to start session: {e}"}))
                    await websocket.close(code=1011)
                    return
            else:
                os.close(master_fd); os.close(slave_fd)
                await websocket.send_text(json.dumps({"type": "error", "message": "Failed to start host shell"}))
                await websocket.close(code=1011)
                return
        os.close(slave_fd)

        # Attribute the shell subtree to the logged-in dashboard user so the
        # Users / Processes pages can show who owns what.
        try:
            from app.userusage import attribute_pid
            attribute_pid(proc.pid, user.username, label=f"terminal:{target}", source="terminal")
        except Exception:
            pass

        loop = asyncio.get_running_loop()
        stop = asyncio.Event()

        async def pty_to_ws():
            try:
                while not stop.is_set():
                    try:
                        data = await loop.run_in_executor(None, lambda: os.read(master_fd, 4096))
                    except BlockingIOError:
                        await asyncio.sleep(0.01)
                        continue
                    except OSError:
                        break
                    if not data:
                        break
                    await websocket.send_text(json.dumps({"type": "output", "data": data.decode("utf-8", errors="replace")}))
            except Exception:
                pass
            finally:
                stop.set()

        async def ws_to_pty():
            try:
                while not stop.is_set():
                    msg = await websocket.receive_text()
                    try:
                        payload = json.loads(msg)
                    except Exception:
                        payload = {"type": "input", "data": msg}
                    t = payload.get("type")
                    if t == "input":
                        data = payload.get("data", "")
                        if data:
                            os.write(master_fd, data.encode("utf-8", errors="ignore"))
                    elif t == "resize":
                        _set_winsize(master_fd, int(payload.get("rows") or 30), int(payload.get("cols") or 120))
                        try:
                            os.kill(proc.pid, signal.SIGWINCH)
                        except Exception:
                            pass
            except WebSocketDisconnect:
                pass
            except Exception:
                pass
            finally:
                stop.set()

        tasks = [asyncio.create_task(pty_to_ws()), asyncio.create_task(ws_to_pty())]
        await websocket.send_text(json.dumps({"type": "ready", "target": target}))
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            from app.userusage import release_pid
            release_pid(proc.pid)
        except Exception:
            pass
        try:
            os.close(master_fd)
        except Exception:
            pass
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
