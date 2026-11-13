// MOCK DATA — illustrative values only. Not live measurements.
import type {
  AppService, AuditEvent, Bucket, ComposeStack, Container, MockDriveItem, GpuInfo,
  Overview, Process, S3Object, SeriesPoint, User,
} from "@/types";

// Deterministic pseudo-random for stable SSR/hydration
function wave(i: number, base: number, amp: number, seed = 1) {
  return Math.max(0, +(base + amp * Math.sin(i / 3.1 + seed) + (amp / 2) * Math.sin(i / 1.3 + seed * 2)).toFixed(1));
}

export function series(keys: Record<string, [number, number]>, n = 30): SeriesPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const p: SeriesPoint = { t: `${String(Math.floor((i * 2) / 60) + 10).padStart(2, "0")}:${String((i * 2) % 60).padStart(2, "0")}` };
    Object.entries(keys).forEach(([k, [b, a]], j) => (p[k] = wave(i, b, a, j + 1)));
    return p;
  });
}

export const overview: Overview = {
  hostname: "kdg-node-01",
  online: true,
  os: "Ubuntu Server 26.04 LTS",
  cpuModel: "Intel Core i5-10300H · 4C/8T",
  uptimeSeconds: 1_382_400 + 13_560,
  cpuPercent: 37,
  memUsedGiB: 5.4,
  memTotalGiB: 7.6,
  swapUsedGiB: 0.6,
  swapTotalGiB: 4,
  diskUsedGiB: 71.3,
  diskTotalGiB: 120,
  netUpMbps: 4.2,
  netDownMbps: 18.7,
  gpu: { utilPercent: 22, vramUsedMiB: 1180, vramTotalMiB: 4096, tempC: 58 },
  runningContainers: 9,
  runningApps: 5,
  activeUsers: 3,
  alerts: [
    { id: "a1", severity: "warning", title: "Memory pressure", detail: "RAM above 70% for 25 min", at: "12 min ago" },
    { id: "a2", severity: "critical", title: "uptime-kuma unhealthy", detail: "Health check failed 3×", at: "34 min ago" },
    { id: "a3", severity: "info", title: "Backup completed", detail: "kdg-backups · 2.1 GiB", at: "3 h ago" },
  ],
};

const env = (o: Record<string, string>) => o;

