<img src="frontend/public/kdg-logo.png" alt="KDG emblem" width="96" />

# KDG Cloud Dashboard

A self-hosted server dashboard and FastAPI backend for the Kasukabe Defence Group: host monitoring, Nextcloud Drive, Minecraft management and per-user Jupyter workspaces in one interface.

**This repository contains real application source, not server-tree placeholders.** It was imported from saved Windows development copies on November 13, 2026 while the Ubuntu server was offline. The backend may lag newer server-side changes. This is not a full server/data backup or a fresh production verification. See [verification and provenance](docs/VERIFICATION.md).

## Features in the source

- **Monitoring:** host CPU, memory, storage, network, GPU, processes and resource ownership summaries.
- **Administration:** container inventory/actions, browser terminals, API-key management and audit views.
- **Drive:** Nextcloud-backed file listing, uploads/downloads, previews, shares, favorites and trash. Video-processing UI is present, but its API handler is missing from this saved backend snapshot.
- **Minecraft:** server management, console/logs, players, worlds, addons, settings and backup interfaces.
- **Workspaces:** per-user JupyterLab containers, Git repositories, optional Google Drive sync and persistent workspace storage.
- **Access:** owner/admin/moderator roles, authenticated sessions, hashed API keys and read-only MCP adapter routes.
- **Interface:** responsive dark/light dashboard with shared UI components and leave-page warnings for active work.

Features requiring Docker, Nextcloud, GPU tools, Google authorization or playit are not provided just by starting the web app. Backup consistency, public Minecraft setup and several browser workflows still need live verification.

## Repository layout

```text
frontend/                  React + TanStack Start/Router dashboard
  src/routes/              File-based pages
  src/services/api/        API client and query hooks
  src/components/          Dashboard and shared UI components
  src/test/                Frontend regression tests
backend/                   FastAPI application
  app/                     Auth, metrics, Docker, Drive, Minecraft, workspaces
  scripts/                 Interactive account provisioning
  tests/                   Drive and read-only adapter regression tests
docs/                      Security, provenance and verification notes
```

