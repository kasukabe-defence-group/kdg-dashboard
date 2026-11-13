/**
 * KDG API client.
 *
 * Browser requests use the dashboard's same origin. Traefik routes /api/v1
 * to FastAPI, so this works over both LAN and Tailscale.
 *
 * During SSR, Node fetch requires an absolute URL. In that case use the
 * host-internal FastAPI address (overridable with KDG_API_INTERNAL_URL).
 *
 * Set VITE_KDG_API_URL only when the API is hosted on a different browser origin.
 * Set VITE_KDG_USE_MOCKS=true only for local UI development.
 */
import * as mock from "@/services/mocks/data";
import type {
  ApiKeyInfo, AppService, AuditEvent, AuthUser, Bucket, DriveFileList, DriveItem, DriveShare, DriveStorage, GpuInfo, McBackupRestore, McBackupRun, McBackupStatus, McCatalog, McAddons, McAddonSearch, McPlayers, MinecraftServer, McWorlds, Overview, PlayitStatus, Process, Role, S3Object, User, UserUsage, Workspace, WorkspaceDrive, WorkspaceRepo,
} from "@/types";

const CONFIGURED_BASE =
  (import.meta.env["VITE_KDG_API_URL"] as string | undefined)?.replace(/\/$/, "") ?? "";

const SERVER_BASE =
  typeof window === "undefined"
    ? process.env["KDG_API_INTERNAL_URL"] || "http://172.19.0.1:8000"
    : "";

const BASE = CONFIGURED_BASE || SERVER_BASE;
export const USING_MOCKS = import.meta.env["VITE_KDG_USE_MOCKS"] === "true";

const delay = <T,>(v: T, ms = 250) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(structuredClone(v)), ms));

let redirecting = false;

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const requestInit: RequestInit = { ...init, credentials: "include" };
  if (init?.body && !init.headers && !(init.body instanceof FormData)) requestInit.headers = { "Content-Type": "application/json" };
  const res = await fetch(`${BASE}/api/v1${path}`, requestInit);

  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth/") && !redirecting) {
      redirecting = true;
      const next = window.location.pathname + window.location.search;
      window.location.assign(`/login?next=${encodeURIComponent(next)}`);
    }
    const body = await res.json().catch(() => null) as { error?: { message?: string }; detail?: string } | null;
    throw new Error(body?.error?.message ?? body?.detail ?? `${res.status} ${res.statusText} for /api/v1${path}`);
  }

  return res.json() as Promise<T>;
}

function uploadFile(path: string, file: File, onProgress?: (percent: number) => void, onXhr?: (xhr: XMLHttpRequest) => void): Promise<{ ok: boolean; path: string; name: string; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    onXhr?.(request);
    request.open("POST", `${BASE}/api/v1/drive/upload`);
    request.withCredentials = true;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onerror = () => reject(new Error("The upload connection failed."));
    request.onabort = () => reject(new Error("Upload cancelled."));
    request.onload = () => {
      const body = JSON.parse(request.responseText || "null") as { error?: { message?: string } } | null;
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(body?.error?.message ?? "The upload failed."));
        return;
      }
      resolve(body as { ok: boolean; path: string; name: string; sizeBytes: number });
    };
    const form = new FormData();
    form.append("path", path);
    form.append("file", file, file.name);
    request.send(form);
  });
}

export type ContainerInfo = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  restartPolicy?: string;
};