export const containers: Container[] = [
  { id: "c1a9f2", name: "nextcloud-app", image: "nextcloud:29-apache", status: "running", cpuPercent: 6.2, memMiB: 412, memLimitMiB: 1024, netRx: "1.2 GB", netTx: "3.4 GB", uptime: "6d 4h", ports: ["443→8443/tcp"], restartPolicy: "unless-stopped", stack: "nextcloud",
    env: env({ NEXTCLOUD_TRUSTED_DOMAINS: "cloud.kdg.local", POSTGRES_HOST: "nextcloud-db", POSTGRES_PASSWORD: "••••••••", REDIS_HOST: "redis" }),
    mounts: [{ source: "/srv/kdg/nextcloud/data", target: "/var/www/html/data", mode: "rw" }], networks: ["kdg-internal", "proxy"], restarts: [{ at: "6d ago", reason: "Host reboot" }] },
  { id: "c2b7e1", name: "nextcloud-db", image: "postgres:16-alpine", status: "running", cpuPercent: 1.8, memMiB: 168, memLimitMiB: 512, netRx: "640 MB", netTx: "520 MB", uptime: "6d 4h", ports: [], restartPolicy: "unless-stopped", stack: "nextcloud",
    env: env({ POSTGRES_DB: "nextcloud", POSTGRES_USER: "nc", POSTGRES_PASSWORD: "••••••••" }),
    mounts: [{ source: "/srv/kdg/pg", target: "/var/lib/postgresql/data", mode: "rw" }], networks: ["kdg-internal"], restarts: [] },
  { id: "c3d4a0", name: "redis", image: "redis:7.4-alpine", status: "running", cpuPercent: 0.4, memMiB: 24, memLimitMiB: 256, netRx: "88 MB", netTx: "91 MB", uptime: "6d 4h", ports: [], restartPolicy: "always", stack: "nextcloud",
    env: env({}), mounts: [], networks: ["kdg-internal"], restarts: [] },
  { id: "c4e8b3", name: "minecraft-paper", image: "itzg/minecraft-server:java21", status: "running", cpuPercent: 18.9, memMiB: 2048, memLimitMiB: 2560, netRx: "2.8 GB", netTx: "5.1 GB", uptime: "2d 11h", ports: ["25565→25565/tcp"], restartPolicy: "unless-stopped", stack: "minecraft",
    env: env({ TYPE: "PAPER", MEMORY: "2G", RCON_PASSWORD: "••••••••", EULA: "TRUE" }),
    mounts: [{ source: "/srv/kdg/minecraft", target: "/data", mode: "rw" }], networks: ["kdg-games"], restarts: [{ at: "2d ago", reason: "OOM killed" }, { at: "5d ago", reason: "Manual restart" }] },
  { id: "c5f1c9", name: "jupyterlab", image: "jupyter/pytorch-notebook:cuda12", status: "running", cpuPercent: 3.1, memMiB: 690, memLimitMiB: 2048, netRx: "210 MB", netTx: "40 MB", uptime: "1d 2h", ports: ["8888→8888/tcp"], restartPolicy: "on-failure", stack: "ai-lab",
    env: env({ JUPYTER_TOKEN: "••••••••", NVIDIA_VISIBLE_DEVICES: "all" }),
    mounts: [{ source: "/srv/kdg/notebooks", target: "/home/jovyan/work", mode: "rw" }], networks: ["kdg-internal", "proxy"], restarts: [] },
  { id: "c6a2d7", name: "caddy", image: "caddy:2.8", status: "running", cpuPercent: 0.7, memMiB: 38, memLimitMiB: 256, netRx: "9.4 GB", netTx: "11.2 GB", uptime: "6d 4h", ports: ["80→80/tcp", "443→443/tcp"], restartPolicy: "always", stack: "edge",
    env: env({ ACME_EMAIL: "ops@kdg.local" }), mounts: [{ source: "/srv/kdg/caddy/Caddyfile", target: "/etc/caddy/Caddyfile", mode: "ro" }], networks: ["proxy"], restarts: [] },
  { id: "c7b9e4", name: "minio", image: "minio/minio:RELEASE.2026-09", status: "running", cpuPercent: 1.2, memMiB: 156, memLimitMiB: 512, netRx: "4.1 GB", netTx: "1.9 GB", uptime: "6d 4h", ports: ["9000→9000/tcp", "9001→9001/tcp"], restartPolicy: "unless-stopped", stack: "storage",
    env: env({ MINIO_ROOT_USER: "kdg-admin", MINIO_ROOT_PASSWORD: "••••••••" }), mounts: [{ source: "/srv/kdg/s3", target: "/data", mode: "rw" }], networks: ["kdg-internal", "proxy"], restarts: [] },
  { id: "c8c3f5", name: "uptime-kuma", image: "louislam/uptime-kuma:1", status: "unhealthy", cpuPercent: 0.3, memMiB: 92, memLimitMiB: 256, netRx: "40 MB", netTx: "12 MB", uptime: "34m", ports: ["3001→3001/tcp"], restartPolicy: "always", stack: "monitoring",
    env: env({}), mounts: [{ source: "/srv/kdg/kuma", target: "/app/data", mode: "rw" }], networks: ["proxy"], restarts: [{ at: "34m ago", reason: "Health check failed" }] },
  { id: "c9d0a6", name: "forgejo", image: "codeberg.org/forgejo/forgejo:9", status: "running", cpuPercent: 0.9, memMiB: 140, memLimitMiB: 512, netRx: "310 MB", netTx: "120 MB", uptime: "6d 4h", ports: ["3000→3000/tcp", "2222→22/tcp"], restartPolicy: "unless-stopped", stack: "devtools",
    env: env({ FORGEJO__database__PASSWD: "••••••••" }), mounts: [{ source: "/srv/kdg/forgejo", target: "/data", mode: "rw" }], networks: ["proxy"], restarts: [] },
  { id: "caa1b2", name: "website-static", image: "nginx:1.27-alpine", status: "stopped", cpuPercent: 0, memMiB: 0, memLimitMiB: 128, netRx: "—", netTx: "—", uptime: "—", ports: ["8080→80/tcp"], restartPolicy: "no", stack: "edge",
    env: env({}), mounts: [{ source: "/srv/kdg/www", target: "/usr/share/nginx/html", mode: "ro" }], networks: ["proxy"], restarts: [] },
];

