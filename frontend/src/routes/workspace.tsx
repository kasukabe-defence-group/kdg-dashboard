import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen, Check, Cloud, Copy, Cpu, ExternalLink, FolderGit2, HardDrive, KeyRound, Loader2, Play,
  Plus, RefreshCw, RotateCw, Square, Trash2, Upload, Download, Eye, EyeOff, AlertTriangle, GitBranch,
  ScrollText, Settings2, ArrowDownToLine, ArrowUpFromLine, Unplug, FlaskConical,
} from "lucide-react";
import { api } from "@/services/api/client";
import { workspacesQuery } from "@/services/api/queries";
import { PageHeader, Panel, Pill, Stat, Meter, Empty } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Workspace } from "@/types";
import { toast } from "sonner";

export const Route = createFileRoute("/workspace")({
  head: () => ({
    meta: [
      { title: "Workspaces · KDG Cloud" },
      { name: "description", content: "Per-user JupyterLab workspaces with Git repositories and Google Drive sync." },
    ],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(workspacesQuery);
    } catch {
      // SSR without a session; the client will retry.
    }
  },
  component: WorkspacePage,
});

const GIB = 1024 ** 3;

function gib(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KiB`;
  if (bytes < GIB) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

function mib(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value >= 1024) return `${(value / 1024).toFixed(2)} GiB`;
  return `${Math.round(value)} MiB`;
}

function tone(state: string): "success" | "warning" | "muted" | "destructive" {
  if (state === "running") return "success";
  if (state === "stopped" || state === "not_created") return "muted";
  return "destructive";
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Clipboard is not available in this browser");
  }
}

function WorkspacePage() {
  const queryClient = useQueryClient();
  const { data = [], isPending, isError, error } = useQuery(workspacesQuery);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const workspaces = data;
  const active = workspaces.find((w) => w.username === selected) ?? null;
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workspaces"] });

  const running = workspaces.filter((w) => w.running).length;
  const allocated = workspaces.filter((w) => w.running).reduce((n, w) => n + w.memoryMiB, 0);
  const vram = workspaces.reduce((n, w) => n + (w.usage.gpuMiB ?? 0), 0);
  const disk = workspaces.reduce((n, w) => n + w.diskBytes, 0);
  const repos = workspaces.reduce((n, w) => n + w.git.repos.length, 0);

  const act = useMutation({
    mutationFn: async ({ user, action }: { user: string; action: "start" | "stop" | "restart" }) => {
      setBusy(user);
      const ws = workspaces.find((w) => w.username === user);
      if (action === "start") return api.wsStart(user, { memoryMiB: ws?.memoryMiB ?? 2048, cpus: ws?.cpus ?? 2, gpu: ws?.gpu ?? false });
      if (action === "stop") return api.wsStop(user);
      return api.wsRestart(user);
    },
    onSuccess: (_r, v) => {
      toast.success(`${v.action === "start" ? "Starting" : v.action === "stop" ? "Stopping" : "Restarting"} ${v.user}'s workspace…`);
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Action failed"),
    onSettled: () => setBusy(null),
  });

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Workspaces"
        badge={<Pill tone="primary" dot>{running} of {workspaces.length} running</Pill>}
        description="Every dashboard user gets a private JupyterLab container with persistent notebooks, Git repositories and an optional Google Drive mirror. Containers are labelled with their owner, so CPU, RAM and VRAM show up under that user."
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Workspaces" value={workspaces.length} sub={`${running} running`} icon={<BookOpen className="size-4" />} />
        <Stat label="Assigned RAM" value={`${(allocated / 1024).toFixed(1)} GiB`} sub="running containers" icon={<Cpu className="size-4" />} />
        <Stat label="VRAM in use" value={vram ? mib(vram) : "—"} sub="attributed to owners" icon={<HardDrive className="size-4" />} />
        <Stat label="Git repositories" value={repos} sub={`${gib(disk)} of workspace data`} icon={<FolderGit2 className="size-4" />} />
      </div>

      {isError ? (
        <Empty title="Could not load workspaces" hint={error instanceof Error ? error.message : "Request failed"} icon={<AlertTriangle className="size-6" />} />
      ) : isPending ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-64" />)}</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {workspaces.map((ws) => (
            <WorkspaceCard
              key={ws.username}
              ws={ws}
              busy={busy === ws.username}
              onOpen={() => setSelected(ws.username)}
              onAction={(action) => act.mutate({ user: ws.username, action })}
            />
          ))}
        </div>
      )}

      <Panel className="mt-4" title="How workspaces work">
        <ul className="grid gap-2 text-[13px] text-muted-foreground md:grid-cols-3">
          <li><b className="text-foreground">Own files</b> — notebooks, data and repositories live under <span className="font-mono">workspaces/&lt;user&gt;/</span> and survive restarts.</li>
          <li><b className="text-foreground">Git &amp; Drive</b> — clone with a personal access token and mirror Google Drive with rclone; tokens stay on the node, never in the browser response.</li>
          <li><b className="text-foreground">Attribution</b> — the container carries <span className="font-mono">kdg.owner</span>, so usage on User resources is attributed to the real person.</li>
        </ul>
      </Panel>

      {active && (
        <WorkspaceDialog
          ws={active}
          onClose={() => setSelected(null)}
          onAction={(action) => act.mutate({ user: active.username, action })}
          busy={busy === active.username}
          onChanged={() => { void invalidate(); }}
        />
      )}
    </div>
  );
}

