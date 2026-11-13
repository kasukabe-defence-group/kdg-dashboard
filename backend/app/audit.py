from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_lock = threading.Lock()


def _audit_file() -> Path:
    return Path(os.getenv("KDG_AUDIT_FILE", "/home/tabahi/kdg-dev/kdg-api/kdg-audit.jsonl"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def record(event: str, *, actor: str = "system", resource: str = "", action: str = "", result: str = "success", ip: str = "", device: str = "", detail: dict[str, Any] | None = None) -> None:
    entry = {
        "id": f"evt_{int(time.time()*1000)}_{os.getpid()}",
        "at": _now_iso(),
        "actor": actor,
        "event": event,
        "resource": resource,
        "action": action,
        "result": result,
        "ip": ip,
        "device": device,
        "detail": detail or {},
    }
    path = _audit_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
    except Exception:
        pass


def read_events(limit: int = 100) -> list[dict[str, Any]]:
    path = _audit_file()
    if not path.exists():
        return []
    try:
        with _lock:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        items = []
        for line in reversed(lines[-max(limit * 3, limit):]):
            try:
                items.append(json.loads(line))
            except Exception:
                continue
            if len(items) >= limit:
                break
        return items
    except Exception:
        return []


class RateLimiter:
    def __init__(self):
        self.events: dict[str, deque[float]] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, key: str, limit: int, window_seconds: int) -> tuple[bool, int]:
        now = time.time()
        with self.lock:
            q = self.events[key]
            cutoff = now - window_seconds
            while q and q[0] < cutoff:
                q.popleft()
            if len(q) >= limit:
                retry = max(1, int(window_seconds - (now - q[0])))
                return False, retry
            q.append(now)
            return True, 0


rate_limiter = RateLimiter()

# login failure tracking: (ip|user) -> deque timestamps
_login_failures: dict[str, deque[float]] = defaultdict(deque)
_login_lock = threading.Lock()


def login_blocked(key: str, max_failures: int = 10, window: int = 600, block_for: int = 300) -> tuple[bool, int]:
    now = time.time()
    with _login_lock:
        q = _login_failures[key]
        cutoff = now - window
        while q and q[0] < cutoff:
            q.popleft()
        # block if too many recent failures (simple: if count >= max, block based on last)
        if len(q) >= max_failures:
            retry = max(1, int(block_for - (now - q[-1]))) if q else block_for
            if retry > 0:
                return True, retry
        return False, 0


def record_login_failure(key: str) -> int:
    now = time.time()
    with _login_lock:
        q = _login_failures[key]
        cutoff = now - 600
        while q and q[0] < cutoff:
            q.popleft()
        q.append(now)
        return len(q)


def clear_login_failures(key: str) -> None:
    with _login_lock:
        _login_failures.pop(key, None)


# basic API key anomaly tracking
_key_windows: dict[str, deque[float]] = defaultdict(deque)
_key_anom_lock = threading.Lock()


def check_key_anomaly(key_id: str, limit_per_minute: int = 300) -> bool:
    now = time.time()
    with _key_anom_lock:
        q = _key_windows[key_id]
        cutoff = now - 60
        while q and q[0] < cutoff:
            q.popleft()
        q.append(now)
        return len(q) > limit_per_minute