export const stacks: ComposeStack[] = [
  { id: "nextcloud", name: "nextcloud", path: "/srv/kdg/stacks/nextcloud/compose.yaml", status: "running", containers: ["nextcloud-app", "nextcloud-db", "redis"],
    deployments: [{ at: "6d ago", by: "parth", result: "success", note: "Upgrade to 29.0.8" }, { at: "21d ago", by: "parth", result: "success", note: "Initial deploy" }] },
  { id: "minecraft", name: "minecraft", path: "/srv/kdg/stacks/minecraft/compose.yaml", status: "running", containers: ["minecraft-paper"],
    deployments: [{ at: "2d ago", by: "shinchan", result: "success", note: "Raised memory to 2G" }, { at: "2d ago", by: "shinchan", result: "failed", note: "Invalid MEMORY value" }] },
  { id: "ai-lab", name: "ai-lab", path: "/srv/kdg/stacks/ai-lab/compose.yaml", status: "running", containers: ["jupyterlab"], deployments: [{ at: "1d ago", by: "parth", result: "success", note: "CUDA 12 image" }] },
  { id: "edge", name: "edge", path: "/srv/kdg/stacks/edge/compose.yaml", status: "running", containers: ["caddy", "website-static"], deployments: [{ at: "9d ago", by: "parth", result: "success", note: "Add forgejo route" }] },
  { id: "storage", name: "storage", path: "/srv/kdg/stacks/storage/compose.yaml", status: "running", containers: ["minio"], deployments: [] },
  { id: "monitoring", name: "monitoring", path: "/srv/kdg/stacks/monitoring/compose.yaml", status: "unhealthy", containers: ["uptime-kuma"], deployments: [{ at: "34m ago", by: "system", result: "failed", note: "Auto-restart after health check" }] },
  { id: "devtools", name: "devtools", path: "/srv/kdg/stacks/devtools/compose.yaml", status: "running", containers: ["forgejo"], deployments: [] },
];

const procNames: [string, string, string, string | undefined][] = [
  ["java", "1000", "docker/minecraft-paper", undefined], ["php-fpm", "www-data", "docker/nextcloud-app", undefined],
  ["postgres", "70", "docker/nextcloud-db", undefined], ["python3", "jovyan", "docker/jupyterlab", undefined],
  ["dockerd", "root", "system.slice", "docker.service"], ["containerd", "root", "system.slice", "containerd.service"],
  ["caddy", "root", "docker/caddy", undefined], ["minio", "root", "docker/minio", undefined],
  ["node", "root", "docker/uptime-kuma", undefined], ["forgejo", "git", "docker/forgejo", undefined],
  ["systemd-journald", "root", "system.slice", "systemd-journald.service"], ["sshd", "root", "system.slice", "ssh.service"],
  ["nvidia-persistenced", "root", "system.slice", "nvidia-persistenced.service"], ["kdg-agent", "kdg", "system.slice", "kdg-agent.service"],
  ["redis-server", "999", "docker/redis", undefined], ["tailscaled", "root", "system.slice", "tailscaled.service"],
  ["bash", "parth", "user.slice", "session-4.scope"], ["htop", "parth", "user.slice", "session-4.scope"],
];
export const processes: Process[] = procNames.map(([name, user, cgroup, unit], i) => ({
  pid: 1000 + i * 137 + (i % 3) * 11, ppid: i < 4 ? 900 + i : 1, name, user, cgroup, unit,
  cpu: +(Math.abs(Math.sin(i * 1.7)) * (i === 0 ? 40 : 8)).toFixed(1),
  memPercent: +(Math.abs(Math.cos(i * 1.3)) * (i === 0 ? 27 : 5)).toFixed(1),
  rssMiB: Math.round(Math.abs(Math.cos(i * 1.3)) * (i === 0 ? 2100 : 380)),
  readKBs: Math.round(Math.abs(Math.sin(i)) * 300), writeKBs: Math.round(Math.abs(Math.cos(i)) * 180),
  status: i % 7 === 3 ? "D" : i % 4 === 0 ? "R" : "S",
  command: `/usr/bin/${name} ${i === 0 ? "-Xmx2G -jar paper.jar nogui" : "--config /etc/" + name}`,
}));