function WorkspaceCard({ ws, busy, onOpen, onAction }: {
  ws: Workspace;
  busy: boolean;
  onOpen: () => void;
  onAction: (a: "start" | "stop" | "restart") => void;
}) {
  const memShare = ws.usage.memMiB != null && ws.memoryMiB ? (ws.usage.memMiB / ws.memoryMiB) * 100 : 0;
  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-2 border-b p-4">
        <button className="min-w-0 text-left" onClick={onOpen}>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-[13px] font-semibold uppercase text-primary">
              {ws.displayName.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{ws.displayName}</div>
              <div className="text-[11px] text-muted-foreground">@{ws.username} · {ws.role}</div>
            </div>
          </div>
        </button>
        <Pill tone={tone(ws.state)} dot>{ws.running ? "running" : ws.state.replace("_", " ")}</Pill>
      </div>

      <div className="flex-1 space-y-2.5 p-4">
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">JupyterLab</span>
          <span className="font-mono">{ws.running ? `:${ws.port}` : "stopped"}</span>
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>CPU</span><span className="tabular">{ws.usage.cpuPercent == null ? "—" : `${ws.usage.cpuPercent.toFixed(1)}%`}</span>
          </div>
          <Meter value={Math.min(100, ws.usage.cpuPercent ?? 0)} />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>RAM</span><span className="tabular">{mib(ws.usage.memMiB)} / {mib(ws.memoryMiB)}</span>
          </div>
          <Meter value={Math.min(100, memShare)} />
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">VRAM</span>
          <span className="tabular">{ws.gpu ? mib(ws.usage.gpuMiB ?? 0) : "GPU off"}</span>
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">Git</span>
          <span>{ws.git.repos.length} repo{ws.git.repos.length === 1 ? "" : "s"} · {ws.git.credentials.length} host{ws.git.credentials.length === 1 ? "" : "s"}</span>
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">Drive</span>
          <span>{ws.drive.connected ? (ws.drive.remotePath || "connected") : "not connected"}</span>
        </div>
        <div className="flex items-center justify-between text-[12px]">
          <span className="text-muted-foreground">Data</span>
          <span className="tabular">{gib(ws.diskBytes)}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t p-3">
        {ws.running ? (
          <>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAction("restart")}><RotateCw className="size-3.5" /> Restart</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAction("stop")}><Square className="size-3.5" /> Stop</Button>
          </>
        ) : (
          <Button size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAction("start")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Start
          </Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" onClick={onOpen}>Manage</Button>
      </div>
    </div>
  );
}

