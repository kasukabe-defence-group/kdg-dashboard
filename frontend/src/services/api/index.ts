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