export const gpu: GpuInfo = {
  name: "NVIDIA GeForce GTX 1050 Mobile", driver: "550.120", cuda: "12.4",
  utilPercent: 22, vramUsedMiB: 1180, vramTotalMiB: 4096, tempC: 58, powerW: null, powerLimitW: null,
  processes: [
    { pid: 2410, name: "python3 (jupyterlab)", vramMiB: 1024, utilPercent: null },
    { pid: 1890, name: "Xorg", vramMiB: 4, utilPercent: null },
    { pid: 2532, name: "ffmpeg (nextcloud preview)", vramMiB: 152, utilPercent: null },
  ],
};

const d = (s: string) => s;
export const driveItems: MockDriveItem[] = [
  { id: "f-docs", name: "Documents", kind: "folder", sizeBytes: 0, modified: d("2026-11-04"), owner: "parth", parentId: null },
  { id: "f-photos", name: "Photos", kind: "folder", sizeBytes: 0, modified: d("2026-11-02"), owner: "parth", parentId: null, starred: true },
  { id: "f-proj", name: "Projects", kind: "folder", sizeBytes: 0, modified: d("2026-11-05"), owner: "parth", parentId: null },
  { id: "f-shared", name: "Team Kasukabe", kind: "folder", sizeBytes: 0, modified: d("2026-10-30"), owner: "kazama", parentId: null, shared: true },
  { id: "i1", name: "server-rack.jpg", kind: "image", sizeBytes: 3_400_000, modified: d("2026-11-02"), owner: "parth", parentId: "f-photos", starred: true },
  { id: "i2", name: "beach-2026.png", kind: "image", sizeBytes: 5_100_000, modified: d("2026-10-21"), owner: "parth", parentId: "f-photos" },
  { id: "v1", name: "minecraft-timelapse.mp4", kind: "video", sizeBytes: 412_000_000, modified: d("2026-10-18"), owner: "shinchan", parentId: null, shared: true },
  { id: "p1", name: "KDG-architecture.pdf", kind: "pdf", sizeBytes: 1_800_000, modified: d("2026-11-04"), owner: "parth", parentId: "f-docs", starred: true },
  { id: "t1", name: "notes.md", kind: "text", sizeBytes: 4_200, modified: d("2026-11-06"), owner: "parth", parentId: "f-docs" },
  { id: "c1", name: "compose.yaml", kind: "code", sizeBytes: 2_100, modified: d("2026-11-05"), owner: "parth", parentId: "f-proj" },
  { id: "c2", name: "train_model.py", kind: "code", sizeBytes: 8_900, modified: d("2026-11-03"), owner: "parth", parentId: "f-proj" },
  { id: "z1", name: "world-backup.tar.gz", kind: "archive", sizeBytes: 1_900_000_000, modified: d("2026-11-01"), owner: "shinchan", parentId: null },
  { id: "t2", name: "meeting-minutes.txt", kind: "text", sizeBytes: 3_100, modified: d("2026-10-30"), owner: "kazama", parentId: "f-shared", shared: true },
  { id: "o1", name: "old-draft.docx", kind: "other", sizeBytes: 220_000, modified: d("2026-09-12"), owner: "parth", parentId: null, trashed: true },
];

