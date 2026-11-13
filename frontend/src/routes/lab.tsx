import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check, ChevronDown, Cpu, ExternalLink, FlaskConical, FolderGit2, Loader2, MoreVertical,
  NotebookPen, Play, RotateCw, Square, Upload, AlertTriangle, Zap, HardDrive, MemoryStick, Settings2,
} from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { api } from "@/services/api/client";
import { workspacesQuery } from "@/services/api/queries";
import { Pill } from "@/components/kdg/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import type { Workspace } from "@/types";
import { toast } from "sonner";

type LabSearch = { user?: string };

export const Route = createFileRoute("/lab")({
  validateSearch: (search: Record<string, unknown>): LabSearch => {
    const user = search["user"];
    return typeof user === "string" && user ? { user } : {};
  },
  component: LabPage,
});

const slug = (username: string) =>
  username.toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "user";

const labBase = (ws: Workspace) => ws.labPath ?? `/api/v1/workspaces/jupyter/${slug(ws.username)}/`;

const imageShort = (image: string) => {
  const name = image.split("/").pop() ?? image;
  return name.length > 28 ? `${name.slice(0, 25)}…` : name;
};

const mib = (value: number | null | undefined) =>
  value == null ? "—" : value >= 1024 ? `${(value / 1024).toFixed(1)}G` : `${Math.round(value)}M`;

const giB = (bytes: number | null | undefined) =>
  bytes == null ? "—" : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)}G` : `${(bytes / 1024 ** 2).toFixed(0)}M`;

function Chip({ icon, children, tone }: { icon?: ReactNode; children: ReactNode; tone?: "gpu" | "muted" }) {
  const toneCls =
    tone === "gpu"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : tone === "muted"
        ? "border-border/60 bg-background/40 text-muted-foreground"
        : "border-border bg-background/50 text-foreground/80";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${toneCls}`}>
      {icon}
      <span className="font-mono tabular-nums">{children}</span>
    </span>
  );
}