The separate [KDG server context repository](https://github.com/kasukabe-defence-group/kdg-folder-structure) is a descriptive map only. This repository does **not** include the standalone OAuth MCP gateway or publish a working remote MCP URL; it includes the API's read-only adapter.

## Technology

| Layer | Stack |
|---|---|
| Dashboard | React 19, TypeScript, TanStack Start/Router/Query, Vite 8, Tailwind CSS 4, Radix UI, xterm.js |
| Backend | Python, FastAPI, psutil, httpx, websockets |
| Integrations | Nextcloud WebDAV/OCS, Docker, JupyterLab, rclone, Minecraft, optional NVIDIA/ffmpeg/playit tools |
| Deployment | Linux host services behind an authenticated HTTPS reverse proxy, such as existing Traefik |

## Local development

Use **Linux or WSL2 for the backend**, with Python **3.12+**. Its terminal implementation imports POSIX modules unavailable in native Windows Python. Use a current **Node.js 24+** release for the frontend. Keep application environments separate from other projects.

### 1. Backend

Run from the repository root on Linux/WSL:

```sh
cd backend
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
cp .env.example .env
chmod 600 .env
set -a
. ./.env
set +a
```

Adjust the private `.env` for your host. The application reads process environment variables; it does not automatically load `.env`. Local defaults keep state under ignored `backend/.state/` rather than the original deployment's directories.

Review the account list in `scripts/provision_dashboard_users.py`, then create password hashes interactively:

```sh
.venv/bin/python -m scripts.provision_dashboard_users "$KDG_AUTH_USERS_FILE"
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The provisioning script prompts for passwords and writes hashes only. Do not commit its generated JSON or use a shared/default password. The supplied account names are the original deployment's account list; customize it deliberately for another installation.

The designated API health route is `http://127.0.0.1:8000/api/v1/health`. Operational API routes require authentication. Without configured integrations, related operations fail explicitly rather than creating a full infrastructure stack.

### 2. Dashboard

In another terminal, from the repository root:

```sh
cd frontend
npm ci
cp .env.example .env
export KDG_API_INTERNAL_URL=http://127.0.0.1:8000
npm run dev -- --host 127.0.0.1 --port 5173
```

Open **http://127.0.0.1:5173** and sign in with a provisioned account. The development proxy forwards `/api/v1` and WebSockets to the backend while preserving same-origin browser sessions. `KDG_API_INTERNAL_URL` also supplies the absolute backend URL needed by server-side rendering.

On Windows PowerShell, set the Node environment using `$env:KDG_API_INTERNAL_URL = "http://127.0.0.1:8000"`. The API still needs Linux/WSL2 or a properly configured Linux container.

`VITE_KDG_USE_MOCKS=true` enables selected UI fixtures only; it is **not** a complete offline app or an authentication bypass. Keep it false in production. `VITE_*` values are browser-visible, so never place credentials there.

### 3. Optional integrations

- **Nextcloud:** set the private server-side URL, service username and app password. API preview cache is not the actual Nextcloud file store. The service-account root is shared, not automatically separate Nextcloud accounts for each dashboard user.
- **Docker:** provide the existing local read-only socket proxy for inventory. Keep its GET-only restrictions; management operations use separately authorized host-side commands. Do not expose the Docker socket or proxy publicly.
- **Minecraft/Jupyter:** need existing Docker access, suitable images, host paths and persistent mounts. Source code is not a replacement for existing worlds or notebooks.
- **GPU:** requires compatible optional NVIDIA tools/drivers; support depends on host capabilities. Video processing additionally needs its missing backend handler restored/reconciled from the live server; installing ffmpeg alone does not supply that endpoint.
- **Drive backups/sync:** require explicit Google/rclone authorization. Never commit authorization files. Instant power loss cannot guarantee a final backup.
- **Public Minecraft:** needs an independently configured TCP tunnel, such as playit; the HTTPS dashboard/Funnel URL is not a Minecraft TCP address.

## Testing and production build

```sh
# From backend/, with its environment active
.venv/bin/python -m pytest -q
.venv/bin/python -m compileall -q app scripts

# From frontend/
npm test
npx tsc --noEmit
npm run build
```

The frontend build uses a persistent **Node-server Nitro preset**, with output in `.output/`. Build on the target deployment OS/architecture; do not deploy the generated Windows output to Linux. Run the built server under a process supervisor with your server-side API URL and explicit host/port environment. For example, from `frontend/`:

```sh
KDG_API_INTERNAL_URL=http://127.0.0.1:8000 NITRO_HOST=127.0.0.1 NITRO_PORT=8081 node .output/server/index.mjs
```

Build/type/test results and known failures are recorded in [docs/VERIFICATION.md](docs/VERIFICATION.md); a successful build is not proof of browser authentication or live integrations.

## Deployment and security

This is a privileged administration application, not an anonymous public dashboard. Before deployment:

1. Reconcile these saved files with current server source; do not overwrite newer server code wholesale.
2. Preserve existing Nextcloud/Docker volumes, Minecraft worlds and workspace mounts.
3. Run API and frontend as managed host services behind HTTPS; route `/api/v1` to FastAPI and enable WebSocket forwarding. The Vite development proxy is not production routing.
4. Set `KDG_AUTH_COOKIE_SECURE=true`, use real allowed origins and keep API/Node internal bindings private.
5. Keep credentials, state, caches, notebooks, uploads and backups outside Git. Protect account/API-key/rclone configuration files with restrictive permissions.
6. Verify real login, authorization, integration reads/writes and browser behavior before treating the deployment as working.

See [security notes](docs/SECURITY.md) for boundaries and limitations. No full security audit or turnkey production Compose stack is claimed. No license has been selected in this repository; do not assume an open-source license merely because source is shared.