export const buckets: Bucket[] = [
  { name: "user-storage", region: "kdg-local-1", objects: 4821, sizeBytes: 28_400_000_000, versioning: "Enabled", access: "Private", created: "2026-08-14" },
  { name: "website-assets", region: "kdg-local-1", objects: 312, sizeBytes: 640_000_000, versioning: "Disabled", access: "Public read", created: "2026-08-20" },
  { name: "app-uploads", region: "kdg-local-1", objects: 1290, sizeBytes: 3_100_000_000, versioning: "Suspended", access: "Private", created: "2026-09-02" },
  { name: "minecraft-backups", region: "kdg-local-1", objects: 48, sizeBytes: 9_800_000_000, versioning: "Enabled", access: "Private", created: "2026-09-10" },
  { name: "kdg-backups", region: "kdg-local-1", objects: 162, sizeBytes: 14_200_000_000, versioning: "Enabled", access: "Private", created: "2026-08-14" },
];

export function bucketObjects(bucket: string, prefix: string): S3Object[] {
  const root: Record<string, S3Object[]> = {
    "": [
      { key: "2026/", sizeBytes: 0, modified: "", contentType: "", isPrefix: true },
      { key: "shared/", sizeBytes: 0, modified: "", contentType: "", isPrefix: true },
      { key: "README.txt", sizeBytes: 1_204, modified: "2026-10-01 09:14", contentType: "text/plain" },
      { key: `${bucket}-manifest.json`, sizeBytes: 18_330, modified: "2026-11-05 22:01", contentType: "application/json" },
    ],
    "2026/": [
      { key: "2026/11/", sizeBytes: 0, modified: "", contentType: "", isPrefix: true },
      { key: "2026/snapshot-1031.tar.zst", sizeBytes: 2_140_000_000, modified: "2026-10-31 03:00", contentType: "application/zstd" },
      { key: "2026/logo.svg", sizeBytes: 9_800, modified: "2026-09-12 14:20", contentType: "image/svg+xml" },
    ],
    "2026/11/": [
      { key: "2026/11/snapshot-1105.tar.zst", sizeBytes: 2_210_000_000, modified: "2026-11-05 03:00", contentType: "application/zstd" },
      { key: "2026/11/report.pdf", sizeBytes: 482_000, modified: "2026-11-05 08:44", contentType: "application/pdf" },
    ],
    "shared/": [{ key: "shared/team-photo.jpg", sizeBytes: 3_900_000, modified: "2026-10-22 18:10", contentType: "image/jpeg" }],
  };
  return root[prefix] ?? [];
}

export const appCatalogue: AppService[] = [
  { id: "nextcloud", name: "Nextcloud", category: "Files and collaboration", description: "Files, calendar and contacts for the team.", status: "installed-running", cpu: 6.2, memMiB: 604, access: ["owner", "admin", "member"], url: "https://cloud.kdg.local" },
  { id: "postgres", name: "PostgreSQL", category: "Databases", description: "Relational database for apps and APIs.", status: "installed-running", cpu: 1.8, memMiB: 168, access: ["owner", "admin"] },
  { id: "redis", name: "Redis", category: "Databases", description: "In-memory cache and queue.", status: "installed-running", cpu: 0.4, memMiB: 24, access: ["owner", "admin"] },
  { id: "minecraft", name: "Minecraft Paper", category: "Game servers", description: "High-performance Minecraft Java server.", status: "installed-running", cpu: 18.9, memMiB: 2048, access: ["owner", "admin", "member"] },
  { id: "jupyter", name: "JupyterLab", category: "AI and machine learning", description: "Notebooks with CUDA access on the GTX 1050.", status: "installed-running", cpu: 3.1, memMiB: 690, access: ["owner", "admin"] },
  { id: "forgejo", name: "Forgejo", category: "Developer tools", description: "Lightweight self-hosted Git forge.", status: "installed-running", cpu: 0.9, memMiB: 140, access: ["owner", "admin", "member"] },
  { id: "kuma", name: "Uptime Kuma", category: "Monitoring", description: "Status pages and uptime checks.", status: "installed-stopped", access: ["owner", "admin"] },
  { id: "restic", name: "Restic Backups", category: "Backups", description: "Encrypted, deduplicated backups to S3.", status: "available", access: ["owner"] },
  { id: "static", name: "Static Website", category: "Websites and APIs", description: "Nginx site served through Caddy.", status: "installed-stopped", access: ["owner", "admin"] },
  { id: "fastapi", name: "FastAPI Service", category: "Websites and APIs", description: "Python API template behind the reverse proxy.", status: "available", access: ["owner", "admin"] },
  { id: "ollama", name: "Ollama", category: "AI and machine learning", description: "Run small local LLMs (4 GB VRAM limits size).", status: "available", access: ["owner", "admin"] },
  { id: "grafana", name: "Grafana", category: "Monitoring", description: "Dashboards for metrics and logs.", status: "available", access: ["owner", "admin"] },
];

