from __future__ import annotations

import getpass
import json
import sys
from pathlib import Path

from app.auth import hash_password


USERS = [
    ("tabahi", "tabahi", "owner"),
    ("Yuuta", "Yuuta", "admin"),
    ("Parth", "Parth", "admin"),
    ("Light", "Light", "moderator"),
    ("Razor", "Razor", "moderator"),
]


def main() -> int:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "/etc/kdg-auth-users.json")
    print(f"Creating dashboard user hashes in {output}")
    entries = []
    for username, display_name, role in USERS:
        first = getpass.getpass(f"Password for {username} ({role}): ")
        second = getpass.getpass("Repeat password: ")
        if not first or first != second:
            print("Passwords did not match or were empty.", file=sys.stderr)
            return 1
        entries.append({"username": username, "displayName": display_name, "role": role, "passwordHash": hash_password(first)})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
    output.chmod(0o600)
    print("Dashboard users provisioned. Plaintext passwords were not written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
