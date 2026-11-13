import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle, ArrowRight, Boxes, Cloud, Copy, ExternalLink, Gamepad2, HardDrive, Loader2, Play, Plus, RotateCw,
  Square, Users as UsersIcon, Wifi, MoreVertical, Trash2,
} from "lucide-react";
import { api } from "@/services/api/client";
import { mcServersQuery } from "@/services/api/queries";
import { PageHeader, Panel, Pill, Stat, Empty } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { McCatalog, MinecraftServer, PlayitStatus } from "@/types";
import { toast } from "sonner";

export const Route = createFileRoute("/minecraft")({
  head: () => ({
    meta: [
      { title: "Minecraft servers · KDG Cloud" },
      { name: "description", content: "Create, start and manage Minecraft servers with live logs and console." },
    ],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(mcServersQuery);
    } catch {
      // SSR without session; client will retry.
    }
  },
  component: MinecraftPage,
});

const TYPES = ["PAPER", "VANILLA", "FABRIC", "FORGE", "NEOFORGE", "PURPUR", "SPIGOT"] as const;
const FALLBACK_VERSIONS = ["LATEST", "1.21.4", "1.21.1", "1.20.6", "1.20.4", "1.20.1", "1.19.4"];
const MEMORIES = ["1G", "2G", "3G", "4G", "6G", "8G"];
const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"];
const GAMEMODES = ["survival", "creative", "adventure", "spectator"];
const WORLD_TYPES = [
  { id: "minecraft:normal", label: "Normal" },
  { id: "minecraft:flat", label: "Superflat" },
  { id: "minecraft:large_biomes", label: "Large biomes" },
  { id: "minecraft:amplified", label: "Amplified" },
  { id: "minecraft:single_biome_surface", label: "Single biome" },
] as const;

type FormState = {
  name: string;
  description: string;
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
  rconPassword: string;
  seed: string;
  levelType: string;
  worldFile: File | null;
  worldUploadName: string;
};

const blankForm = (port = 25565): FormState => ({
  name: "",
  description: "",
  type: "PAPER",
  version: "LATEST",
  memory: "2G",
  port,
  maxPlayers: 20,
  motd: "A KDG Minecraft Server",
  difficulty: "normal",
  gamemode: "survival",
  pvp: true,
  onlineMode: true,
  enableRcon: true,
  rconPassword: "",
  seed: "",
  levelType: "minecraft:normal",
  worldFile: null,
  worldUploadName: "",
});

function mcStatusTone(s: MinecraftServer): "success" | "warning" | "muted" | "destructive" {
  const state = s.runtime?.state;
  if (state === "running") return "success";
  if (state === "stopped") return "muted";
  if (state === "not_created") return "warning";
  return "destructive";
}

function MinecraftPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data = [], isPending, isError, error } = useQuery(mcServersQuery);
  const catalog = useQuery({ queryKey: ["mc-catalog"], queryFn: api.mcCatalog, staleTime: 60 * 60 * 1000, retry: 1 });
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<MinecraftServer | null>(null);
  const [form, setForm] = useState<FormState>(blankForm());
  const [busy, setBusy] = useState<string | null>(null);
  const playit = useQuery({ queryKey: ["playit-status"], queryFn: api.playitStatus, enabled: createOpen, refetchInterval: 10000, staleTime: 8000 });

  const servers = data;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["minecraft-servers"] });

  const suggestedPort = useMemo(() => {
    const used = new Set(servers.map((s) => s.port));
    let p = 25565;
    while (used.has(p) && p < 25600) p += 1;
    return p;
  }, [servers]);

  const openCreate = () => {
    setForm(blankForm(suggestedPort));
    setCreated(null);
    setCreateOpen(true);
  };

  const mcDelete = useMutation({
    mutationFn: ({ id, withData }: { id: string; withData: boolean }) => api.mcDeleteServer(id, withData),
    onSuccess: (_r, v) => {
      toast.success(v.withData ? "Server and world data deleted" : "Server deleted (world kept)");
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete server"),
  });

  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "start" | "stop" | "restart" }) => {
      setBusy(id);
      if (action === "start") return api.mcStartServer(id);
      if (action === "stop") return api.mcStopServer(id);
      return api.mcRestartServer(id);
    },
    onSuccess: (_r, v) => {
      toast.success(`${v.action === "start" ? "Starting" : v.action === "stop" ? "Stopping" : "Restarting"} server…`);
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Action failed"),
    onSettled: () => setBusy(null),
  });

  const [creatingStep, setCreatingStep] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      setCreatingStep("Creating server…");
      const server = await api.mcCreateServer({
        name: form.name.trim(),
        description: form.description.trim(),
        type: form.type,
        version: form.version,
        memory: form.memory,
        port: form.port,
        maxPlayers: form.maxPlayers,
        motd: form.motd,
        difficulty: form.difficulty,
        gamemode: form.gamemode,
        pvp: form.pvp,
        onlineMode: form.onlineMode,
        enableRcon: form.enableRcon,
        rconPassword: form.rconPassword,
        seed: form.seed.trim(),
        levelType: form.levelType,
      });
      if (form.worldFile) {
        setCreatingStep("Uploading world…");
        try {
          await api.mcUploadWorld(server.id, form.worldFile, form.worldUploadName);
          toast.success(`Created ${server.name} and uploaded world`);
        } catch (e) {
          toast.error(e instanceof Error ? `Server created, but world upload failed: ${e.message}` : "Server created, but world upload failed");
        }
      } else {
        toast.success(`Created ${server.name}`);
      }
      return server;
    },
    onSuccess: (server) => {
      void invalidate();
      setCreated(server);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not create server"),
    onSettled: () => setCreatingStep(null),
  });

  const running = servers.filter((s) => s.runtime?.state === "running").length;

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Minecraft"
        badge={<Pill tone="primary" dot>{servers.length} server{servers.length === 1 ? "" : "s"}</Pill>}
        description="Create and run managed Minecraft servers. Worlds persist on the node; each server runs in its own container with its own port, memory limit and console."
        actions={<Button size="sm" onClick={openCreate}><Plus className="size-4" /> New server</Button>}
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Servers" value={servers.length} sub={`${running} running`} icon={<Gamepad2 className="size-4" />} />
        <Stat label="Running now" value={running} sub={`${servers.length} configured`} icon={<UsersIcon className="size-4" />} />
        <Stat label="Assigned RAM" value={`${servers.reduce((n, s) => n + (parseInt(s.memory) || 0), 0)} GiB`} sub="across all servers" icon={<HardDrive className="size-4" />} />
        <Stat label="Ports in use" value={servers.length} sub="TCP · Java edition" icon={<Wifi className="size-4" />} />
      </div>

      {isError ? (
        <Empty title="Could not load Minecraft servers" hint={error instanceof Error ? error.message : "Request failed"} icon={<AlertTriangle className="size-6" />} />
      ) : isPending ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-56" />)}</div>
      ) : servers.length === 0 ? (
        <Panel>
          <Empty
            title="No Minecraft servers yet"
            hint="Create your first server — pick Paper/Vanilla/Fabric, a version, memory and port. It starts on demand and can auto-restart with the host."
            icon={<Gamepad2 className="size-8" />}
          />
          <div className="flex justify-center"><Button onClick={openCreate}><Plus className="size-4" /> Create your first server</Button></div>
        </Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((s) => (
            <ServerCard
              key={s.id}
              server={s}
              busy={busy === s.id}
              onOpen={() => void navigate({ to: "/minecraft/$id", params: { id: s.id } })}
              onAction={(action) => act.mutate({ id: s.id, action })}
              onDelete={(withData) => mcDelete.mutate({ id: s.id, withData })}
            />
          ))}
        </div>
      )}

      <Panel className="mt-4" title="How it works">
        <ul className="grid gap-2 text-[13px] text-muted-foreground md:grid-cols-3">
          <li><b className="text-foreground">Persistent worlds</b> — data lives at minecraft/data/&lt;id&gt; and survives restarts and reboots.</li>
          <li><b className="text-foreground">Console &amp; logs</b> — send commands, read live output, no RCON password exposed to the browser.</li>
          <li><b className="text-foreground">Ownership</b> — servers are labelled with their creator and appear under User resources.</li>
        </ul>
      </Panel>

      <CreateDialog
        open={createOpen}
        onOpenChange={(o) => { setCreateOpen(o); if (!o) setCreated(null); }}
        form={form}
        setForm={setForm}
        onCreate={() => create.mutate()}
        pending={create.isPending}
        creatingStep={creatingStep}
        catalog={catalog.data}
        created={created}
        playit={playit.data}
        onOpenServer={() => { if (created) void navigate({ to: "/minecraft/$id", params: { id: created.id } }); }}
      />
    </div>
  );
}