function WorkspaceDialog({ ws, onClose, onAction, busy, onChanged }: {
  ws: Workspace;
  onClose: () => void;
  onAction: (a: "start" | "stop" | "restart") => void;
  busy: boolean;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"lab" | "git" | "drive" | "settings">("lab");
  const [host, setHost] = useState("");
  useEffect(() => { setHost(window.location.hostname); }, []);

  const token = ws.token ?? "";
  const url = host && ws.port ? `http://${host}:${ws.port}/lab?token=${encodeURIComponent(token)}` : "";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {ws.displayName}
            <Pill tone={tone(ws.state)} dot>{ws.running ? "running" : ws.state.replace("_", " ")}</Pill>
          </DialogTitle>
          <DialogDescription>
            @{ws.username} · {ws.memoryMiB} MiB RAM · {ws.cpus} vCPU{ws.gpu ? " · GPU" : ""} · data at workspaces/{ws.username.toLowerCase()}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1.5 border-b pb-2">
          <TabButton active={tab === "lab"} onClick={() => setTab("lab")} icon={<BookOpen className="size-3.5" />}>JupyterLab</TabButton>
          <TabButton active={tab === "git"} onClick={() => setTab("git")} icon={<FolderGit2 className="size-3.5" />}>Git</TabButton>
          <TabButton active={tab === "drive"} onClick={() => setTab("drive")} icon={<Cloud className="size-3.5" />}>Google Drive</TabButton>
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings2 className="size-3.5" />}>Settings</TabButton>
        </div>

        {tab === "lab" && <LabTab ws={ws} url={url} token={token} busy={busy} onAction={onAction} onChanged={onChanged} />}
        {tab === "git" && <GitTab ws={ws} onChanged={onChanged} />}
        {tab === "drive" && <DriveTab ws={ws} onChanged={onChanged} />}
        {tab === "settings" && <SettingsTab ws={ws} onChanged={onChanged} />}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted"}`}
    >
      {icon}{children}
    </button>
  );
}

