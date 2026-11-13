export type Role = "owner" | "admin" | "moderator" | "member";
export type HealthState = "running" | "stopped" | "unhealthy" | "restarting";

export interface Overview {
  hostname: string;
  online: boolean;
  os: string;
  cpuModel: string;
  uptimeSeconds: number;
  cpuPercent: number;
  memUsedGiB: number;
  memTotalGiB: number;
  swapUsedGiB: number;
  swapTotalGiB: number;
  diskUsedGiB: number;
  diskTotalGiB: number;
  netUpMbps: number;
  netDownMbps: number;
  gpu: { utilPercent: number; vramUsedMiB: number; vramTotalMiB: number; tempC: number };
  runningContainers: number;
  runningApps: number;
  activeUsers: number;
  alerts: Alert[];
}

export interface Alert {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  at: string;
}

export interface SeriesPoint {
  t: string;
  [k: string]: number | string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  status: HealthState;
  cpuPercent: number;
  memMiB: number;
  memLimitMiB: number;
  netRx: string;
  netTx: string;
  uptime: string;
  ports: string[];
  restartPolicy: "always" | "unless-stopped" | "on-failure" | "no";
  stack?: string;
  env: Record<string, string>;
  mounts: { source: string; target: string; mode: "rw" | "ro" }[];
  networks: string[];
  restarts: { at: string; reason: string }[];
}

export interface ComposeStack {
  id: string;
  name: string;
  path: string;
  status: HealthState;
  containers: string[];
  deployments: { at: string; by: string; result: "success" | "failed"; note: string }[];
}

export interface Process {
  pid: number;
  ppid: number;
  name: string;
  user: string;
  cpu: number;
  memPercent: number;
  rssMiB: number;
  readKBs: number;
  writeKBs: number;
  cgroup: string;
  unit?: string | undefined;
  status: "R" | "S" | "D" | "Z" | "I";
  command: string;
  owner?: string | null;
  ownerSource?: string | null;
}

export interface GpuInfo {
  name: string;
  driver: string;
  cuda: string;
  utilPercent: number;
  vramUsedMiB: number;
  vramTotalMiB: number;
  tempC: number;
  powerW: number | null;
  powerLimitW: number | null;
  processes: { pid: number; name: string; vramMiB: number; utilPercent: number | null }[];
}

export interface DriveItem {
  name: string;
  path: string;
  fileType: "folder" | "file";
  mimeType: string | null;
  sizeBytes: number;
  modified: string | null;
  etag: string | null;
  fileId: string | null;
  owner: string | null;
  starred: boolean;
  shared: boolean;
  trashed: boolean;
}

export interface MockDriveItem {
  id: string;
  name: string;
  kind: "folder" | "image" | "video" | "pdf" | "text" | "code" | "archive" | "other";
  sizeBytes: number;
  modified: string;
  owner: string;
  parentId: string | null;
  starred?: boolean;
  shared?: boolean;
  trashed?: boolean;
}

export interface DriveFileList {
  items: DriveItem[];
  path: string;
  page: number;
  limit: number;
  total: number;
}

export interface DriveStorage {
  usedBytes: number;
  freeBytes: number | null;
  totalBytes: number | null;
  percentageUsed: number | null;
  unlimited: boolean;
}

export interface DriveShare {
  id: number;
  path: string;
  shareType: number;
  shareWith?: string;
  shareWithDisplayName?: string;
  permissions: number;
  url?: string;
  expiration?: string;
}

export interface Bucket {
  name: string;
  region: string;
  objects: number;
  sizeBytes: number;
  versioning: "Enabled" | "Suspended" | "Disabled";
  access: "Private" | "Public read";
  created: string;
}

export interface S3Object {
  key: string;
  sizeBytes: number;
  modified: string;
  contentType: string;
  isPrefix?: boolean;
}

export interface AppService {
  id: string;
  name: string;
  category: string;
  description: string;
  status: "installed-running" | "installed-stopped" | "available";
  cpu?: number;
  memMiB?: number;
  access: Role[];
  url?: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "active" | "invited" | "disabled";
  lastLogin: string;
  mfa: boolean;
  quotaGiB: number;
  usedGiB: number;
  services: string[];
}

export interface AuthUser {
  username: string;
  displayName: string;
  role: Role;
}

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  event: string;
  resource: string;
  action: string;
  result: "success" | "denied" | "error";
  device: string;
  ip: string;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  enabled: boolean;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string | null;
  usageCount: number;
  expiresAt?: string | null;
  token?: string;
}

export interface MinecraftServer {
  id: string;
  name: string;
  description?: string;
  type: string;
  version: string;
  memory: string;
  port: number;
  maxPlayers: number;
  motd: string;
  difficulty: string;
  gamemode: string;
  pvp: boolean;
  onlineMode: boolean;
  enableRcon: boolean;
  rconConfigured?: boolean;
  createdAt?: number;
  createdBy?: string;
  containerName?: string;
  address?: string;
  addresses?: string[];
  runtime?: {
    exists: boolean;
    state: string;
    status: string;
    running?: boolean;
    health?: string | null;
    ports?: string[];
    startedAt?: string;
    containerId?: string;
  };
}

