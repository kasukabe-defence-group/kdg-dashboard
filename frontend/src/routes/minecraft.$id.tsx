import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle, ArrowLeft, Ban, Cloud, Copy, Crown, Gamepad2, Globe, HardDrive, Layers,
  Loader2, Package, Play, Plus, Power, Puzzle, RefreshCw, RotateCw, Save, Search,
  ShieldCheck, Square, TerminalSquare, Trash2, Upload, UserMinus, UserPlus, Users, Wifi,
} from "lucide-react";
import { api } from "@/services/api/client";
import { mcServersQuery } from "@/services/api/queries";
import { Empty, KV, Panel, Pill, Stat } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { McBackupStatus, McCatalogType, McPlayers, MinecraftServer } from "@/types";
import { toast } from "sonner";

export const Route = createFileRoute("/minecraft/$id")({
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData ?? "Server"} · Minecraft · KDG Cloud` },
      { name: "description", content: "Manage a Minecraft server: console, players, worlds, plugins and software." },
    ],
  }),
  loader: async ({ context, params }) => {
    try {
      const list = await context.queryClient.ensureQueryData(mcServersQuery);
      return list.find((s) => s.id === params.id)?.name ?? null;
    } catch {
      return null;
    }
  },
  component: MinecraftServerPage,
});

const MEMORIES = ["1G", "2G", "3G", "4G", "6G", "8G"];
const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"];
const GAMEMODES = ["survival", "creative", "adventure", "spectator"];
const WORLD_TYPES = [
  { id: "minecraft:normal", label: "Normal" },
  { id: "minecraft:flat", label: "Superflat" },
  { id: "minecraft:large_biomes", label: "Large biomes" },
  { id: "minecraft:amplified", label: "Amplified" },
];
const MOD_TYPES = ["FABRIC", "FORGE", "NEOFORGE", "QUILT"];

function toneFor(s: MinecraftServer): "success" | "warning" | "muted" | "destructive" {
  const state = s.runtime?.state;
  if (state === "running") return "success";
  if (state === "stopped") return "muted";
  if (state === "not_created") return "warning";
  return "destructive";
}

function bytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(i === 0 || value >= 10 ? 0 : 1)} ${units[i]}`;
}

function when(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "—";
  return new Date(t).toLocaleString();
}

function MinecraftServerPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data = [], isPending, isError, error } = useQuery(mcServersQuery);
  const server = data.find((s) => s.id === id);
  const [tab, setTab] = useState("console");
  const [busy, setBusy] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["minecraft-servers"] });
    void queryClient.invalidateQueries({ queryKey: ["mc-logs", id] });
  };

  const act = useMutation({
    mutationFn: async (action: "start" | "stop" | "restart") => {
      setBusy(action);
      if (action === "start") return api.mcStartServer(id);
      if (action === "stop") return api.mcStopServer(id);
      return api.mcRestartServer(id);
    },
    onSuccess: (_r, action) => {
      toast.success(`${action === "start" ? "Starting" : action === "stop" ? "Stopping" : "Restarting"} server…`);
      void invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Action failed"),
    onSettled: () => setBusy(null),
  });

  useEffect(() => { setTab("console"); }, [id]);

  if (isPending) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !server) {
    return (
      <div className="mx-auto max-w-[1400px]">
        <Link to="/minecraft" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" /> Minecraft servers
        </Link>
        <Empty
          title="Server not found"
          hint={isError && error instanceof Error ? error.message : "This server does not exist or you no longer have access to it."}
          icon={<Gamepad2 className="size-8" />}
        />
      </div>
    );
  }

  const isRunning = server.runtime?.state === "running";
  const modded = MOD_TYPES.includes(server.type);
  const address = server.address ?? `localhost:${server.port}`;

  return (
    <div className="mx-auto max-w-[1400px]">
      <Link to="/minecraft" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3" /> Minecraft servers
      </Link>

      <Panel bodyClass="p-0" className="mb-4">
        <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Gamepad2 className="size-6" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">{server.name}</h1>
              <Pill tone={toneFor(server)} dot>{server.runtime?.state?.replace("_", " ") ?? "unknown"}</Pill>
              <Pill tone="muted">{server.type} {server.version}</Pill>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
              <button
                className="inline-flex items-center gap-1 font-mono text-foreground hover:text-primary"
                onClick={() => { void navigator.clipboard.writeText(address).then(() => toast.success("Address copied")); }}
              >
                {address} <Copy className="size-3" />
              </button>
              {server.addresses && server.addresses.length > 1 && <span>also {server.addresses.slice(1).join(", ")}</span>}
              <span>· {server.memory} RAM</span>
              <span>· owner {server.createdBy ?? "—"}</span>
            </div>
            {server.description && <p className="mt-1 text-[12px] text-muted-foreground">{server.description}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isRunning ? (
              <>
                <Button variant="outline" disabled={busy !== null} onClick={() => act.mutate("restart")}>
                  {busy === "restart" ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />} Restart
                </Button>
                <Button variant="destructive" disabled={busy !== null} onClick={() => act.mutate("stop")}>
                  {busy === "stop" ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />} Stop
                </Button>
              </>
            ) : (
              <Button disabled={busy !== null} onClick={() => act.mutate("start")}>
                {busy === "start" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Start server
              </Button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y border-t sm:grid-cols-4 sm:divide-y-0">
          <HeroStat label="Status" value={isRunning ? "Online" : "Offline"} icon={isRunning ? <Wifi className="size-3.5" /> : <Power className="size-3.5" />} />
          <HeroStat label="Players" value={`${server.maxPlayers} max`} icon={<Users className="size-3.5" />} />
          <HeroStat label="Software" value={`${server.type} ${server.version}`} icon={<Layers className="size-3.5" />} />
          <HeroStat label="Memory · port" value={`${server.memory} · ${server.port}`} icon={<HardDrive className="size-3.5" />} />
        </div>
      </Panel>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-3 flex h-auto flex-wrap">
          <TabsTrigger value="console" className="gap-1.5"><TerminalSquare className="size-3.5" /> Console</TabsTrigger>
          <TabsTrigger value="players" className="gap-1.5"><Users className="size-3.5" /> Players</TabsTrigger>
          <TabsTrigger value="worlds" className="gap-1.5"><Globe className="size-3.5" /> Worlds</TabsTrigger>
          <TabsTrigger value="addons" className="gap-1.5"><Puzzle className="size-3.5" /> {modded ? "Mods" : "Plugins"}</TabsTrigger>
          <TabsTrigger value="software" className="gap-1.5"><Layers className="size-3.5" /> Software</TabsTrigger>
          <TabsTrigger value="settings" className="gap-1.5"><Save className="size-3.5" /> Settings</TabsTrigger>
          <TabsTrigger value="backups" className="gap-1.5"><Cloud className="size-3.5" /> Backups</TabsTrigger>
          <TabsTrigger value="danger" className="gap-1.5"><Trash2 className="size-3.5" /> Danger</TabsTrigger>
        </TabsList>

        <TabsContent value="console">
          <ConsoleTab server={server} active={tab === "console"} />
        </TabsContent>
        <TabsContent value="players">
          <PlayersTab server={server} active={tab === "players"} />
        </TabsContent>
        <TabsContent value="worlds">
          <WorldsTab server={server} active={tab === "worlds"} onChanged={invalidate} />
        </TabsContent>
        <TabsContent value="addons">
          <AddonsTab server={server} active={tab === "addons"} />
        </TabsContent>
        <TabsContent value="software">
          <SoftwareTab server={server} active={tab === "software"} busy={busy !== null} onStop={() => act.mutate("stop")} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab server={server} />
        </TabsContent>
        <TabsContent value="backups">
          <BackupsTab server={server} active={tab === "backups"} />
        </TabsContent>
        <TabsContent value="danger">
          <DangerTab
            server={server}
            onDeleted={() => { void queryClient.invalidateQueries({ queryKey: ["minecraft-servers"] }); void navigate({ to: "/minecraft" }); }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function HeroStat({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="p-3">
      <div className="flex items-center justify-between">
        <span className="label-caps">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ console */

function ConsoleTab({ server, active }: { server: MinecraftServer; active: boolean }) {
  const isRunning = server.runtime?.state === "running";
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  const logs = useQuery({
    queryKey: ["mc-logs", server.id],
    queryFn: () => api.mcServerLogs(server.id, 300),
    enabled: active,
    refetchInterval: isRunning ? 4000 : 15000,
  });

  const send = useMutation({
    mutationFn: (cmd: string) => api.mcServerCommand(server.id, cmd),
    onSuccess: (r, cmd) => {
      setOutput((prev) => [...prev.slice(-60), `> ${cmd}${r.output ? `\n${r.output}` : ""}`]);
      setCommand("");
    },
    onError: (e) => setOutput((prev) => [...prev.slice(-60), `! ${e instanceof Error ? e.message : "command failed"}`]),
  });

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs.data?.logs]);

  const quick = ["list", "save-all", "tps", "whitelist list", "say Server restarting soon"];
  const logText = logs.data?.logs || (logs.isError ? "Could not fetch logs from the API." : "Loading logs…");

  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
      <Panel title="Console output" actions={<span className="text-[11px] text-muted-foreground">{isRunning ? "live · 4s refresh" : "offline · 15s refresh"}</span>} bodyClass="p-0">
        <pre ref={logRef} className="h-[420px] overflow-auto bg-black/85 p-3 font-mono text-[11.5px] leading-relaxed text-emerald-200/90">
          {logText}
        </pre>
        {output.length > 0 && (
          <pre className="max-h-40 overflow-auto border-t bg-muted/40 p-2 font-mono text-[11.5px]">{output.join("\n")}</pre>
        )}
        <div className="flex gap-2 border-t p-3">
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && command.trim() && !send.isPending) send.mutate(command.trim()); }}
            placeholder={isRunning ? "/list  ·  /say hello  ·  /whitelist add Parth" : "Start the server to send commands"}
            disabled={!isRunning || send.isPending}
            className="h-9 font-mono text-xs"
          />
          <Button size="sm" className="h-9" disabled={!isRunning || !command.trim() || send.isPending} onClick={() => send.mutate(command.trim())}>
            {send.isPending ? <Loader2 className="size-4 animate-spin" /> : "Send"}
          </Button>
        </div>
      </Panel>

      <Panel title="Quick commands" bodyClass="space-y-1.5 p-3">
        {quick.map((c) => (
          <Button key={c} size="sm" variant="ghost" className="w-full justify-start font-mono text-[11px]" disabled={!isRunning || send.isPending} onClick={() => send.mutate(c)}>
            /{c}
          </Button>
        ))}
        <div className="mt-3 rounded-md border bg-muted/20 p-2 text-[11px] text-muted-foreground">
          Container: <span className="font-mono">{server.containerName ?? `mc-${server.id}`}</span>
          <br />Status: {server.runtime?.status ?? "unknown"}
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ players */

function PlayersTab({ server, active }: { server: MinecraftServer; active: boolean }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [opName, setOpName] = useState("");
  const isRunning = server.runtime?.state === "running";

  const players = useQuery({
    queryKey: ["mc-players", server.id],
    queryFn: () => api.mcPlayers(server.id),
    enabled: active,
    refetchInterval: isRunning ? 8000 : 30000,
  });

  const act = useMutation({
    mutationFn: (v: { action: string; name: string }) => api.mcPlayerAction(server.id, v.action, v.name),
    onSuccess: (r, v) => {
      toast.success(r.message || `${v.action} ${v.name}`);
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["mc-players", server.id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Player action failed"),
  });

  const data: McPlayers | undefined = players.data;
  const opSet = useMemo(() => new Set((data?.ops ?? []).map((n) => n.toLowerCase())), [data?.ops]);

  if (players.isPending) return <Skeleton className="h-64" />;
  if (players.isError || !data) {
    return <Empty title="Could not load players" hint={players.error instanceof Error ? players.error.message : "Try again shortly."} icon={<Users className="size-8" />} />;
  }

  const add = (action: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) act.mutate({ action, name: trimmed });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Online" value={data.online.length} sub={`${data.maxPlayers} slots`} icon={<Users className="size-4" />} />
        <Stat label="Whitelist" value={data.whitelist.length} sub={data.whitelistEnabled ? "enabled" : "disabled"} icon={<ShieldCheck className="size-4" />} />
        <Stat label="Operators" value={data.ops.length} sub="level 4" icon={<Crown className="size-4" />} />
        <Stat label="Banned" value={data.banned.length} sub={`${data.bannedIps.length} IP bans`} icon={<Ban className="size-4" />} />
      </div>

      {!isRunning && (
        <Banner>
          The server is offline. Whitelist, operator and ban changes are written directly to the world files, while kick and IP-ban need a running server.
        </Banner>
      )}

      <Panel title={`Online players (${data.online.length})`} bodyClass="p-0">
        {data.online.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">{isRunning ? "Nobody is online right now." : "Server is offline."}</p>
        ) : (
          <div className="divide-y">
            {data.online.map((player) => (
              <div key={player} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <Avatar name={player} />
                <span className="text-[13px] font-medium">{player}</span>
                {opSet.has(player.toLowerCase()) && <Pill tone="warning">op</Pill>}
                <div className="ml-auto flex gap-1.5">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={act.isPending}
                    onClick={() => act.mutate({ action: opSet.has(player.toLowerCase()) ? "deop" : "op", name: player })}>
                    <Crown className="size-3.5" /> {opSet.has(player.toLowerCase()) ? "De-op" : "Op"}
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={act.isPending}
                    onClick={() => act.mutate({ action: "kick", name: player })}>
                    <UserMinus className="size-3.5" /> Kick
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-destructive" disabled={act.isPending}
                    onClick={() => { if (window.confirm(`Ban ${player}?`)) act.mutate({ action: "ban", name: player }); }}>
                    <Ban className="size-3.5" /> Ban
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={`Whitelist (${data.whitelist.length})`} bodyClass="p-0">
          <div className="flex gap-2 border-b p-3">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Player name" className="h-8 text-xs"
              onKeyDown={(e) => { if (e.key === "Enter") add("whitelist-add", name); }} />
            <Button size="sm" className="h-8" disabled={!name.trim() || act.isPending} onClick={() => add("whitelist-add", name)}>
              <UserPlus className="size-3.5" /> Add
            </Button>
          </div>
          <PlayerList
            players={data.whitelist}
            empty="No whitelisted players."
            render={(player) => (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={act.isPending}
                onClick={() => act.mutate({ action: "whitelist-remove", name: player })}>
                <UserMinus className="size-3" /> Remove
              </Button>
            )}
          />
        </Panel>

        <Panel title={`Operators (${data.ops.length})`} bodyClass="p-0">
          <div className="flex gap-2 border-b p-3">
            <Input value={opName} onChange={(e) => setOpName(e.target.value)} placeholder="Player name" className="h-8 text-xs"
              onKeyDown={(e) => { if (e.key === "Enter") { add("op", opName); setOpName(""); } }} />
            <Button size="sm" className="h-8" disabled={!opName.trim() || act.isPending} onClick={() => { add("op", opName); setOpName(""); }}>
              <Crown className="size-3.5" /> Op
            </Button>
          </div>
          <PlayerList
            players={data.ops}
            empty="No operators."
            render={(player) => (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={act.isPending}
                onClick={() => act.mutate({ action: "deop", name: player })}>
                <UserMinus className="size-3" /> De-op
              </Button>
            )}
          />
        </Panel>
      </div>

      <Panel title={`Banned players (${data.banned.length})`} bodyClass="p-0">
        {data.banned.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">No bans.</p>
        ) : (
          <div className="divide-y">
            {data.banned.map((row) => (
              <div key={row.name} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <Ban className="size-3.5 text-destructive" />
                <span className="text-[13px] font-medium">{row.name}</span>
                {row.reason && <span className="text-[11px] text-muted-foreground">“{row.reason}”</span>}
                <span className="text-[11px] text-muted-foreground">· {row.expires || "forever"}</span>
                <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[11px]" disabled={act.isPending}
                  onClick={() => act.mutate({ action: "pardon", name: row.name })}>
                  <UserPlus className="size-3" /> Pardon
                </Button>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex size-7 items-center justify-center rounded bg-primary/10 text-[11px] font-semibold uppercase text-primary">
      {name.slice(0, 2)}
    </span>
  );
}

function PlayerList({ players, empty, render }: { players: string[]; empty: string; render: (p: string) => ReactNode }) {
  if (players.length === 0) return <p className="p-4 text-[13px] text-muted-foreground">{empty}</p>;
  return (
    <div className="divide-y">
      {players.map((player) => (
        <div key={player} className="flex items-center gap-2 px-4 py-2">
          <Avatar name={player} />
          <span className="text-[13px]">{player}</span>
          <div className="ml-auto">{render(player)}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- worlds */

function WorldsTab({ server, active, onChanged }: { server: MinecraftServer; active: boolean; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [seed, setSeed] = useState("");
  const [levelType, setLevelType] = useState("minecraft:normal");
  const [file, setFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const isRunning = server.runtime?.state === "running";

  const worlds = useQuery({
    queryKey: ["mc-worlds", server.id],
    queryFn: () => api.mcWorlds(server.id),
    enabled: active,
    refetchInterval: 20000,
  });

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["mc-worlds", server.id] }); onChanged(); };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "World action failed");

  const create = useMutation({
    mutationFn: () => api.mcCreateWorld(server.id, { name: name.trim(), seed: seed.trim(), levelType }),
    onSuccess: (r) => { toast.success(r.message); setName(""); setSeed(""); refresh(); },
    onError: fail,
  });
  const activate = useMutation({
    mutationFn: (world: string) => api.mcActivateWorld(server.id, world),
    onSuccess: (r) => { toast.success(r.message); refresh(); },
    onError: fail,
  });
  const regenerate = useMutation({
    mutationFn: (world: string) => api.mcRegenerateWorld(server.id, world),
    onSuccess: (r) => { toast.success(r.message); refresh(); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (world: string) => api.mcDeleteWorld(server.id, world),
    onSuccess: (r) => { toast.success(r.message); refresh(); },
    onError: fail,
  });
  const upload = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("Choose a .zip file first");
      return api.mcUploadWorld(server.id, file, uploadName);
    },
    onSuccess: (r) => {
      toast.success(r.message);
      setFile(null);
      setUploadName("");
      if (fileRef.current) fileRef.current.value = "";
      refresh();
    },
    onError: fail,
  });

  const busy = create.isPending || activate.isPending || regenerate.isPending || remove.isPending || upload.isPending;
  const data = worlds.data;

  return (
    <div className="space-y-3">
      {isRunning && (
        <Banner tone="warning" icon={<AlertTriangle className="size-3.5" />}>
          Stop the server before creating, switching, regenerating, deleting or uploading worlds.
        </Banner>
      )}

      <Panel title="Worlds" actions={data ? <span className="text-[11px] text-muted-foreground">active: <span className="font-mono">{data.active}</span></span> : null} bodyClass="p-0">
        {worlds.isPending ? (
          <div className="p-4"><Skeleton className="h-24" /></div>
        ) : worlds.isError || !data ? (
          <Empty title="Could not load worlds" hint={worlds.error instanceof Error ? worlds.error.message : "Try again shortly."} />
        ) : data.worlds.length === 0 ? (
          <div className="p-4 text-[13px] text-muted-foreground">
            No generated worlds yet. The active world <span className="font-mono">{data.active}</span> will be created the next time the server starts.
          </div>
        ) : (
          <div className="divide-y">
            {data.worlds.map((world) => (
              <div key={world.name} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <Globe className={`size-4 ${world.active ? "text-primary" : "text-muted-foreground"}`} />
                <span className="text-[13px] font-medium">{world.name}</span>
                {world.active && <Pill tone="success" dot>active</Pill>}
                <span className="text-[11px] text-muted-foreground">{bytes(world.sizeBytes)} · {when(world.modifiedAt)}</span>
                <div className="ml-auto flex flex-wrap gap-1.5">
                  {!world.active && (
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy || isRunning} onClick={() => activate.mutate(world.name)}>
                      <Play className="size-3.5" /> Activate
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busy || isRunning}
                    onClick={() => { if (window.confirm(`Regenerate '${world.name}'? The current world will be deleted and generated again on the next start.`)) regenerate.mutate(world.name); }}>
                    <RefreshCw className="size-3.5" /> Regenerate
                  </Button>
                  {!world.active && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" disabled={busy || isRunning}
                      onClick={() => { if (window.confirm(`Delete '${world.name}' permanently?`)) remove.mutate(world.name); }}>
                      <Trash2 className="size-3.5" /> Delete
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Create a new world" bodyClass="space-y-3">
          <Field label="World name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="survival-2026" className="h-9" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Seed (optional)">
              <Input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" className="h-9 font-mono text-xs" />
            </Field>
            <Field label="World type">
              <select value={levelType} onChange={(e) => setLevelType(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                {WORLD_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
          </div>
          <p className="text-[11px] text-muted-foreground">The world is generated the next time the server starts. Creating a world makes it the active world.</p>
          <Button size="sm" disabled={busy || isRunning || !name.trim()} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create world
          </Button>
        </Panel>

        <Panel title="Upload a world" bodyClass="space-y-3">
          <Field label="World archive (.zip)">
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-primary-foreground"
            />
          </Field>
          <Field label="World name (optional — defaults to the archive name)">
            <Input value={uploadName} onChange={(e) => setUploadName(e.target.value)} placeholder="imported-world" className="h-9" />
          </Field>
          <p className="text-[11px] text-muted-foreground">Zip the world folder itself (the archive must contain <span className="font-mono">level.dat</span> at its root or inside a single folder). Uploads are made active automatically. Max 4 GiB.</p>
          <Button size="sm" disabled={busy || isRunning || !file} onClick={() => upload.mutate()}>
            {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Upload &amp; activate
          </Button>
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- addons */

function AddonsTab({ server, active }: { server: MinecraftServer; active: boolean }) {
  const queryClient = useQueryClient();
  const [term, setTerm] = useState("");
  const [searchFor, setSearchFor] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const modded = MOD_TYPES.includes(server.type);
  const vanilla = server.type === "VANILLA";

  const addons = useQuery({
    queryKey: ["mc-addons", server.id],
    queryFn: () => api.mcAddons(server.id),
    enabled: active,
    refetchInterval: 20000,
    retry: 1,
  });

  const search = useQuery({
    queryKey: ["mc-addon-search", server.id, searchFor],
    queryFn: () => api.mcSearchAddons(server.id, searchFor),
    enabled: active && searchFor.length > 1 && !vanilla,
    retry: 0,
  });

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["mc-addons", server.id] }); };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Addon action failed");

  const install = useMutation({
    mutationFn: (projectId: string) => api.mcInstallAddon(server.id, projectId),
    onSuccess: (r) => { toast.success(r.message); refresh(); },
    onError: fail,
  });
  const upload = useMutation({
    mutationFn: (f: File) => api.mcUploadAddon(server.id, f),
    onSuccess: (r) => {
      toast.success(r.message);
      if (fileRef.current) fileRef.current.value = "";
      refresh();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (file: string) => api.mcDeleteAddon(server.id, file),
    onSuccess: (r) => { toast.success(r.message); refresh(); },
    onError: fail,
  });

  if (vanilla) {
    return (
      <Panel>
        <Empty
          title="Vanilla has no plugin or mod loader"
          hint="Switch the server software to Paper/Purpur (plugins) or Fabric/Forge/NeoForge (mods) from the Software tab first."
          icon={<Puzzle className="size-8" />}
        />
      </Panel>
    );
  }

  const kind = modded ? "mods" : "plugins";
  const data = addons.data;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[1fr_340px]">
        <Panel title={`Installed ${kind}`} actions={<span className="text-[11px] text-muted-foreground">{data?.installed.length ?? 0} files · restart to load</span>} bodyClass="p-0">
          {addons.isPending ? (
            <div className="p-4"><Skeleton className="h-24" /></div>
          ) : addons.isError || !data ? (
            <Empty title={`Could not load ${kind}`} hint={addons.error instanceof Error ? addons.error.message : "Try again shortly."} />
          ) : data.installed.length === 0 ? (
            <p className="p-4 text-[13px] text-muted-foreground">No {kind} installed yet. Search Modrinth below or upload a .jar file.</p>
          ) : (
            <div className="divide-y">
              {data.installed.map((item) => (
                <div key={item.name} className="flex items-center gap-2 px-4 py-2.5">
                  <Package className="size-4 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{item.name}</div>
                    <div className="text-[11px] text-muted-foreground">{bytes(item.sizeBytes)} · {when(item.modifiedAt)}</div>
                  </div>
                  <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs text-destructive" disabled={remove.isPending}
                    onClick={() => { if (window.confirm(`Remove ${item.name}?`)) remove.mutate(item.name); }}>
                    <Trash2 className="size-3.5" /> Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Upload a .jar" bodyClass="space-y-3">
          <input
            ref={fileRef}
            type="file"
            accept=".jar,application/java-archive"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); }}
            className="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-primary-foreground"
          />
          <p className="text-[11px] text-muted-foreground">
            Files are copied to <span className="font-mono">{kind}/</span>. Max 500 MiB. The server must be restarted to load new {kind}.
          </p>
          {server.runtime?.state === "running" && (
            <Banner tone="warning" icon={<AlertTriangle className="size-3.5" />}>Restart the server after installing to apply changes.</Banner>
          )}
        </Panel>
      </div>

      <Panel title={`Browse Modrinth ${kind}`} bodyClass="space-y-3">
        <div className="flex gap-2">
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && term.trim().length > 1) setSearchFor(term.trim()); }}
            placeholder={modded ? "jei, sodium, create…" : "essentialsx, luckperms, worldedit…"}
            className="h-9"
          />
          <Button size="sm" className="h-9" disabled={term.trim().length < 2} onClick={() => setSearchFor(term.trim())}>
            <Search className="size-4" /> Search
          </Button>
        </div>
        {search.isFetching && <div className="text-[12px] text-muted-foreground"><Loader2 className="mr-1 inline size-3 animate-spin" /> Searching Modrinth…</div>}
        {search.isError && <Banner tone="warning" icon={<AlertTriangle className="size-3.5" />}>{search.error instanceof Error ? search.error.message : "Search failed"}</Banner>}
        {search.data && (
          <div className="grid gap-2 md:grid-cols-2">
            {search.data.results.map((hit) => (
              <div key={hit.id} className="flex items-start gap-3 rounded-md border bg-muted/10 p-3">
                {hit.iconUrl
                  ? <img src={hit.iconUrl} alt="" className="size-9 rounded" />
                  : <span className="flex size-9 items-center justify-center rounded bg-primary/10 text-primary"><Package className="size-4" /></span>}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{hit.title}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{hit.downloads.toLocaleString()} dl</span>
                  </div>
                  <p className="line-clamp-2 text-[11px] text-muted-foreground">{hit.description}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={install.isPending} onClick={() => install.mutate(hit.id)}>
                      {install.isPending && install.variables === hit.id ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />} Install
                    </Button>
                    {hit.slug && <span className="truncate font-mono text-[10px] text-muted-foreground">{hit.slug}</span>}
                  </div>
                </div>
              </div>
            ))}
            {search.data.results.length === 0 && <p className="text-[13px] text-muted-foreground">No results for {search.data.version}.</p>}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Searching for {modded ? "mods" : "plugins"} compatible with <span className="font-mono">{server.type} {server.version}</span>. Required dependencies are not installed automatically.
        </p>
      </Panel>
    </div>
  );
}

/* ----------------------------------------------------------------- software */

function SoftwareTab({ server, active, busy, onStop }: { server: MinecraftServer; active: boolean; busy: boolean; onStop: () => void }) {
  const queryClient = useQueryClient();
  const [type, setType] = useState(server.type);
  const [version, setVersion] = useState(server.version);
  const isRunning = server.runtime?.state === "running";

  useEffect(() => { setType(server.type); setVersion(server.version); }, [server.type, server.version]);

  const catalog = useQuery({ queryKey: ["mc-catalog"], queryFn: api.mcCatalog, staleTime: 60 * 60 * 1000, enabled: active, retry: 1 });

  const change = useMutation({
    mutationFn: () => api.mcChangeSoftware(server.id, type, version),
    onSuccess: (r) => {
      toast.success(r.message);
      void queryClient.invalidateQueries({ queryKey: ["minecraft-servers"] });
      void queryClient.invalidateQueries({ queryKey: ["mc-addons", server.id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not change software"),
  });

  const types: McCatalogType[] = catalog.data?.types ?? [];
  const info = types.find((t) => t.id === type);
  const versions = info?.versions?.length ? info.versions : catalog.data?.mcVersions ?? [];
  const current = types.find((t) => t.id === server.type);

  return (
    <div className="space-y-3">
      <Panel title="Current software">
        <KV rows={[
          ["Software", `${server.type}${current ? ` — ${current.label}` : ""}`],
          ["Minecraft version", server.version],
          ["Type", current?.kind === "mods" ? "Modded (mods folder)" : current?.kind === "plugins" ? "Plugin server (plugins folder)" : "Vanilla (no plugins or mods)"],
          ["Server state", server.runtime?.state?.replace("_", " ") ?? "unknown"],
        ]} />
      </Panel>

      {isRunning && (
        <Banner tone="warning" icon={<AlertTriangle className="size-3.5" />}>
          The server must be stopped before changing software. Changing the version of an existing world can corrupt it — make a backup of the world folder first.
          <Button size="sm" variant="outline" className="ml-2 h-6 px-2 text-[11px]" disabled={busy} onClick={onStop}>Stop server</Button>
        </Banner>
      )}

      <Panel title="Choose software" bodyClass="space-y-3">
        {catalog.isPending ? <Skeleton className="h-24" /> : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {types.map((option) => (
              <button
                key={option.id}
                onClick={() => {
                  setType(option.id);
                  setVersion((prev) => (option.versions.includes(prev) ? prev : option.versions[0] ?? prev));
                }}
                className={`rounded-md border p-3 text-left transition ${type === option.id ? "border-primary bg-primary/5" : "hover:border-primary/40"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium">{option.label}</span>
                  {type === option.id && <Pill tone="primary">selected</Pill>}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {option.kind === "mods" ? "Mods" : option.kind === "plugins" ? "Plugins" : "Vanilla"} · {option.versions.length} versions
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Minecraft version">
            <select value={version} onChange={(e) => setVersion(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              {![...versions, "LATEST"].includes(version) && <option value={version}>{version} (current)</option>}
              <option value="LATEST">LATEST</option>
              {versions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="Target">
            <div className="flex h-9 items-center rounded-md border bg-muted/20 px-2 font-mono text-xs">
              {type} {version}
            </div>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={isRunning || change.isPending || (type === server.type && version === server.version)} onClick={() => change.mutate()}>
            {change.isPending ? <Loader2 className="size-4 animate-spin" /> : <Layers className="size-4" />} Apply software
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setType(server.type); setVersion(server.version); }}>Reset</Button>
          <span className="text-[11px] text-muted-foreground">The container is recreated on the next start and downloads the selected server jar.</span>
        </div>
      </Panel>
    </div>
  );
}

/* ----------------------------------------------------------------- settings */

type EditState = {
  name: string;
  description: string;
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
};

function toEdit(server: MinecraftServer): EditState {
  return {
    name: server.name,
    description: server.description ?? "",
    memory: server.memory,
    port: server.port,
    maxPlayers: server.maxPlayers,
    motd: server.motd,
    difficulty: server.difficulty,
    gamemode: server.gamemode,
    pvp: server.pvp,
    onlineMode: server.onlineMode,
    enableRcon: server.enableRcon,
    rconPassword: "",
  };
}

function SettingsTab({ server }: { server: MinecraftServer }) {
  const queryClient = useQueryClient();
  const [edit, setEdit] = useState<EditState>(() => toEdit(server));
  const isRunning = server.runtime?.state === "running";

  useEffect(() => {
    setEdit(toEdit(server));
  }, [server.id, server.name, server.description, server.memory, server.port, server.maxPlayers, server.motd, server.difficulty, server.gamemode, server.pvp, server.onlineMode, server.enableRcon]);

  const save = useMutation({
    mutationFn: () => api.mcUpdateServer(server.id, {
      name: edit.name.trim(),
      description: edit.description.trim(),
      memory: edit.memory,
      port: edit.port,
      maxPlayers: edit.maxPlayers,
      motd: edit.motd,
      difficulty: edit.difficulty,
      gamemode: edit.gamemode,
      pvp: edit.pvp,
      onlineMode: edit.onlineMode,
      enableRcon: edit.enableRcon,
      ...(edit.rconPassword ? { rconPassword: edit.rconPassword } : {}),
    }),
    onSuccess: () => {
      toast.success("Settings saved. The container is recreated on the next start.");
      void queryClient.invalidateQueries({ queryKey: ["minecraft-servers"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not save settings"),
  });

  return (
    <div className="space-y-3">
      {isRunning && (
        <Banner tone="warning" icon={<AlertTriangle className="size-3.5" />}>
          Stop the server before changing settings. Saving recreates the container, so changes apply on the next start.
        </Banner>
      )}

      <Panel title="General" bodyClass="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className="h-9" /></Field>
          <Field label="Description"><Input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} className="h-9" /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Memory">
            <select value={edit.memory} onChange={(e) => setEdit({ ...edit, memory: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              {MEMORIES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Port"><Input type="number" value={edit.port} onChange={(e) => setEdit({ ...edit, port: Number(e.target.value) })} className="h-9" /></Field>
          <Field label="Max players"><Input type="number" value={edit.maxPlayers} onChange={(e) => setEdit({ ...edit, maxPlayers: Number(e.target.value) })} className="h-9" /></Field>
        </div>
      </Panel>

      <Panel title="Gameplay" bodyClass="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="MOTD"><Input value={edit.motd} onChange={(e) => setEdit({ ...edit, motd: e.target.value })} className="h-9" /></Field>
          <Field label="Difficulty">
            <select value={edit.difficulty} onChange={(e) => setEdit({ ...edit, difficulty: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              {DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Game mode">
            <select value={edit.gamemode} onChange={(e) => setEdit({ ...edit, gamemode: e.target.value })} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              {GAMEMODES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-3">
          <Toggle label="PvP" checked={edit.pvp} onChange={(v) => setEdit({ ...edit, pvp: v })} />
          <Toggle label="Online mode" checked={edit.onlineMode} onChange={(v) => setEdit({ ...edit, onlineMode: v })} />
          <Toggle label="RCON console" checked={edit.enableRcon} onChange={(v) => setEdit({ ...edit, enableRcon: v })} />
        </div>
      </Panel>

      <Panel title="Access" bodyClass="space-y-3">
        <Field label="New RCON password (leave blank to keep the current one)">
          <Input type="password" value={edit.rconPassword} onChange={(e) => setEdit({ ...edit, rconPassword: e.target.value })}
            placeholder={server.rconConfigured ? "configured — leave blank to keep" : "auto-generated"} className="h-9" />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={isRunning || save.isPending || edit.name.trim().length < 2} onClick={() => save.mutate()}>
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save settings
          </Button>
          <Button variant="outline" onClick={() => setEdit(toEdit(server))}>Reset</Button>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------- danger */

function DangerTab({ server, onDeleted }: { server: MinecraftServer; onDeleted: () => void }) {
  const remove = useMutation({
    mutationFn: (withData: boolean) => api.mcDeleteServer(server.id, withData),
    onSuccess: (_r, withData) => {
      toast.success(withData ? "Server and world data deleted" : "Server deleted (world kept)");
      onDeleted();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not delete server"),
  });

  return (
    <Panel title="Danger zone" bodyClass="space-y-3">
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-[13px]">
        <div className="mb-1 flex items-center gap-2 font-medium text-destructive"><AlertTriangle className="size-4" /> Delete this server</div>
        <p className="text-muted-foreground">The container is removed immediately. The world folder is kept unless you choose the destructive option.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={remove.isPending}
          onClick={() => { if (window.confirm(`Delete ${server.name}? World data will be kept on disk.`)) remove.mutate(false); }}>
          {remove.isPending && remove.variables === false ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />} Delete server
        </Button>
        <Button variant="destructive" disabled={remove.isPending}
          onClick={() => { if (window.confirm(`Delete ${server.name} AND all world data? This cannot be undone.`)) remove.mutate(true); }}>
          {remove.isPending && remove.variables === true ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete server + data
        </Button>
        <span className="text-xs text-muted-foreground">ID: <span className="font-mono">{server.id}</span></span>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ helpers */

function Banner({ children, tone = "muted", icon }: { children: ReactNode; tone?: "muted" | "warning"; icon?: ReactNode }) {
  const cls = tone === "warning"
    ? "border-warning/30 bg-warning/10 text-warning"
    : "border-border bg-muted/30 text-muted-foreground";
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-md border p-2.5 text-xs ${cls}`}>
      {icon}<span className="flex-1">{children}</span>
    </div>
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


/* --------------------------------------------------------------- backups */

function BackupsTab({ server, active }: { server: MinecraftServer; active: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["mc-backup", server.id],
    queryFn: () => api.mcBackupStatus(server.id),
    enabled: active,
    refetchInterval: active ? 10_000 : false,
  });
  const initialized = useRef(false);
  const [token, setToken] = useState("");
  const [folder, setFolder] = useState("KDG Minecraft Backups");
  const [keepLast, setKeepLast] = useState(6);
  const [restoreOnStart, setRestoreOnStart] = useState(true);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const s = status.data;
    if (!s || initialized.current) return;
    initialized.current = true;
    setFolder(s.folder || "KDG Minecraft Backups");
    setKeepLast(s.keepLast || 6);
    setRestoreOnStart(s.restoreOnStart);
    setEnabled(s.enabled);
  }, [status.data]);

  const invalidateStatus = () => queryClient.invalidateQueries({ queryKey: ["mc-backup", server.id] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Backup action failed");

  const connect = useMutation({
    mutationFn: () =>
      api.mcBackupConnect(server.id, { token: token.trim(), folder: folder.trim() || undefined, keepLast, restoreOnStart }),
    onSuccess: () => { toast.success("Google Drive connected — world will back up every 10 minutes"); setToken(""); void invalidateStatus(); },
    onError: fail,
  });
  const disconnect = useMutation({
    mutationFn: () => api.mcBackupDisconnect(server.id),
    onSuccess: () => { toast.success("Google Drive disconnected (drive folder kept)"); void invalidateStatus(); },
    onError: fail,
  });
  const save = useMutation({
    mutationFn: () =>
      api.mcBackupSettings(server.id, { enabled, keepLast, restoreOnStart, folder: folder.trim() || undefined }),
    onSuccess: () => { toast.success("Backup settings saved"); void invalidateStatus(); },
    onError: fail,
  });
  const run = useMutation({
    mutationFn: () => api.mcBackupRun(server.id),
    onSuccess: (r) => {
      const mb = (r.sizeBytes / 1024 / 1024).toFixed(1);
      toast.success(r.uploaded
        ? `Backup saved${r.savedWorld ? " (world flushed)" : ""} and uploaded to Drive (${mb} MiB)`
        : `Backup saved locally (${mb} MiB) — Drive not connected`);
      void invalidateStatus();
    },
    onError: fail,
  });
  const restore = useMutation({
    mutationFn: () => api.mcBackupRestore(server.id),
    onSuccess: (r) => { toast.success(`World restored from Drive${r.stashedTo ? " (local world stashed under backups/)" : ""}`); void invalidateStatus(); },
    onError: fail,
  });

  const s = status.data;
  const lastBackup = s?.lastRunIso ? new Date(s.lastRunIso).toLocaleString() : "never";

  if (status.isPending) return <Skeleton className="h-56 w-full" />;

  if (s && !s.authorized) {
    return (
      <Panel title="Connect Google Drive" bodyClass="space-y-3">
        <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-[12px] text-muted-foreground">
          World is saved with <code>save-all flush</code>, tarred and uploaded to your Drive every 10 minutes,
          plus before every stop/restart — no OAuth clicks for everyday use.
        </div>
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-muted-foreground">
          <li>Install rclone on any PC: <code>curl https://rclone.org/install.sh | sudo bash</code> (or your package manager / WSL).</li>
          <li>Run <code>rclone authorize "drive"</code> and sign in to Google — this is the only browser step.</li>
          <li>Copy the printed <code>{"{ "}"access_token"{": ... }"}</code> JSON and paste it below.</li>
        </ol>
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          rows={4}
          className="w-full rounded-md border bg-background p-2 font-mono text-[11px] leading-snug"
          placeholder='{"access_token":"ya29....","token_type":"Bearer","refresh_token":"1//..."}'
        />
        <div className="grid gap-2 sm:grid-cols-3">
          <div>
            <label className="label-caps">Drive folder</label>
            <Input value={folder} onChange={(e) => setFolder(e.target.value)} className="mt-1 h-9" placeholder="KDG Minecraft Backups" />
          </div>
          <div>
            <label className="label-caps">Keep last (backups)</label>
            <Input type="number" min={1} max={100} value={keepLast} onChange={(e) => setKeepLast(Math.max(1, Number(e.target.value) || 1))} className="mt-1 h-9" />
          </div>
          <div className="flex flex-col justify-end gap-1.5">
            <Toggle label="Restore on start" checked={restoreOnStart} onChange={setRestoreOnStart} />
          </div>
        </div>
        <Button disabled={connect.isPending || token.trim().length < 10} onClick={() => connect.mutate()}>
          {connect.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Cloud className="mr-2 size-4" />}Connect &amp; verify
        </Button>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>The token is stored on this node only (<code>0600</code>) and never shown again. Backups go to <code>{folder || "KDG Minecraft Backups"}/&lt;server-id&gt;/</code> in your Drive.</p>
          <p className="text-warning"><AlertTriangle className="mr-1 inline size-3" />Power note: on charger-pull or shutdown an emergency <code>save-all</code> flushes to local disk only — the Drive upload happens on the next 10-minute tick or boot. This laptop&apos;s battery is at 0%, so unplugging is an instant hard cut (CMOS cell is dead). Replace the coin cell + battery pack or attach a UPS.</p>
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <Panel
        title={<span className="flex items-center gap-2"><Cloud className="size-4 text-primary" /> Google Drive backups</span>}
        actions={<Pill tone="success" dot>Drive connected</Pill>}
        bodyClass="space-y-3"
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: "Autosave", value: "10 min" },
            { label: "Keep last", value: String(s?.keepLast ?? 6) },
            { label: "Local tarballs", value: String(s?.localTarballs ?? 0) },
            { label: "Total backups", value: String(s?.totalBackups ?? 0) },
          ].map((stat) => (
            <div key={stat.label} className="rounded-md border bg-muted/30 p-2 text-center">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{stat.label}</div>
              <div className="mt-0.5 font-mono text-sm">{stat.value}</div>
            </div>
          ))}
        </div>
        <KV rows={[
          ["Restore on start", s?.restoreOnStart ? "on — the world is replaced with the newest Drive snapshot on every start" : "off"],
          ["Drive folder", s?.remoteFolder ?? "—"],
          ["Last backup", s ? `${lastBackup}${s.lastResult ? ` · ${s.lastResult}` : ""}` : "—"],
          ["Last error", s?.lastError || "none"],
        ]} />
        <div className="space-y-1 text-[11px] text-warning">
          <p><AlertTriangle className="mr-1 inline size-3" />Restore on start rewinds to the newest Drive snapshot on every start and dashboard restart — progress not yet backed up is lost.</p>
          <p><AlertTriangle className="mr-1 inline size-3" />Timer (<code>kdg-mc-backup.timer</code>) backs up every 10 min; stop/restart backs up first. Emergency charger-pull/shutdown saves hit local disk only.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending}>
            {run.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Cloud className="mr-2 size-4" />}Backup now
          </Button>
          <Button size="sm" variant="outline" disabled={restore.isPending} onClick={() => {
            if (window.confirm("Replace the current world with the newest Drive backup? The local world is stashed first under backups/.")) restore.mutate();
          }}>
            {restore.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}Restore latest
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" disabled={disconnect.isPending} onClick={() => {
            if (window.confirm("Disconnect Google Drive? Local tarballs are kept; the Drive folder stays in your Drive.")) disconnect.mutate();
          }}>
            {disconnect.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}Disconnect Drive
          </Button>
        </div>
      </Panel>

      <Panel title="Backup settings" bodyClass="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <div>
            <label className="label-caps">Drive folder</label>
            <Input value={folder} onChange={(e) => setFolder(e.target.value)} className="mt-1 h-9" />
          </div>
          <div>
            <label className="label-caps">Keep last</label>
            <Input type="number" min={1} max={100} value={keepLast} onChange={(e) => setKeepLast(Math.max(1, Number(e.target.value) || 1))} className="mt-1 h-9" />
          </div>
          <div className="flex flex-col justify-end gap-1.5">
            <Toggle label="Restore on start" checked={restoreOnStart} onChange={setRestoreOnStart} />
            <Toggle label="Enabled (10 min autosave)" checked={enabled} onChange={setEnabled} />
          </div>
        </div>
        <Button size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}Save settings
        </Button>
      </Panel>
    </div>
  );
}