function LabTab({ ws, url, token, busy, onAction, onChanged }: {
  ws: Workspace; url: string; token: string; busy: boolean;
  onAction: (a: "start" | "stop" | "restart") => void; onChanged: () => void;
}) {
  const [showToken, setShowToken] = useState(false);
  const logs = useQuery({
    queryKey: ["ws-logs", ws.username],
    queryFn: () => api.wsLogs(ws.username, 200),
    refetchInterval: ws.running ? 5000 : false,
  });
  const rotate = useMutation({
    mutationFn: () => api.wsRotateToken(ws.username),
    onSuccess: () => { toast.success("New Jupyter token issued"); onChanged(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not rotate token"),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/20 p-3">
        <div className="label-caps mb-1">JupyterLab URL</div>
        {ws.running && url ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 text-[12px]">{url.replace(/token=[^&]+/, "token=•••")}</code>
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs" onClick={() => void copyText(url, "Workspace URL")}><Copy className="size-3.5" /> Copy link</Button>
            <a href={url} target="_blank" rel="noreferrer"><Button size="sm" className="h-8 px-2 text-xs"><ExternalLink className="size-3.5" /> Open</Button></a>
            <Link to="/lab" search={{ user: ws.username }}><Button size="sm" variant="secondary" className="h-8 px-2 text-xs"><FlaskConical className="size-3.5" /> Embedded Lab</Button></Link>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">Start the workspace to get a signed JupyterLab link.</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <KeyRound className="size-3.5" />
          <span className="font-mono">{showToken ? token : token ? "•".repeat(Math.min(32, token.length)) : "no token yet"}</span>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => setShowToken((v) => !v)}>
            {showToken ? <EyeOff className="size-3" /> : <Eye className="size-3" />} {showToken ? "Hide" : "Show"}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={!token} onClick={() => void copyText(token, "Token")}><Copy className="size-3" /> Copy</Button>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
            {rotate.isPending ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />} Rotate
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="CPU" value={ws.usage.cpuPercent == null ? "—" : `${ws.usage.cpuPercent.toFixed(1)}%`} meter={Math.min(100, ws.usage.cpuPercent ?? 0)} />
        <MetricCard label="RAM" value={`${mib(ws.usage.memMiB)} / ${mib(ws.memoryMiB)}`} meter={ws.usage.memMiB && ws.memoryMiB ? Math.min(100, (ws.usage.memMiB / ws.memoryMiB) * 100) : 0} />
        <MetricCard label="VRAM" value={ws.gpu ? mib(ws.usage.gpuMiB ?? 0) : "GPU off"} meter={ws.gpu ? Math.min(100, ((ws.usage.gpuMiB ?? 0) / 4096) * 100) : 0} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {ws.running ? (
          <>
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={busy} onClick={() => onAction("restart")}><RotateCw className="size-3.5" /> Restart</Button>
            <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={busy} onClick={() => onAction("stop")}><Square className="size-3.5" /> Stop</Button>
          </>
        ) : (
          <Button size="sm" className="h-8 px-2 text-xs" disabled={busy} onClick={() => onAction("start")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Start workspace
          </Button>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="label-caps flex items-center gap-1"><ScrollText className="size-3" /> Container logs</span>
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => void logs.refetch()}><RefreshCw className="size-3" /> Refresh</Button>
        </div>
        <pre className="max-h-56 overflow-auto rounded-md border bg-[#0b0f14] p-2.5 font-mono text-[11px] leading-relaxed text-slate-300">
          {logs.isPending ? "Loading logs…" : logs.data?.logs?.trim() || "No log output yet."}
        </pre>
      </div>
    </div>
  );
}

function MetricCard({ label, value, meter }: { label: string; value: string; meter: number }) {
  return (
    <div className="rounded-md border p-2.5">
      <div className="label-caps">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold tabular">{value}</div>
      <Meter value={meter} className="mt-1.5" />
    </div>
  );
}

function GitTab({ ws, onChanged }: { ws: Workspace; onChanged: () => void }) {
  const [host, setHost] = useState("");
  const [user, setUser] = useState("git");
  const [token, setToken] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [gitName, setGitName] = useState(ws.displayName);
  const [gitEmail, setGitEmail] = useState("");

  const mutate = () => onChanged();
  const addCred = useMutation({
    mutationFn: () => api.wsAddGitCredential(ws.username, { host, username: user, token }),
    onSuccess: () => { toast.success("Git credential saved"); setToken(""); mutate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save credential"),
  });
  const delCred = useMutation({
    mutationFn: (h: string) => api.wsDeleteGitCredential(ws.username, h),
    onSuccess: () => { toast.success("Credential removed"); mutate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove credential"),
  });
  const clone = useMutation({
    mutationFn: () => api.wsCloneRepo(ws.username, { url, name: name || undefined, branch: branch || undefined, userName: gitName, userEmail: gitEmail }),
    onSuccess: (r) => { toast.success(`Cloned ${r.repo.name}`); setUrl(""); setName(""); setBranch(""); mutate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Clone failed"),
  });
  const repoAction = useMutation({
    mutationFn: ({ repo, action }: { repo: string; action: "pull" | "push" | "fetch" }) => api.wsRepoAction(ws.username, repo, action),
    onSuccess: (r, v) => { toast.success(`git ${v.action} ok`); if (r.output) toast.message(r.output.split("\n")[0] ?? ""); mutate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Git action failed"),
  });
  const removeRepo = useMutation({
    mutationFn: (repo: string) => api.wsDeleteRepo(ws.username, repo),
    onSuccess: () => { toast.success("Repository removed"); mutate(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not remove repository"),
  });

  return (
    <div className="space-y-4">
      <div className="rounded-md border p-3">
        <div className="label-caps mb-2 flex items-center gap-1"><KeyRound className="size-3" /> Git credentials</div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {ws.git.credentials.length === 0 ? (
            <span className="text-[12px] text-muted-foreground">No hosts yet. Add a personal access token for private repositories.</span>
          ) : ws.git.credentials.map((h) => (
            <span key={h} className="inline-flex items-center gap-1 rounded border bg-muted/30 px-1.5 py-0.5 text-[11px]">
              <Check className="size-3 text-success" /> {h}
              <button className="text-muted-foreground hover:text-destructive" onClick={() => delCred.mutate(h)} disabled={delCred.isPending}>
                <Trash2 className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="github.com" className="h-8 text-xs" />
          <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="username" className="h-8 text-xs" />
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="personal access token" className="h-8 text-xs" />
          <Button size="sm" className="h-8 px-2 text-xs" disabled={addCred.isPending || host.length < 3 || token.length < 4} onClick={() => addCred.mutate()}>
            {addCred.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Save
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">Stored at 0600 on the node and mirrored into git's credential store, so <span className="font-mono">git push</span> works from the JupyterLab terminal too.</p>
      </div>

      <div className="rounded-md border p-3">
        <div className="label-caps mb-2 flex items-center gap-1"><FolderGit2 className="size-3" /> Clone a repository</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/user/repo.git" className="h-8 text-xs sm:col-span-2" />
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="folder name (optional)" className="h-8 text-xs" />
          <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch (optional)" className="h-8 text-xs" />
          <Input value={gitName} onChange={(e) => setGitName(e.target.value)} placeholder="commit author name" className="h-8 text-xs" />
          <Input value={gitEmail} onChange={(e) => setGitEmail(e.target.value)} placeholder="commit author email" className="h-8 text-xs" />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" className="h-8 px-2 text-xs" disabled={clone.isPending || url.length < 8} onClick={() => clone.mutate()}>
            {clone.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranch className="size-3.5" />} Clone
          </Button>
          <span className="text-[11px] text-muted-foreground">Clones into repos/&lt;name&gt; inside the workspace.</span>
        </div>
      </div>

      <div>
        <div className="label-caps mb-2">Repositories</div>
        {ws.git.repos.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">No repositories yet.</p>
        ) : (
          <div className="space-y-2">
            {ws.git.repos.map((r) => (
              <div key={r.name} className="rounded-md border p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{r.name}</span>
                  <Pill tone="muted"><GitBranch className="size-3" /> {r.branch || "detached"}</Pill>
                  {r.dirty && <Pill tone="warning">uncommitted</Pill>}
                  {r.ahead > 0 && <Pill tone="success">{r.ahead} ahead</Pill>}
                  {r.behind > 0 && <Pill tone="warning">{r.behind} behind</Pill>}
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={repoAction.isPending} onClick={() => repoAction.mutate({ repo: r.name, action: "pull" })}><ArrowDownToLine className="size-3" /> Pull</Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={repoAction.isPending} onClick={() => repoAction.mutate({ repo: r.name, action: "push" })}><ArrowUpFromLine className="size-3" /> Push</Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-destructive" disabled={removeRepo.isPending} onClick={() => { if (window.confirm(`Delete ${r.name}? Unpushed work is lost.`)) removeRepo.mutate(r.name); }}><Trash2 className="size-3" /></Button>
                  </span>
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">{r.lastCommit || "no commits"}{r.commitAge ? ` · ${r.commitAge}` : ""}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DriveTab({ ws, onChanged }: { ws: Workspace; onChanged: () => void }) {
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [remotePath, setRemotePath] = useState(`KDG/${ws.username}`);

  const connect = useMutation({
    mutationFn: () => api.wsDriveConnect(ws.username, { token, clientId: clientId || undefined, clientSecret: clientSecret || undefined, remotePath: remotePath || undefined }),
    onSuccess: () => { toast.success("Google Drive connected"); setToken(""); onChanged(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not connect Google Drive"),
  });
  const sync = useMutation({
    mutationFn: (direction: "pull" | "push") => api.wsDriveSync(ws.username, direction),
    onSuccess: (_r, direction) => { toast.success(direction === "pull" ? "Imported from Google Drive" : "Uploaded to Google Drive"); onChanged(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Sync failed"),
  });
  const disconnect = useMutation({
    mutationFn: () => api.wsDriveDisconnect(ws.username),
    onSuccess: () => { toast.success("Google Drive disconnected"); onChanged(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not disconnect"),
  });

  if (!ws.drive.connected) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/20 p-3 text-[12px] text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Connect a Google Drive account</p>
          <ol className="list-decimal space-y-1 pl-4">
            <li>On your own computer run <span className="font-mono">rclone authorize "drive"</span> and sign in.</li>
            <li>Paste the JSON token rclone prints below. It is written to <span className="font-mono">workspaces/{ws.username.toLowerCase()}/.kdg/rclone.conf</span> (mode 600) and never returned to the browser.</li>
            <li>Optionally add your own OAuth client ID — rclone's shared Drive client is being retired during 2026.</li>
          </ol>
        </div>
        <div>
          <label className="label-caps">rclone token JSON</label>
          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={5}
            placeholder='{"access_token":"ya29…","refresh_token":"1//…","expiry":"2026-11-12T…Z","token_type":"Bearer"}'
            className="mt-1 w-full rounded-md border bg-background p-2 font-mono text-[11px]"
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div><label className="label-caps">Client ID</label><Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="mt-1 h-8 text-xs" placeholder="optional" /></div>
          <div><label className="label-caps">Client secret</label><Input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="mt-1 h-8 text-xs" placeholder="optional" /></div>
          <div><label className="label-caps">Remote folder</label><Input value={remotePath} onChange={(e) => setRemotePath(e.target.value)} className="mt-1 h-8 text-xs" /></div>
        </div>
        <Button size="sm" disabled={connect.isPending || token.trim().length < 10} onClick={() => connect.mutate()}>
          {connect.isPending ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />} Connect and verify
        </Button>
      </div>
    );
  }

  const quota = ws.drive.quota ?? {};
  const used = quota.used ?? 0;
  const total = quota.total ?? 0;
  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="success" dot>connected</Pill>
          <span className="text-[13px] font-medium">{ws.drive.remotePath}</span>
          <span className="ml-auto text-[11px] text-muted-foreground">local mirror {gib(ws.drive.localBytes ?? 0)}</span>
        </div>
        <div className="mt-2 text-[12px] text-muted-foreground">
          Quota: {used ? `${gib(used)} of ${gib(total)}` : "not reported"}
        </div>
        {total > 0 && <Meter value={Math.min(100, (used / total) * 100)} className="mt-1" />}
        {ws.drive.lastResult && <p className="mt-2 truncate text-[11px] text-muted-foreground" title={ws.drive.lastResult}>{ws.drive.lastResult}</p>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={sync.isPending} onClick={() => sync.mutate("pull")}>
          {sync.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Import from Drive
        </Button>
        <Button size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={sync.isPending} onClick={() => sync.mutate("push")}>
          {sync.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />} Upload to Drive
        </Button>
        <Button size="sm" variant="ghost" className="h-8 px-2 text-xs text-destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
          <Unplug className="size-3.5" /> Disconnect
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Sync uses <span className="font-mono">rclone copy</span>: files are added or updated but nothing is deleted, and the mirror lives in <span className="font-mono">drive/</span> inside the workspace.</p>
    </div>
  );
}

function SettingsTab({ ws, onChanged }: { ws: Workspace; onChanged: () => void }) {
  const [memory, setMemory] = useState(ws.memoryMiB);
  const [cpus, setCpus] = useState(ws.cpus);
  const [gpu, setGpu] = useState(ws.gpu);

  const save = useMutation({
    mutationFn: () => api.wsStart(ws.username, { memoryMiB: memory, cpus, gpu }),
    onSuccess: () => { toast.success("Workspace recreated with new settings"); onChanged(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not apply settings"),
  });
  const reset = useMutation({
    mutationFn: () => api.wsStop(ws.username),
    onSuccess: () => { toast.success("Workspace stopped"); onChanged(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not stop workspace"),
  });

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label-caps">Memory</label>
          <select value={memory} onChange={(e) => setMemory(Number(e.target.value))} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm">
            {[1024, 2048, 3072, 4096, 6144, 8192].map((m) => <option key={m} value={m}>{m >= 1024 ? `${m / 1024} GiB` : `${m} MiB`}</option>)}
          </select>
        </div>
        <div>
          <label className="label-caps">vCPUs</label>
          <select value={cpus} onChange={(e) => setCpus(Number(e.target.value))} className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm">
            {[1, 2, 3, 4, 6, 8].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="label-caps">GPU access</label>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px]">
            <input type="checkbox" checked={gpu} onChange={(e) => setGpu(e.target.checked)} className="size-4 accent-[var(--primary)]" />
            Pass through the NVIDIA GPU
          </label>
        </div>
      </div>
      <div className="rounded-md border bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
        Image: <span className="font-mono">{ws.image}</span>. Applying settings recreates the container — notebooks, repos and drive files stay on disk.
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />} Apply and restart
        </Button>
        <Button size="sm" variant="outline" disabled={reset.isPending || !ws.running} onClick={() => reset.mutate()}>
          <Square className="size-4" /> Stop
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Workspace folder: <span className="font-mono">workspaces/{ws.username.toLowerCase()}/{`{notebooks,repos,drive}`}</span>
      </p>
    </div>
  );
}
