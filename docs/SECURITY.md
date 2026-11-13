# Security and operational boundaries

KDG Cloud can administer a Linux host. Review deployments as privileged applications, even if only trusted members use the dashboard. These notes describe boundaries and known limitations, not a completed security audit.

## Credentials and publication

- Never commit real `.env`, account/password-hash files, sessions, API keys, rclone authorization, RCON secrets, private keys or OAuth state.
- `VITE_*` values become public frontend configuration. Nextcloud/host credentials belong only in protected backend environment/state.
- Generated data is excluded: worlds, notebooks, workspace repositories, uploads, Drive files, logs, backup archives and dependency/build caches.
- Git ignore rules are a convenience, not a security control for already tracked files. Review the staged tree and run a redacting secret scanner before every publication.
- If a credential is exposed, revoke/rotate it first. Deleting a file in a later commit does not remove it from history or invalidate the credential.

## Authentication and scope

- Keep authentication on operational `/api/v1` routes; designated health/login/session bootstrap routes remain exceptions. Use HTTPS and secure HttpOnly cookies in production.
- Existing legacy API-key policies and session lifecycle behavior have not been globally redesigned or fully audited here. Do not assume every ordinary key is a safe read-only credential.
- The dedicated MCP adapter requires exclusive `mcp:read` scope, a valid enabled key and a current owner/admin creator; it rejects mutation/arbitrary routes and WebSockets even when a browser cookie accompanies a recognized MCP key.
- The adapter is administrative/shared service-account access, not a per-user Nextcloud tenant gateway. Read-only filenames/logs can still be private; redaction is best-effort.
- Logs, filenames and model-provided text are untrusted input, not instructions to run commands.

## Host and infrastructure

- Keep the Docker socket/proxy off public networks. Inventory proxy stays GET-only; do not enable writes to make management operations work.
- Host-side terminal, process/container controls, Minecraft operations and filesystem storage need a carefully reviewed permission boundary. Do not blindly run every service as unrestricted root or widen sudo policies.
- Restrict origins, internal API bindings and host paths. Keep production proxy routing separate from the loopback Vite development proxy.
- Upload and archive handling, user/workspace isolation, backup restoration and third-party URL fetching deserve deployment-specific security testing before exposing them to less-trusted users.
- Back up existing data before changing deployment paths; do not recreate/delete volumes or restore worlds merely because the source repository exists.

## Reporting

Report suspected vulnerabilities privately to the Kasukabe Defence Group repository maintainers using an available private channel. Do not include passwords, tokens, private logs or user files in public issues. No monitored security email or guaranteed response SLA has been configured here.