export interface McCatalogType {
  id: string;
  label: string;
  kind: "plugins" | "mods" | "none";
  versions: string[];
}

export interface McCatalog {
  types: McCatalogType[];
  mcVersions: string[];
  fetchedAt: number;
}

export interface McBannedPlayer {
  name: string;
  reason: string;
  source: string;
  created: string;
  expires: string;
}

export interface McPlayers {
  online: string[];
  maxPlayers: number;
  whitelist: string[];
  ops: string[];
  banned: McBannedPlayer[];
  bannedIps: string[];
  whitelistEnabled: boolean;
}

export interface McWorld {
  name: string;
  active: boolean;
  sizeBytes: number;
  modifiedAt: string;
}

export interface McWorlds {
  active: string;
  worlds: McWorld[];
  running: boolean;
  maxUploadBytes: number;
}

export interface McAddon {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface McAddons {
  kind: "plugins" | "mods";
  installed: McAddon[];
  running: boolean;
}

export interface McAddonHit {
  id: string;
  slug: string;
  title: string;
  description: string;
  downloads: number;
  author: string;
  iconUrl?: string;
  categories: string[];
}

export interface McAddonSearch {
  results: McAddonHit[];
  kind: "plugins" | "mods";
  loaders: string[];
  version: string;
}

export interface PlayitStatus {
  installed: boolean;
  serviceActive: boolean | null;
  phase: string | null;
  pid: number | null;
  uptimeSeconds: number | null;
  version: string | null;
  secretConfigured: boolean | null;
  ipcVersion: number | null;
  dashboardUrl: string;
  agentUrl: string;
  claimUrl: string;
}

export interface McBackupStatus {
  serverId: string;
  authorized: boolean;
  enabled: boolean;
  folder: string;
  keepLast: number;
  restoreOnStart: boolean;
  lastRun: number | null;
  lastRunIso: string | null;
  lastResult: string | null;
  lastError: string;
  totalBackups: number;
  localTarballs: number;
  remoteFolder: string | null;
}

export interface McBackupRun {
  ok: boolean;
  tarball: string;
  sizeBytes: number;
  savedWorld: string;
  running: boolean;
  reason: string;
  uploaded: boolean;
  uploadReason: string;
  remoteFiles: number | null;
}

export interface McBackupRestore {
  ok: boolean;
  restored: string;
  stashedTo: string | null;
  bytes: number | null;
}

export interface UserProcessUsage {
  pid: number;
  name: string;
  command: string;
  cpu: number;
  rssMiB: number;
  gpuMiB: number;
  osUser: string;
  source: string;
}

export interface UserUsageEntry {
  username: string;
  displayName: string;
  role: Role | "external";
  activeSessions: number;
  lastLogin: string | null;
  processes: UserProcessUsage[];
  containers: { name: string; state: string; managed: string }[];
  apiKeys: Array<Pick<ApiKeyInfo, "id" | "name" | "prefix" | "scopes" | "enabled" | "usageCount" | "lastUsedAt" | "expiresAt">>;
  cpuPercent: number;
  memMiB: number;
  gpuMiB: number;
  processCount: number;
  gpuProcessCount: number;
}

export interface UserUsage {
  generatedAt: string;
  users: UserUsageEntry[];
  unattributed: { processCount: number; cpuPercent: number; memMiB: number; gpuMiB: number };
  gpuProcesses: { pid: number; name: string; vramMiB: number; owner: string | null; ownerSource: string | null }[];
  gpu: { name: string; utilPercent: number; vramUsedMiB: number; vramTotalMiB: number; tempC: number };
  host: { cpuPercent: number; cpuCount: number; memUsedMiB: number; memTotalMiB: number; processCount: number };
  map?: { containers: Record<string, string>; patterns: { match: string; user: string }[]; os: Record<string, string> };
}

export interface WorkspaceRepo {
  name: string;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  lastCommit: string;
  commitAuthor?: string;
  commitAge?: string;
  remote: string;
}

export interface WorkspaceDrive {
  connected: boolean;
  remotePath: string;
  lastSync: number | null;
  lastResult: string;
  quota: { total?: number; used?: number; free?: number } | null;
  localBytes?: number;
}

export interface Workspace {
  username: string;
  displayName: string;
  role: Role | "external";
  state: "running" | "stopped" | "not_created" | string;
  running: boolean;
  status: string;
  startedAt?: string | null;
  containerName: string;
  port: number;
  memoryMiB: number;
  cpus: number;
  gpu: boolean;
  image: string;
  labPath?: string;
  labReady?: boolean;
  diskBytes: number;
  usage: { cpuPercent: number | null; memMiB: number | null; memLimitMiB: number | null; gpuMiB: number | null };
  git: { repos: WorkspaceRepo[]; credentials: string[] };
  drive: WorkspaceDrive;
  token?: string;
}
