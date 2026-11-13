# Source provenance and verification

## Imported snapshot

Prepared November 13, 2026 from saved Windows development source while the Ubuntu server was offline. `frontend/` comes from the canonical editable dashboard copy; `backend/` comes from the saved API copy. This is not a fresh download from the server. Backend Minecraft/world changes may lag production.

129 original source/config/asset files were initially imported using an explicit allowlist. Original local source was not modified. Excluded source backups/caches, private environment/state, runtime data and the orphaned duplicate `src/routes/client.ts`. All real API imports use `src/services/api/client.ts`; retaining the duplicate in the route folder could create an invalid file-based route.

Publication-only adjustments:
- Added missing imported `websockets` runtime dependency and isolated development/test configuration.
- Named the frontend package `kdg-dashboard` and added a loopback `/api/v1` development proxy with WebSocket forwarding.
- Regenerated the stale TanStack route tree through the normal Vite build, including the saved Minecraft, lab, workspace and usage routes. No manual route-tree edits.
- Added a dependency lockfile after installation, generic environment templates, repository ignores and documentation.

The standalone MCP gateway is not included. The backend read adapter and its local regression tests are included. The separate context repository remains a placeholder-only map.

## Checks for this publication

Observed on November 13, 2026:

| Check | Result |
|---|---|
| Backend pytest | **44 passed** on Linux/Python 3.12 in an existing isolated test image, source mounted read-only, network disabled, temporary state; 2 FastAPI lifespan deprecation warnings |
| Backend syntax | **23 application/script/test files compiled** on Linux/Python 3.12 without writing artifacts into source |
| Frontend dependencies | **519 packages installed** using Node 24.16.0/npm 11.13.0 with install scripts/audit/funding disabled; generated lockfile included |
| Frontend Vitest | **4 tests passed** across 2 files, rerun after route generation |
| Frontend build | **Passed**: Vite client, SSR and Nitro `node-server` build, rerun after final development-proxy correction |
| Frontend TypeScript | **Failed: 5 pre-existing errors** remaining after normal route generation; details below |
| Source provenance | **Passed**: 129 original files checked against the import SHA-256 manifest, 139 staged paths reviewed, documentation links/manifests/backend syntax validated; only documented publication-copy adjustments allowed |
| Publication secret scan | **Passed**: Gitleaks 8.30.1 staged scan, including lockfile and documentation, reported no findings (1.28 MB scanned); rerun after documentation edits and scan committed history before push |
| Staged whitespace | **Passed**: `git diff --cached --check` |

The five remaining TypeScript diagnostics are:

- `frontend/src/routes/kdg-drive.tsx:259`: two diagnostics for `new File(...)`, where the imported icon named `File` shadows the browser constructor.
- `frontend/src/routes/kdg-drive.tsx:264`: explicitly undefined `previewUrl` conflicts with the project's strict optional-property typing.
- `frontend/src/routes/kdg-drive.tsx:381`: explicitly undefined `outputName` conflicts with the API payload's optional-property typing.
- `frontend/src/routes/minecraft.tsx:171`: the saved API client's create payload type does not include the UI's `seed` field.

These application errors were not fixed as part of source publication. The successful Vite build transpiles code without enforcing the separate TypeScript check. Some errors can affect runtime workflows; do not equate the build/test results with fully working Drive or Minecraft creation.

Build warnings include oversized chunks and an obsolete tsconfig-paths plugin. Several installed dependency versions emit deprecation notices. No dependency migration or comprehensive dependency-vulnerability audit was performed. Build artifacts are ignored; build again on the target Linux OS/architecture rather than uploading the Windows output.

Verification recovery: an initial snapshot validator compared Windows path separators against a forward-slash allowlist; it was corrected without changing source. An initial syntax checker decoded a BOM-bearing source file as text; it was corrected to compile raw bytes, matching Python's normal encoding handling. Initial stale-route errors disappeared after normal generation; the publication-copy environment lookup was corrected to bracket notation to match existing TypeScript settings.

## Known live limitations

- The frontend API client invokes `/api/v1/drive/video/process`, but no matching handler or ffmpeg/video module exists in the saved backend. Publish the available source honestly; obtain/reconcile the live implementation when the server returns rather than inventing one during this upload.
- Ubuntu is offline: no live source reconciliation, service restart, current data inventory or production/browser/E2E verification.
- Dashboard session/hydration behavior and authentication need browser verification; a loading fallback exists but is not proof that the earlier problem is resolved.
- Process CPU/host CPU scales and ownership attribution require reconciliation and testing; no global normalization fix is claimed.
- Minecraft backup running-state/RCON-consistent saving, real Google Drive authorization/restore and a confirmed public playit TCP address remain unresolved.
- Local tests mock Docker/Nextcloud. They do not prove deployed containers, files, worlds, GPU processing or per-user workflows work.
- No full security audit, data backup, original deployment secrets or complete production infrastructure configuration is included.