function ServerCard({ server, busy, onOpen, onAction, onDelete }: { server: MinecraftServer; busy: boolean; onOpen: () => void; onAction: (a: "start" | "stop" | "restart") => void; onDelete: (withData: boolean) => void }) {
  const state = server.runtime?.state ?? "unknown";
  const isRunning = state === "running";
  const address = server.address ?? `localhost:${server.port}`;
  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-2 border-b p-4">
        <button className="min-w-0 text-left" onClick={onOpen}>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary"><Gamepad2 className="size-4" /></span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{server.name}</div>
              <div className="text-[11px] text-muted-foreground">{server.type} · {server.version} · {server.memory}</div>
            </div>
          </div>
        </button>
        <Pill tone={mcStatusTone(server)} dot>{isRunning ? "running" : state.replace("_", " ")}</Pill>
      </div>
      <div className="flex-1 space-y-2 p-4">
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">Address</span>
          <button
            className="inline-flex items-center gap-1 font-mono hover:text-primary"
            onClick={() => { void navigator.clipboard.writeText(address).then(() => toast.success("Address copied")); }}
          >
            {address} <Copy className="size-3" />
          </button>
        </div>
        {server.addresses && server.addresses.length > 1 && (
          <div className="text-[11px] text-muted-foreground">also {server.addresses.slice(1).join(", ")}</div>
        )}
        <div className="flex items-center justify-between text-[12px]"><span className="text-muted-foreground">Players</span><span className="tabular">{server.maxPlayers} max</span></div>
        <div className="flex items-center justify-between text-[12px]"><span className="text-muted-foreground">Mode</span><span>{server.gamemode} · {server.difficulty}</span></div>
        <div className="flex items-center justify-between text-[12px]"><span className="text-muted-foreground">Owner</span><span>{server.createdBy ?? "—"}</span></div>
        {server.motd && <p className="truncate rounded border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground" title={server.motd}>{server.motd}</p>}
        {server.runtime?.status && <div className="text-[11px] text-muted-foreground">{server.runtime.status}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t p-3">
        {isRunning ? (
          <>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAction("restart")}><RotateCw className="size-3.5" /> Restart</Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAction("stop")}><Square className="size-3.5" /> Stop</Button>
          </>
        ) : (
          <Button size="sm" className="h-7 px-2 text-xs" disabled={busy} onClick={() => onAction("start")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Start
          </Button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onOpen}>Manage</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="size-7 px-0" aria-label="Server actions">
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                onClick={() => { if (window.confirm(`Delete ${server.name}? World data will be kept on disk.`)) onDelete(false); }}
              >
                <Trash2 className="mr-2 size-4" /> Delete server (keep world)
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => { if (window.confirm(`Delete ${server.name} AND all world data? This cannot be undone.`)) onDelete(true); }}
              >
                <Trash2 className="mr-2 size-4" /> Delete server + world data
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

function CreateDialog({ open, onOpenChange, form, setForm, onCreate, pending, creatingStep, catalog, created, playit, onOpenServer }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  form: FormState;
  setForm: (f: FormState) => void;
  onCreate: () => void;
  pending: boolean;
  creatingStep: string | null;
  catalog?: McCatalog | undefined;
  created: MinecraftServer | null;
  playit: PlayitStatus | undefined;
  onOpenServer: () => void;
}) {
  const copy = (text: string) => { void navigator.clipboard.writeText(text).then(() => toast.success("Copied to clipboard")); };

  if (created) {
    const rawAddresses = created.addresses?.length ? created.addresses : ["192.168.1.18", "100.119.120.20"];
    const addresses = rawAddresses.map((entry) => {
      const host = entry.split(":")[0] ?? entry;
      const label = host.startsWith("100.") ? "Tailscale" : host.startsWith("192.168.") ? "LAN" : "Address";
      return { label, value: `${host}:${created.port}` };
    });
    const dashboardUrl = playit?.dashboardUrl ?? "https://playit.gg/dashboard";
    const agentUrl = playit?.agentUrl ?? "https://playit.gg/account/agents";
    const claimUrl = playit?.claimUrl ?? "https://playit.gg/claim";
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-full bg-primary/15 text-primary text-sm">✓</span>
              {created.name} is created
            </DialogTitle>
            <DialogDescription>
              {created.type} {created.version} · port <span className="font-mono">{created.port}</span> · {created.memory} RAM · {created.maxPlayers} max players
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {addresses.map((row) => (
                <button key={row.value} onClick={() => copy(row.value)} title="Copy address"
                  className="group rounded-md border p-3 text-left transition hover:border-primary/40 hover:bg-accent/40">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{row.label}</div>
                  <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[13px]">
                    {row.value}
                    <Copy className="size-3.5 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
                  </div>
                </button>
              ))}
            </div>

            <div className="space-y-2 rounded-md border border-primary/25 bg-primary/5 p-3">
              <div className="flex items-center gap-2 text-[13px] font-medium"><Cloud className="size-4 text-primary" /> Public via playit.gg</div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                {!playit ? (
                  "Checking playit agent…"
                ) : playit.installed ? (
                  <>
                    <span className={`inline-block size-2 rounded-full ${playit.serviceActive ? "bg-emerald-500" : "bg-red-500"}`} />
                    Agent {playit.serviceActive ? "online" : "offline"} · v{playit.version ?? "2.0.2"}{playit.secretConfigured ? " · secret configured" : ""}
                  </>
                ) : (
                  "playit agent is not installed on this node"
                )}
              </div>
              <ol className="list-decimal space-y-0.5 pl-5 text-[11px] text-muted-foreground">
                <li>Open the <a className="font-medium text-primary underline underline-offset-2" href={dashboardUrl} target="_blank" rel="noreferrer">playit.gg dashboard</a></li>
                <li>Tunnels → Create → <span className="font-mono">TCP</span> → local <span className="font-mono">127.0.0.1:{created.port}</span></li>
                <li>Share <span className="font-mono">xxxx.playit.gg:PORT</span> with anyone — no Tailscale needed</li>
              </ol>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <a href={dashboardUrl} target="_blank" rel="noreferrer"><Button size="sm"><ExternalLink className="mr-2 size-3.5" />Open dashboard</Button></a>
                <Button size="sm" variant="outline" onClick={() => copy(`127.0.0.1:${created.port}`)}><Copy className="mr-2 size-3.5" />Copy local target</Button>
                <a href={agentUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary underline underline-offset-2">Agent page</a>
                <a href={claimUrl} target="_blank" rel="noreferrer" className="text-[11px] text-muted-foreground underline underline-offset-2">Claim URL</a>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Done</Button>
            <Button onClick={onOpenServer}>Open server console <ArrowRight className="ml-2 size-4" /></Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });
  const typeInfo = catalog?.types.find((t) => t.id === form.type);
  const versions = ["LATEST", ...(typeInfo?.versions?.length ? typeInfo.versions : FALLBACK_VERSIONS.filter((v) => v !== "LATEST"))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create a Minecraft server</DialogTitle>
          <DialogDescription>Choose a server flavour and limits. You can change these later while the server is stopped.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Server name">
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Parth Survival" className="h-9" />
            </Field>
            <Field label="Description (optional)">
              <Input value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Modded survival world" className="h-9" />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Server software">
              <select value={form.type} onChange={(e) => set("type", e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Minecraft version">
              <select value={form.version} onChange={(e) => set("version", e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {[...new Set([form.version, ...versions])].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="Memory">
              <select value={form.memory} onChange={(e) => set("memory", e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {MEMORIES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Port (TCP)">
              <Input type="number" min={1024} max={65535} value={form.port} onChange={(e) => set("port", Number(e.target.value))} className="h-9" />
            </Field>
            <Field label="Max players">
              <Input type="number" min={1} max={200} value={form.maxPlayers} onChange={(e) => set("maxPlayers", Number(e.target.value))} className="h-9" />
            </Field>
            <Field label="Difficulty">
              <select value={form.difficulty} onChange={(e) => set("difficulty", e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="MOTD">
              <Input value={form.motd} onChange={(e) => set("motd", e.target.value)} className="h-9" />
            </Field>
            <Field label="Game mode">
              <select value={form.gamemode} onChange={(e) => set("gamemode", e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {GAMEMODES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
          </div>

          <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-3">
            <Toggle label="PvP" checked={form.pvp} onChange={(v) => set("pvp", v)} />
            <Toggle label="Online mode" checked={form.onlineMode} onChange={(v) => set("onlineMode", v)} />
            <Toggle label="RCON console" checked={form.enableRcon} onChange={(v) => set("enableRcon", v)} />
          </div>

          <Field label="RCON password (optional — generated if blank)">
            <Input type="password" value={form.rconPassword} onChange={(e) => set("rconPassword", e.target.value)} placeholder="auto-generated" className="h-9" />
          </Field>

          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            <div className="text-[13px] font-medium">World (on first start)</div>
            <p className="text-[11px] text-muted-foreground">Choose how the world is created. Auto-generate uses a random seed unless you provide one. Uploading a world zip replaces/sets that world as active after the server is created (server must stay stopped until upload finishes).</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Seed (optional)">
                <Input value={form.seed} onChange={(e) => set("seed", e.target.value)} placeholder="random — leave blank for auto" className="h-9 font-mono text-xs" disabled={!!form.worldFile} />
              </Field>
              <Field label="World type">
                <select value={form.levelType} onChange={(e) => set("levelType", e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm" disabled={!!form.worldFile}>
                  {WORLD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Upload existing world (.zip, optional)">
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  setForm({ ...form, worldFile: file, worldUploadName: file ? form.worldUploadName : "" });
                }}
                className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-primary-foreground"
              />
            </Field>
            {form.worldFile && (
              <Field label="World name in archive (optional)">
                <Input value={form.worldUploadName} onChange={(e) => set("worldUploadName", e.target.value)} placeholder={form.worldFile.name.replace(/\.zip$/i, "")} className="h-9" />
              </Field>
            )}
            {form.worldFile && <p className="text-[11px] text-muted-foreground">Seed/type are ignored when uploading a world. The zip must contain <span className="font-mono">level.dat</span> (zip the world folder itself).</p>}
          </div>

          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
            <Boxes className="mt-0.5 size-3.5 shrink-0" />
            <span>Uses the official <span className="font-mono">itzg/minecraft-server</span> image. The first start downloads the server jar and generates the world, which can take a few minutes.</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button disabled={pending || form.name.trim().length < 2} onClick={onCreate}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {creatingStep ?? "Create server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="label-caps">{label}</label>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--primary)]" />
      {label}
    </label>
  );
}