export const users: User[] = [
  { id: "u1", name: "Parth B", email: "parth@kdg.local", role: "owner", status: "active", lastLogin: "Just now", mfa: true, quotaGiB: 60, usedGiB: 31.2, services: ["*"] },
  { id: "u2", name: "Toru Kazama", email: "kazama@kdg.local", role: "admin", status: "active", lastLogin: "2 h ago", mfa: true, quotaGiB: 20, usedGiB: 8.4, services: ["nextcloud", "jupyter", "forgejo"] },
  { id: "u3", name: "Shinnosuke Nohara", email: "shinchan@kdg.local", role: "member", status: "active", lastLogin: "12 min ago", mfa: false, quotaGiB: 15, usedGiB: 12.9, services: ["minecraft", "nextcloud"] },
  { id: "u4", name: "Nene Sakurada", email: "nene@kdg.local", role: "member", status: "invited", lastLogin: "Never", mfa: false, quotaGiB: 10, usedGiB: 0, services: ["nextcloud"] },
  { id: "u5", name: "Masao Sato", email: "masao@kdg.local", role: "member", status: "disabled", lastLogin: "41 d ago", mfa: false, quotaGiB: 10, usedGiB: 2.1, services: [] },
];

const acts: [string, string, string, string, AuditEvent["result"]][] = [
  ["parth", "auth.login", "session", "login", "success"],
  ["shinchan", "container.restart", "minecraft-paper", "restart", "success"],
  ["system", "health.check", "uptime-kuma", "restart", "error"],
  ["shinchan", "process.kill", "pid 1137", "kill", "denied"],
  ["kazama", "s3.object.put", "app-uploads/avatars/k.png", "write", "success"],
  ["parth", "user.invite", "nene@kdg.local", "create", "success"],
  ["kazama", "terminal.open", "session t-02 (restricted)", "open", "success"],
  ["masao", "auth.login", "session", "login", "denied"],
  ["parth", "stack.deploy", "nextcloud", "deploy", "success"],
  ["system", "backup.run", "kdg-backups", "write", "success"],
  ["shinchan", "drive.share", "minecraft-timelapse.mp4", "share", "success"],
  ["kazama", "gpu.job.start", "jupyterlab", "start", "success"],
];
export const audit: AuditEvent[] = Array.from({ length: 36 }, (_, i) => {
  const [actor, event, resource, action, result] = acts[i % acts.length]!;
  const mins = i * 17 + 2;
  return {
    id: `ev-${(9000 - i).toString(16)}`,
    at: `2026-11-06 ${String(22 - Math.floor(mins / 60) % 23).padStart(2, "0")}:${String(59 - (mins % 60)).padStart(2, "0")}`,
    actor, event, resource, action, result,
    device: ["Firefox · Ubuntu", "Chrome · Android", "Safari · iOS", "kdg-agent"][i % 4]!,
    ip: actor === "system" ? "127.0.0.1" : `100.64.0.${10 + (i % 5)}`,
  };
});

export const activity = audit.slice(0, 7);