function LabPage() {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const search = Route.useSearch();
  const { data: workspaces, isLoading } = useQuery(workspacesQuery);
  const [selected, setSelected] = useState<string | null>(search.user ?? null);
  const [iframePath, setIframePath] = useState("lab");
  const [iframeReady, setIframeReady] = useState(false);
  const [nbOpen, setNbOpen] = useState(false);
  const [nbName, setNbName] = useState("notebook.ipynb");
  const [importOpen, setImportOpen] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [repoBranch, setRepoBranch] = useState("");
  const [repoName, setRepoName] = useState("");
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [gpuConfirm, setGpuConfirm] = useState<boolean | null>(null);
  const [memGiB, setMemGiB] = useState(2);
  const [vcpus, setVcpus] = useState(2);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => workspaces ?? [], [workspaces]);
  const ownName = user?.username?.toLowerCase();
  const mine = useMemo(() => list.find((w) => w.username.toLowerCase() === ownName), [list, ownName]);
  const current = useMemo(() => {
    if (selected) {
      const hit = list.find((w) => w.username === selected);
      if (hit) return hit;
    }
    return mine ?? list[0] ?? null;
  }, [list, selected, mine]);

  useEffect(() => {
    if (!current) return;
    if (current.memoryMiB) setMemGiB(Math.max(1, Math.round(current.memoryMiB / 1024)));
    if (current.cpus) setVcpus(current.cpus);
    setIframeReady(false);
    setIframePath("lab");
  }, [current?.username]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workspaces"] });

  const start = useMutation({
    mutationFn: (gpu: boolean) =>
      api.wsStart(current?.username ?? "", { memoryMiB: Math.round(memGiB * 1024), cpus: vcpus, gpu }),
    onSuccess: (ws) => {
      toast.success(ws.gpu ? "Workspace starting — GPU enabled" : "Workspace starting…");
      setIframeReady(false);
      setIframePath("lab");
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message || "Could not start the workspace"),
  });

  const restart = useMutation({
    mutationFn: () => api.wsRestart(current?.username ?? ""),
    onSuccess: (ws) => {
      toast.success("Workspace restarting…");
      setIframeReady(false);
      setIframePath("lab");
      queryClient.setQueryData(["workspaces"], (prev: Workspace[] | undefined) =>
        prev?.map((w) => (w.username === ws.username ? ws : w)),
      );
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message || "Restart failed"),
  });

  const stop = useMutation({
    mutationFn: () => api.wsStop(current?.username ?? ""),
    onSuccess: () => {
      toast.success("Workspace stopped");
      setIframeReady(false);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message || "Stop failed"),
  });

  const createNotebook = useMutation({
    mutationFn: () =>
      api.wsCreateNotebook(current?.username ?? "", { name: nbName.trim() || "notebook.ipynb", path: "notebooks" }),
    onSuccess: (res) => {
      toast.success(`Created ${res.name}`);
      setNbOpen(false);
      setIframeReady(false);
      setIframePath(`lab/tree/${res.notebook}`);
    },
    onError: (error: Error) => toast.error(error.message || "Could not create the notebook"),
  });

  const clone = useMutation({
    mutationFn: () =>
      api.wsCloneRepo(current?.username ?? "", {
        url: repoUrl.trim(),
        branch: repoBranch.trim() || undefined,
        name: repoName.trim() || undefined,
      }),
    onSuccess: (res) => {
      toast.success(`Cloned ${res.repo.name} into repos/`);
      setImportOpen(false);
      setRepoUrl("");
      setRepoBranch("");
      setRepoName("");
      setIframeReady(false);
      setIframePath(`lab/tree/repos/${res.repo.name}`);
    },
    onError: (error: Error) => toast.error(error.message || "Clone failed"),
  });

  const upload = useMutation({
    mutationFn: (files: File[]) => api.wsUpload(current?.username ?? "", files),
    onSuccess: (res) => {
      toast.success(`Uploaded ${res.uploaded.length} file${res.uploaded.length === 1 ? "" : "s"}`);
      setIframeReady(false);
      setIframePath("lab");
    },
    onError: (error: Error) => toast.error(error.message || "Upload failed"),
  });

  const iframeSrc = current ? `${labBase(current)}${iframePath}` : "";
  const running = current?.running ?? false;
  const busy = start.isPending || restart.isPending || stop.isPending;

  useEffect(() => {
    if (!running) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Active JupyterLab session — closing this page may leave unsaved notebook changes.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [running]);

  if (isLoading && list.length === 0) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Skeleton className="h-8 w-56" />
      </div>
    );
  }

  const onGpuButton = () => {
    if (!current) return;
    const target = !current.gpu;
    if (running) setGpuConfirm(target);
    else start.mutate(target);
  };

  return (
    <div className="-mx-3 -mt-4 flex h-[calc(100dvh-3rem)] flex-col overflow-hidden sm:-mx-5">
      <div className="glass-toolbar flex min-h-[56px] flex-wrap items-center gap-x-2 gap-y-2 border-b px-3 py-2">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-lg border border-border bg-muted/40">
            <FlaskConical className="size-4 text-foreground" />
          </span>
          <div className="leading-tight">
            <span className="block text-[13px] font-semibold tracking-tight">Notebooks</span>
            <span className="hidden text-[10px] uppercase tracking-wider text-muted-foreground sm:block">JupyterLab · GPU workspace</span>
          </div>
        </div>

        {list.length > 1 && (
          <select
            value={current?.username ?? ""}
            onChange={(e) => setSelected(e.target.value)}
            className="h-9 max-w-[170px] rounded-xl border bg-background/60 px-2 text-[12px] text-muted-foreground"
            aria-label="Workspace"
          >
            {list.map((w) => (
              <option key={w.username} value={w.username}>
                {w.displayName}{w.username === mine?.username ? " (you)" : ""}
              </option>
            ))}
          </select>
        )}

        <Pill tone={running ? "success" : "muted"} dot>
          {running ? "runtime running" : (current?.state || "unknown").replace(/_/g, " ")}
        </Pill>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Chip icon={<MemoryStick className="size-3" />}>{current ? `${(current.memoryMiB / 1024).toFixed(1)} GiB` : "—"}</Chip>
          <Chip icon={<Cpu className="size-3" />}>{current ? `${current.cpus} vCPU` : "—"}</Chip>
          {current && (
            <Chip icon={<Zap className="size-3" />} tone={current.gpu ? "gpu" : "muted"}>
              {current.gpu ? (current.usage.gpuMiB != null ? `GPU ${mib(current.usage.gpuMiB)}` : "GTX 1050") : "no GPU"}
            </Chip>
          )}

          <span className="mx-1 hidden h-5 w-px bg-border sm:block" />

          <Button size="sm" variant="outline" className="h-9 gap-1.5 rounded-xl" onClick={() => setNbOpen(true)} disabled={!running}>
            <NotebookPen className="size-4" /><span className="hidden sm:inline">New notebook</span>
          </Button>
          <Button size="sm" variant="ghost" className="h-9 gap-1.5 rounded-xl" onClick={() => setImportOpen(true)} disabled={!running}>
            <FolderGit2 className="size-4" /><span className="hidden sm:inline">Import repo</span>
          </Button>
          <Button size="sm" variant="ghost" className="h-9 gap-1.5 rounded-xl" onClick={() => fileRef.current?.click()} disabled={!running || upload.isPending}>
            {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            <span className="hidden sm:inline">Upload</span>
          </Button>

          <Button size="sm" variant={current?.gpu ? "default" : "outline"} className="h-9 gap-1.5 rounded-xl" onClick={onGpuButton} disabled={!current || busy} title={current?.gpu ? "Disable GPU" : "Enable GPU"}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
            <span className="hidden sm:inline">{current?.gpu ? "GPU on" : "GPU off"}</span>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="size-9 rounded-xl px-0" aria-label="More actions">
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Workspace</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setResourcesOpen(true)}>
                <Settings2 className="mr-2 size-4" />Runtime resources (RAM / vCPU)…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => restart.mutate()} disabled={restart.isPending || !current}>
                <RotateCw className="mr-2 size-4" />Restart runtime
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => stop.mutate()} disabled={stop.isPending || !running}>
                <Square className="mr-2 size-4" />Stop runtime
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => window.open(iframeSrc, "_blank", "noopener,noreferrer")} disabled={!running}>
                <ExternalLink className="mr-2 size-4" />Open full screen
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/workspace"><HardDrive className="mr-2 size-4" />Workspace settings (Drive · Git)</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) upload.mutate(files);
          event.target.value = "";
        }}
      />

      {current && running && current.labReady === false && (
        <button
          onClick={() => restart.mutate()}
          className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-left text-[11px] text-warning transition hover:bg-warning/15"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>This workspace predates the embedded Lab. Restart it once to enable the notebook environment.</span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-medium">Restart <ChevronDown className="size-3 rotate-180" /></span>
        </button>
      )}
      {current && running && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
          Active JupyterLab session. If you close or refresh this page, unsaved notebook or kernel work may be lost.
        </div>
      )}

      {!current ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium">No workspace found</p>
          <p className="text-xs text-muted-foreground">Your KDG workspace is not provisioned yet.</p>
        </div>
      ) : !running ? (
        <NotebookHome
          current={current}
          memGiB={memGiB}
          vcpus={vcpus}
          gpuDefault={current.gpu}
          onMem={setMemGiB}
          onVcpus={setVcpus}
          onStart={(gpu) => start.mutate(gpu)}
          pending={start.isPending}
          onNewNotebook={() => setNbOpen(true)}
          onImportRepo={() => setImportOpen(true)}
          onUpload={() => fileRef.current?.click()}
        />
      ) : (
        <div className="relative min-h-0 flex-1 bg-[#0b0f14]">
          <iframe
            key={current.username}
            id="kdg-jupyter"
            title="JupyterLab"
            src={iframeSrc}
            className="absolute inset-0 h-full w-full border-0"
            allow="clipboard-read; clipboard-write; fullscreen; storage-access"
            referrerPolicy="same-origin"
            onLoad={() => setIframeReady(true)}
          />
          {!iframeReady && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#050608] text-muted-foreground">
              <FlaskConical className="size-10 animate-pulse text-foreground" />
              <p className="text-sm font-medium text-foreground">Starting notebook environment…</p>
              <p className="font-mono text-[11px]">{current.username} · {imageShort(current.image)}</p>
            </div>
          )}
        </div>
      )}

      {current && (
        <div className="glass-toolbar hidden h-8 shrink-0 items-center gap-3 border-t px-3 font-mono text-[10px] text-muted-foreground md:flex">
          <span>{imageShort(current.image)}</span>
          <span className="text-border">·</span>
          <span>RAM {mib(current.usage.memMiB)} / {mib(current.memoryMiB)}</span>
          <span className="text-border">·</span>
          <span>{current.usage.cpuPercent ?? "—"}% CPU</span>
          <span className="text-border">·</span>
          <span>{giB(current.diskBytes)} on disk</span>
          <span className="text-border">·</span>
          <span className="truncate">notebooks/ · repos/ · drive/</span>
          <span className="ml-auto inline-flex items-center gap-1"><Check className="size-3" />embedded JupyterLab</span>
        </div>
      )}

      <Dialog open={nbOpen} onOpenChange={setNbOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New notebook</DialogTitle>
            <DialogDescription>
              {running ? "Created in notebooks/ and opened in JupyterLab." : "Start your runtime first, then create and open notebooks."}
            </DialogDescription>
          </DialogHeader>
          <Input autoFocus value={nbName} onChange={(e) => setNbName(e.target.value)} placeholder="notebook.ipynb" className="font-mono" onKeyDown={(e) => e.key === "Enter" && running && createNotebook.mutate()} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNbOpen(false)}>Cancel</Button>
            <Button onClick={() => createNotebook.mutate()} disabled={!running || createNotebook.isPending}>
              {createNotebook.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}Create &amp; open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import a repository</DialogTitle>
            <DialogDescription>
              Cloned into <code>repos/</code>. Private repos use Git credentials saved in{" "}
              <Link to="/workspace" className="text-primary underline underline-offset-2">Workspaces → Git</Link>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input autoFocus value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/user/repo.git" className="font-mono" onKeyDown={(e) => e.key === "Enter" && running && repoUrl.trim().length >= 8 && clone.mutate()} />
            <div className="flex gap-2">
              <Input value={repoBranch} onChange={(e) => setRepoBranch(e.target.value)} placeholder="branch (optional)" />
              <Input value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="directory (optional)" className="w-44" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button onClick={() => clone.mutate()} disabled={!running || clone.isPending || repoUrl.trim().length < 8}>
              {clone.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}Clone &amp; open
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={gpuConfirm !== null} onOpenChange={(open) => !open && setGpuConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{gpuConfirm ? "Enable GPU?" : "Disable GPU?"}</DialogTitle>
            <DialogDescription>
              Recreates the container with {gpuConfirm ? "the GTX 1050 passed through (4 GiB)" : "GPU removed"}.
              Running kernels are interrupted; notebooks and files are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGpuConfirm(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (gpuConfirm !== null) start.mutate(gpuConfirm);
                setGpuConfirm(null);
              }}
              disabled={start.isPending}
            >
              {start.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              {gpuConfirm ? "Enable GPU" : "Disable GPU"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resourcesOpen} onOpenChange={setResourcesOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Runtime resources</DialogTitle>
            <DialogDescription>Applies by recreating the container. Kernels are interrupted; files are kept.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-xs text-muted-foreground">Memory (GiB)</label>
            <div className="flex gap-2">
              {[1, 2, 4, 8].map((g) => (
                <button
                  key={g}
                  onClick={() => setMemGiB(g)}
                  className={`h-10 flex-1 rounded-xl border font-mono text-sm transition ${memGiB === g ? "border-foreground/30 bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`}
                >{g}</button>
              ))}
            </div>
            <label className="block text-xs text-muted-foreground">vCPUs</label>
            <div className="flex gap-2">
              {[1, 2, 4, 8].map((c) => (
                <button
                  key={c}
                  onClick={() => setVcpus(c)}
                  className={`h-10 flex-1 rounded-xl border font-mono text-sm transition ${vcpus === c ? "border-foreground/30 bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`}
                >{c}</button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResourcesOpen(false)}>Cancel</Button>
            <Button onClick={() => { start.mutate(current?.gpu ?? false); setResourcesOpen(false); }} disabled={start.isPending}>
              {start.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}Apply &amp; restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NotebookHome({
  current, memGiB, vcpus, gpuDefault, onMem, onVcpus, onStart, pending,
}: {
  current: Workspace;
  memGiB: number;
  vcpus: number;
  gpuDefault: boolean;
  onMem: (value: number) => void;
  onVcpus: (value: number) => void;
  onStart: (gpu: boolean) => void;
  pending: boolean;
  onNewNotebook: () => void;
  onImportRepo: () => void;
  onUpload: () => void;
}) {
  const [gpu, setGpu] = useState(gpuDefault);
  return (
    <div className="flex-1 overflow-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <section className="glass-panel noise rounded-xl p-5 sm:p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border bg-background/40 px-3 py-1 text-[11px] text-muted-foreground">
                <FlaskConical className="size-3.5" /> JupyterLab · notebooks, repos, GPU
              </div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Notebook dashboard</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Create and run Python notebooks in your persistent KDG workspace — like Colab/Kaggle, hosted on your own server.
                Files persist in <code className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px]">workspaces/{current.username}</code>.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="lg" className="gap-2 rounded-lg" onClick={() => onStart(gpu)} disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                Start runtime
              </Button>
              <Button size="lg" variant="outline" className="gap-2 rounded-lg" asChild>
                <Link to="/workspace"><Settings2 className="size-4" />Workspace settings</Link>
              </Button>
            </div>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Status", value: (current.state || "unknown").replace(/_/g, " ") },
              { label: "Image", value: imageShort(current.image) },
              { label: "Disk", value: giB(current.diskBytes) },
              { label: "GPU", value: "GTX 1050 (4 GiB)" },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border bg-background/30 p-3">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</div>
                <div className="mt-1 truncate font-mono text-[12px]">{s.value}</div>
              </div>
            ))}
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
          <section className="glass-panel rounded-xl p-4 sm:p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Start something new</h2>
              <Pill tone="muted">runtime stopped</Pill>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <ActionCard icon={<NotebookPen className="size-5" />} title="New notebook" desc="Create a .ipynb in notebooks/ and open it in JupyterLab." action="Start runtime" onClick={() => onStart(gpu)} disabled={pending} />
              <ActionCard icon={<Upload className="size-5" />} title="Upload files" desc="Add datasets, notebooks, or scripts to your workspace." action="Start runtime" onClick={() => onStart(gpu)} disabled={pending} />
              <ActionCard icon={<FolderGit2 className="size-5" />} title="Import repository" desc="Clone a Git repo into repos/ with saved credentials." action="Start runtime" onClick={() => onStart(gpu)} disabled={pending} />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <MiniInfo title="Notebooks" value="notebooks/" hint="Persistent .ipynb files" />
              <MiniInfo title="Repositories" value="repos/" hint="Cloned Git projects" />
              <MiniInfo title="Drive" value="drive/" hint="KDG Drive folder" />
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">When running, the full JupyterLab environment opens here. Use the top bar for New notebook, Import repo, and Upload once started.</p>
          </section>

          <section className="glass-panel rounded-xl p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Runtime configuration</h2>
            <p className="mt-1 text-[12px] text-muted-foreground">Choose resources, then start. Files persist; kernels run in your container.</p>
            <div className="mt-4 space-y-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground"><span>Memory</span><span className="font-mono text-foreground">{memGiB} GiB</span></div>
                <div className="flex gap-1.5">
                  {[1, 2, 4, 8].map((g) => (
                    <button key={g} onClick={() => onMem(g)} className={`h-9 flex-1 rounded-xl border font-mono text-xs transition ${memGiB === g ? "border-foreground/30 bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`}>{g}G</button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs text-muted-foreground"><span>vCPUs</span><span className="font-mono text-foreground">{vcpus}</span></div>
                <div className="flex gap-1.5">
                  {[1, 2, 4, 8].map((c) => (
                    <button key={c} onClick={() => onVcpus(c)} className={`h-9 flex-1 rounded-xl border font-mono text-xs transition ${vcpus === c ? "border-foreground/30 bg-accent text-foreground" : "text-muted-foreground hover:bg-accent"}`}>{c}</button>
                  ))}
                </div>
              </div>
              <button onClick={() => setGpu((g) => !g)} className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${gpu ? "border-foreground/25 bg-accent/60" : "hover:bg-accent/40"}`}>
                <Zap className={`size-5 ${gpu ? "text-foreground" : "text-muted-foreground"}`} />
                <span className="flex-1">
                  <span className="block text-[13px] font-medium">GPU accelerator</span>
                  <span className="block text-[11px] text-muted-foreground">NVIDIA GTX 1050 · 4 GiB passthrough</span>
                </span>
                <span className={`grid size-6 place-items-center rounded-full border text-[11px] ${gpu ? "border-foreground/30 bg-foreground text-background" : "text-muted-foreground"}`}>{gpu ? "âœ“" : ""}</span>
              </button>
              <Button size="lg" className="w-full gap-2 rounded-lg" onClick={() => onStart(gpu)} disabled={pending}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {pending ? "Starting runtime…" : "Start runtime"}
              </Button>
              <p className="text-center text-[10px] text-muted-foreground">First boot may take a minute while the image pulls and JupyterLab loads.</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ActionCard({ icon, title, desc, action, onClick, disabled }: { icon: ReactNode; title: string; desc: string; action: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className="group flex flex-col items-start rounded-lg border bg-background/20 p-4 text-left transition hover:-translate-y-0.5 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-70">
      <span className="mb-3 grid size-10 place-items-center rounded-xl border bg-muted/30 text-foreground">{icon}</span>
      <span className="text-[13px] font-medium">{title}</span>
      <span className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{desc}</span>
      <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-foreground/80">{action} <ChevronDown className="size-3 -rotate-90" /></span>
    </button>
  );
}

function MiniInfo({ title, value, hint }: { title: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border bg-background/20 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="mt-1 font-mono text-[12px]">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}