export const api = {
  authSession: (): Promise<AuthUser> => http("/auth/session"),
  login: (username: string, password: string): Promise<AuthUser> =>
    http("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: (): Promise<{ ok: boolean }> => http("/auth/logout", { method: "POST" }),
  nextcloudSso: (): Promise<{ ok: boolean; redirectPath: string }> => http("/drive/nextcloud/sso", { method: "POST" }),
  overview: (): Promise<Overview> =>
    USING_MOCKS ? delay(mock.overview) : http("/overview"),

  containers: (): Promise<ContainerInfo[]> =>
    USING_MOCKS ? delay([]) : http("/containers"),
  containerAction: (container: string, action: "start" | "stop" | "restart"): Promise<{ ok: boolean; container: string; action: string; restartPolicy?: string }> =>
    http(`/containers/${encodeURIComponent(container)}/action`, { method: "POST", body: JSON.stringify({ action }) }),

  processes: (sort: "cpu" | "memory" = "memory"): Promise<Process[]> =>
    USING_MOCKS ? delay(mock.processes) : http(`/processes?sort=${sort}`),
  signalProcess: (pid: number, signal: "TERM" | "KILL" = "TERM"): Promise<{ ok: boolean; pid: number; signal: string }> =>
    http(`/processes/${pid}/signal`, { method: "POST", body: JSON.stringify({ signal }) }),

  gpu: (): Promise<GpuInfo> =>
    USING_MOCKS ? delay(mock.gpu) : http("/gpu"),

  services: (): Promise<AppService[]> =>
    USING_MOCKS ? delay(mock.appCatalogue) : http("/services"),

  service: (id: string): Promise<AppService | undefined> =>
    USING_MOCKS
      ? delay(mock.appCatalogue.find((service) => service.id === id))
      : http(`/services/${id}`),

  serviceAction: (
    id: string,
    action: "start" | "stop" | "restart",
  ): Promise<{ ok: boolean; simulated?: boolean }> =>
    USING_MOCKS
      ? delay({ ok: true, simulated: true }, 600)
      : http(`/services/${id}/${action}`, { method: "POST" }),

  audit: (limit = 100): Promise<AuditEvent[]> =>
    USING_MOCKS
      ? delay(mock.audit.slice(0, limit))
      : http(`/audit?limit=${limit}`),

  metricsHistory: (minutes = 360): Promise<{ samples: Array<{ t: number; cpu: number; mem: number; memUsedGiB: number; netUpMbps: number; netDownMbps: number }>; count: number }> =>
    http(`/metrics/history?minutes=${minutes}`),

  users: (): Promise<Array<{ username: string; displayName: string; role: Role }>> =>
    http("/auth/users"),
  createUser: (
    user: Pick<User, "name" | "email" | "role">,
  ): Promise<{ ok: boolean; simulated?: boolean }> =>
    USING_MOCKS
      ? delay({ ok: true, simulated: true }, 500)
      : http("/admin/users", {
          method: "POST",
        body: JSON.stringify(user),
      }),

  driveFiles: (params: { path?: string; page?: number; limit?: number; sort?: "name" | "size" | "modified"; order?: "asc" | "desc"; search?: string } = {}): Promise<DriveFileList> => {
    const query = new URLSearchParams();
    query.set("path", params.path ?? "/");
    if (params.page) query.set("page", String(params.page));
    if (params.limit) query.set("limit", String(params.limit));
    if (params.sort) query.set("sort", params.sort);
    if (params.order) query.set("order", params.order);
    if (params.search) query.set("search", params.search);
    return http(`/drive/files?${query.toString()}`);
  },

  driveStorage: (): Promise<DriveStorage> => http("/drive/storage"),
  driveFavorites: (): Promise<DriveItem[]> => http("/drive/favorites"),
  driveShares: (): Promise<DriveShare[]> => http("/drive/shares"),
  driveTrash: (): Promise<DriveItem[]> => http("/drive/trash"),
  createDriveFolder: (path: string, name: string): Promise<{ ok: boolean; path: string }> =>
    http("/drive/folders", { method: "POST", body: JSON.stringify({ path, name }) }),
  renameDriveItem: (path: string, name: string): Promise<{ ok: boolean; path: string }> =>
    http("/drive/items", { method: "PATCH", body: JSON.stringify({ path, name }) }),
  moveDriveItem: (path: string, destination: string): Promise<{ ok: boolean; path: string }> =>
    http("/drive/items", { method: "PATCH", body: JSON.stringify({ path, destination }) }),
  deleteDriveItem: (path: string): Promise<{ ok: boolean }> =>
    http("/drive/items", { method: "DELETE", body: JSON.stringify({ path }) }),
  setDriveFavorite: (path: string, favorite: boolean): Promise<{ ok: boolean }> =>
    http("/drive/favorites", { method: "POST", body: JSON.stringify({ path, favorite }) }),
  deleteDriveFavorite: (fileId: string): Promise<{ ok: boolean }> =>
    http(`/drive/favorites/${encodeURIComponent(fileId)}`, { method: "DELETE" }),
  createDriveShare: (payload: { path: string; shareType: "user" | "group" | "link"; shareWith?: string; permissions: 1 | 31; expireDate?: string }): Promise<DriveShare> =>
    http("/drive/shares", { method: "POST", body: JSON.stringify(payload) }),
  deleteDriveShare: (shareId: number): Promise<{ ok: boolean }> =>
    http(`/drive/shares/${shareId}`, { method: "DELETE" }),
  processDriveVideo: (payload: {
    path: string; outputName?: string; compress?: boolean; videoCodec?: "libx264" | "libx265" | "libvpx-vp9" | "copy";
    crf?: number | null; preset?: string; videoBitrate?: string | null; audioCodec?: "aac" | "libopus" | "copy" | "none";
    audioBitrate?: string | null; scale?: string | null; fps?: number | null; trimStart?: number | null; trimEnd?: number | null;
    crop?: string | null; outputFormat?: "mp4" | "webm" | "mkv" | "mov"; useGpu?: boolean;
  }): Promise<{ ok: boolean; source: string; output: DriveItem & { ok?: boolean } }> =>
    http("/drive/video/process", { method: "POST", body: JSON.stringify(payload) }),
  restoreDriveTrash: (path: string): Promise<{ ok: boolean }> =>
    http("/drive/trash/restore", { method: "POST", body: JSON.stringify({ path }) }),
  deleteDriveTrash: (path: string): Promise<{ ok: boolean }> =>
    http("/drive/trash", { method: "DELETE", body: JSON.stringify({ path }) }),
  uploadDriveFiles: (path: string, files: File[], onProgress?: (file: File, percent: number) => void, onXhr?: (file: File, xhr: XMLHttpRequest) => void) =>
    Promise.all(files.map((file) => uploadFile(path, file, (percent) => onProgress?.(file, percent), (xhr) => onXhr?.(file, xhr)))),
  driveDownloadUrl: (path: string): string => `${BASE}/api/v1/drive/download?${new URLSearchParams({ path }).toString()}`,
  driveViewUrl: (path: string): string => `${BASE}/api/v1/drive/download?${new URLSearchParams({ path, inline: "1" }).toString()}`,
  drivePreviewUrl: (path: string, size = 256, token = ""): string => {
    const q = new URLSearchParams({ path, size: String(size) });
    if (token) q.set("token", token);
    return `${BASE}/api/v1/drive/preview?${q.toString()}`;
  },

  apiKeys: (): Promise<ApiKeyInfo[]> => http("/apikeys"),
  createApiKey: (payload: { name: string; scopes: string[]; expiresAt?: string | null }): Promise<ApiKeyInfo & { token?: string }> =>
    http("/apikeys", { method: "POST", body: JSON.stringify(payload) }),
  updateApiKey: (id: string, payload: { name?: string; enabled?: boolean; scopes?: string[] }): Promise<ApiKeyInfo> =>
    http(`/apikeys/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteApiKey: (id: string): Promise<{ ok: boolean; id: string }> =>
    http(`/apikeys/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // S3-compatible object storage (filesystem-backed)
  s3Buckets: (): Promise<Bucket[]> => http("/s3/buckets"),
  s3CreateBucket: (name: string): Promise<Bucket> =>
    http("/s3/buckets", { method: "POST", body: JSON.stringify({ name }) }),
  s3DeleteBucket: (name: string): Promise<{ ok: boolean }> =>
    http(`/s3/buckets/${encodeURIComponent(name)}`, { method: "DELETE" }),
  s3Objects: (bucket: string, prefix = ""): Promise<S3Object[]> => {
    const q = new URLSearchParams();
    if (prefix) q.set("prefix", prefix);
    return http(`/s3/buckets/${encodeURIComponent(bucket)}/objects${q.toString() ? `?${q}` : ""}`);
  },
  s3UploadObject: async (bucket: string, key: string, file: File): Promise<S3Object> => {
    const form = new FormData();
    form.append("key", key);
    form.append("file", file, file.name);
    const res = await fetch(`${BASE}/api/v1/s3/buckets/${encodeURIComponent(bucket)}/objects`, { method: "POST", body: form, credentials: "include" });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string }; detail?: string } | null;
      throw new Error(body?.error?.message ?? body?.detail ?? `${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<S3Object>;
  },
  s3DeleteObject: (bucket: string, key: string): Promise<{ ok: boolean }> =>
    http(`/s3/buckets/${encodeURIComponent(bucket)}/objects?${new URLSearchParams({ key }).toString()}`, { method: "DELETE" }),
  s3DownloadUrl: (bucket: string, key: string): string =>
    `${BASE}/api/v1/s3/buckets/${encodeURIComponent(bucket)}/download?${new URLSearchParams({ key }).toString()}`,

  // Per-user resource attribution
  usersUsage: (): Promise<UserUsage> => http("/users/usage"),
  assignUserUsage: (kind: "container" | "pattern" | "os" | "pid", key: string, user: string): Promise<{ ok: boolean }> =>
    http("/users/usage/assign", { method: "POST", body: JSON.stringify({ kind, key, user }) }),
  unassignUserUsage: (kind: string, key: string): Promise<{ ok: boolean }> =>
    http(`/users/usage/assign?${new URLSearchParams({ kind, key }).toString()}`, { method: "DELETE" }),

  // Minecraft public access (playit.gg agent)
  playitStatus: (): Promise<PlayitStatus> => http("/playit/status"),

  // Minecraft server management
  mcServers: (): Promise<MinecraftServer[]> => http("/minecraft/servers"),
  mcServer: (id: string): Promise<MinecraftServer> => http(`/minecraft/servers/${encodeURIComponent(id)}`),
  mcCreateServer: (payload: Partial<MinecraftServer> & { name: string; rconPassword?: string }): Promise<MinecraftServer> =>
    http("/minecraft/servers", { method: "POST", body: JSON.stringify(payload) }),
  mcUpdateServer: (id: string, payload: Partial<MinecraftServer> & { rconPassword?: string }): Promise<MinecraftServer> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
  mcDeleteServer: (id: string, deleteData = false): Promise<{ ok: boolean }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}?deleteData=${deleteData ? "true" : "false"}`, { method: "DELETE" }),
  mcBackupStatus: (id: string): Promise<McBackupStatus> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/backup`),
  mcBackupConnect: (id: string, payload: { token: string; folder?: string | undefined; keepLast?: number | undefined; restoreOnStart?: boolean | undefined }): Promise<McBackupStatus> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/backup/auth`, { method: "POST", body: JSON.stringify(payload) }),
  mcBackupDisconnect: (id: string): Promise<McBackupStatus> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/backup/auth`, { method: "DELETE" }),
  mcBackupSettings: (id: string, payload: { enabled?: boolean | undefined; keepLast?: number | undefined; restoreOnStart?: boolean | undefined; folder?: string | undefined }): Promise<McBackupStatus> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/backup/settings`, { method: "PATCH", body: JSON.stringify(payload) }),
  mcBackupRun: (id: string): Promise<McBackupRun> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/backup/run`, { method: "POST" }),
  mcBackupRestore: (id: string): Promise<McBackupRestore> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/backup/restore?confirm=true`, { method: "POST" }),
  mcStartServer: (id: string): Promise<{ ok: boolean; status: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/start`, { method: "POST" }),
  mcStopServer: (id: string): Promise<{ ok: boolean; status: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  mcRestartServer: (id: string): Promise<{ ok: boolean; status: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/restart`, { method: "POST" }),
  mcServerLogs: (id: string, tail = 200): Promise<{ logs: string; exists?: boolean; tail?: number }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/logs?tail=${tail}`),
  mcServerCommand: (id: string, command: string): Promise<{ ok: boolean; output: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/command`, { method: "POST", body: JSON.stringify({ command }) }),
  mcCatalog: (): Promise<McCatalog> => http("/minecraft/catalog"),
  mcPlayers: (id: string): Promise<McPlayers> => http(`/minecraft/servers/${encodeURIComponent(id)}/players`),
  mcPlayerAction: (id: string, action: string, name: string): Promise<{ ok: boolean; message: string; players: McPlayers }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/players`, { method: "POST", body: JSON.stringify({ action, name }) }),
  mcWorlds: (id: string): Promise<McWorlds> => http(`/minecraft/servers/${encodeURIComponent(id)}/worlds`),
  mcCreateWorld: (id: string, payload: { name: string; seed?: string; levelType?: string }): Promise<{ ok: boolean; world: string; message: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/worlds`, { method: "POST", body: JSON.stringify(payload) }),
  mcActivateWorld: (id: string, name: string): Promise<{ ok: boolean; message: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/worlds/${encodeURIComponent(name)}/activate`, { method: "POST" }),
  mcRegenerateWorld: (id: string, name: string): Promise<{ ok: boolean; message: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/worlds/${encodeURIComponent(name)}/regenerate`, { method: "POST" }),
  mcDeleteWorld: (id: string, name: string): Promise<{ ok: boolean; message: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/worlds/${encodeURIComponent(name)}`, { method: "DELETE" }),
  mcUploadWorld: (id: string, file: File, name: string): Promise<{ ok: boolean; world: string; message: string }> => {
    const form = new FormData();
    form.append("file", file, file.name);
    if (name.trim()) form.append("name", name.trim());
    return http(`/minecraft/servers/${encodeURIComponent(id)}/worlds/upload`, { method: "POST", body: form });
  },
  mcAddons: (id: string): Promise<McAddons> => http(`/minecraft/servers/${encodeURIComponent(id)}/addons`),
  mcUploadAddon: (id: string, file: File): Promise<{ ok: boolean; file: string; message: string }> => {
    const form = new FormData();
    form.append("file", file, file.name);
    return http(`/minecraft/servers/${encodeURIComponent(id)}/addons/upload`, { method: "POST", body: form });
  },
  mcDeleteAddon: (id: string, name: string): Promise<{ ok: boolean; message: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/addons/${encodeURIComponent(name)}`, { method: "DELETE" }),
  mcSearchAddons: (id: string, query: string): Promise<McAddonSearch> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/addons/search?q=${encodeURIComponent(query)}&limit=12`),
  mcInstallAddon: (id: string, projectId: string): Promise<{ ok: boolean; file: string; message: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/addons/install`, { method: "POST", body: JSON.stringify({ projectId }) }),
  mcChangeSoftware: (id: string, type: string, version: string): Promise<{ ok: boolean; type: string; version: string; message: string }> =>
    http(`/minecraft/servers/${encodeURIComponent(id)}/software`, { method: "POST", body: JSON.stringify({ type, version }) }),

  // Per-user workspaces: JupyterLab, Git and Google Drive
  workspaces: (): Promise<Workspace[]> => http("/workspaces"),
  workspace: (user: string): Promise<Workspace> => http(`/workspaces/${encodeURIComponent(user)}`),
  wsStart: (user: string, payload: { memoryMiB: number; cpus: number; gpu: boolean; image?: string }): Promise<Workspace> =>
    http(`/workspaces/${encodeURIComponent(user)}/start`, { method: "POST", body: JSON.stringify(payload) }),
  wsStop: (user: string): Promise<{ ok: boolean; status: string }> =>
    http(`/workspaces/${encodeURIComponent(user)}/stop`, { method: "POST" }),
  wsRestart: (user: string): Promise<Workspace> =>
    http(`/workspaces/${encodeURIComponent(user)}/restart`, { method: "POST" }),
  wsRotateToken: (user: string): Promise<Workspace> =>
    http(`/workspaces/${encodeURIComponent(user)}/token/rotate`, { method: "POST" }),
  wsLogs: (user: string, tail = 200): Promise<{ logs: string; exists?: boolean }> =>
    http(`/workspaces/${encodeURIComponent(user)}/logs?tail=${tail}`),
  wsGit: (user: string): Promise<{ repos: WorkspaceRepo[]; credentials: string[] }> =>
    http(`/workspaces/${encodeURIComponent(user)}/git`),
  wsAddGitCredential: (user: string, payload: { host: string; username: string; token: string }): Promise<{ ok: boolean; credentials: string[] }> =>
    http(`/workspaces/${encodeURIComponent(user)}/git/credentials`, { method: "POST", body: JSON.stringify(payload) }),
  wsDeleteGitCredential: (user: string, host: string): Promise<{ ok: boolean; credentials: string[] }> =>
    http(`/workspaces/${encodeURIComponent(user)}/git/credentials?${new URLSearchParams({ host }).toString()}`, { method: "DELETE" }),
  wsCloneRepo: (user: string, payload: { url: string; name?: string | undefined; branch?: string | undefined; userName?: string; userEmail?: string }): Promise<{ ok: boolean; repo: WorkspaceRepo; usedCredential: boolean }> =>
    http(`/workspaces/${encodeURIComponent(user)}/git/repos`, { method: "POST", body: JSON.stringify(payload) }),
  wsRepoAction: (user: string, name: string, action: "pull" | "push" | "fetch"): Promise<{ ok: boolean; output: string; repo: WorkspaceRepo }> =>
    http(`/workspaces/${encodeURIComponent(user)}/git/repos/${encodeURIComponent(name)}/${action}`, { method: "POST" }),
  wsRepoLog: (user: string, name: string, tail = 20): Promise<{ commits: { hash: string; author: string; age: string; subject: string }[] }> =>
    http(`/workspaces/${encodeURIComponent(user)}/git/repos/${encodeURIComponent(name)}/log?tail=${tail}`),
  wsDeleteRepo: (user: string, name: string): Promise<{ ok: boolean }> =>
    http(`/workspaces/${encodeURIComponent(user)}/git/repos/${encodeURIComponent(name)}`, { method: "DELETE" }),
  wsUpload: (user: string, files: File[], path = ""): Promise<{ ok: boolean; uploaded: { name: string; path: string; sizeBytes: number }[]; totalBytes: number }> => {
    const form = new FormData();
    for (const file of files) form.append("files", file, file.name);
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return http(`/workspaces/${encodeURIComponent(user)}/files${query}`, { method: "POST", body: form });
  },
  wsCreateNotebook: (user: string, payload: { name?: string | undefined; path?: string | undefined }): Promise<{ ok: boolean; notebook: string; name: string }> =>
    http(`/workspaces/${encodeURIComponent(user)}/notebooks`, { method: "POST", body: JSON.stringify(payload) }),
  wsDrive: (user: string): Promise<WorkspaceDrive & { localBytes: number }> =>
    http(`/workspaces/${encodeURIComponent(user)}/drive`),
  wsDriveConnect: (user: string, payload: { token: string; clientId?: string | undefined; clientSecret?: string | undefined; remotePath?: string | undefined }): Promise<WorkspaceDrive> =>
    http(`/workspaces/${encodeURIComponent(user)}/drive/connect`, { method: "POST", body: JSON.stringify(payload) }),
  wsDriveSync: (user: string, direction: "pull" | "push"): Promise<WorkspaceDrive> =>
    http(`/workspaces/${encodeURIComponent(user)}/drive/sync`, { method: "POST", body: JSON.stringify({ direction }) }),
  wsDriveDisconnect: (user: string): Promise<{ ok: boolean }> =>
    http(`/workspaces/${encodeURIComponent(user)}/drive`, { method: "DELETE" }),
};
