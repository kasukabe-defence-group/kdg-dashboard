import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Activity, AlertTriangle, Cpu, Gamepad2, KeyRound, Link2, MemoryStick, Plus, Server, ShieldCheck,
  UserRound, Users as UsersIcon, Zap,
} from "lucide-react";
import { api } from "@/services/api/client";
import { usersUsageQuery } from "@/services/api/queries";
import { PageHeader, Panel, Pill, Stat, Meter, Empty, TableWrap, th, td, tr, toneFor } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { UserUsageEntry } from "@/types";
import { toast } from "sonner";

export const Route = createFileRoute("/user-usage")({
  head: () => ({
    meta: [
      { title: "User resources · KDG Cloud" },
      { name: "description", content: "Per-user CPU, RAM, GPU/VRAM and process attribution across the KDG node." },
    ],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(usersUsageQuery);
    } catch {
      // SSR without a session: the client will fetch after hydration.
    }
  },
  component: UserUsagePage,
});

const roleTone: Record<string, "success" | "warning" | "muted" | "info"> = {
  owner: "success",
  admin: "warning",
  moderator: "muted",
  member: "muted",
  external: "info",
};

const sourceLabel: Record<string, string> = {
  terminal: "KDG terminal",
  "container-label": "container label",
  pattern: "name match",
  "os-account": "OS account",
  manual: "manual",
  registry: "registry",
};

const mib = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(2)} GiB` : `${n.toFixed(0)} MiB`);

function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

function UserUsagePage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error } = useQuery(usersUsageQuery);
  const [assignFor, setAssignFor] = useState<UserUsageEntry | null>(null);
  const [kind, setKind] = useState<"container" | "pattern" | "os" | "pid">("pattern");
  const [key, setKey] = useState("");

  const assign = useMutation({
    mutationFn: () => api.assignUserUsage(kind, key.trim(), assignFor?.username ?? ""),
    onSuccess: () => {
      toast.success(`Attributed “${key.trim()}” to ${assignFor?.displayName}`);
      setAssignFor(null);
      setKey("");
      void queryClient.invalidateQueries({ queryKey: ["users-usage"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not assign attribution"),
  });

  const totals = useMemo(() => {
    const users = data?.users ?? [];
    return {
      cpu: users.reduce((s, u) => s + u.cpuPercent, 0),
      mem: users.reduce((s, u) => s + u.memMiB, 0),
      gpu: users.reduce((s, u) => s + u.gpuMiB, 0),
      procs: users.reduce((s, u) => s + u.processCount, 0),
    };
  }, [data]);

  if (isPending) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-3">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        <div className="grid gap-3 lg:grid-cols-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-64" />)}</div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto max-w-[1400px]">
        <PageHeader title="User resources" description="Per-user CPU, RAM, GPU and process attribution." />
        <Empty title="Could not load user usage" hint={error instanceof Error ? error.message : "Request failed"} icon={<AlertTriangle className="size-6" />} />
      </div>
    );
  }

  const host = data.host;
  const gpu = data.gpu;
  const memUsed = Math.max(host.memUsedMiB, 1);
  const vramTotal = Math.max(gpu.vramTotalMiB, 1);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="User resources"
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">
            <Activity className="size-3.5" /> live · 10s
          </span>
        }
        description="Who is using CPU, RAM, GPU/VRAM and which processes belong to them. Attribution comes from KDG terminal sessions, container labels and explicit admin assignments — never guessed."
        actions={
          <Button variant="outline" size="sm" onClick={() => { void queryClient.invalidateQueries({ queryKey: ["users-usage"] }); }}>
            Refresh
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Attributed CPU" value={`${totals.cpu.toFixed(1)}%`} sub={`host ${host.cpuPercent.toFixed(1)}% · ${host.cpuCount} cores`} meter={Math.min(100, (totals.cpu / Math.max(host.cpuCount * 100, 1)) * 100)} icon={<Cpu className="size-4" />} />
        <Stat label="Attributed RAM" value={mib(totals.mem)} sub={`${((totals.mem / host.memTotalMiB) * 100).toFixed(1)}% of ${mib(host.memTotalMiB)}`} meter={(totals.mem / host.memTotalMiB) * 100} icon={<MemoryStick className="size-4" />} />
        <Stat label="Attributed VRAM" value={gpu.vramTotalMiB ? mib(totals.gpu) : "No GPU"} sub={gpu.vramTotalMiB ? `${gpu.name} · ${gpu.utilPercent}% util` : "nvidia-smi unavailable"} meter={(totals.gpu / vramTotal) * 100} icon={<Zap className="size-4" />} />
        <Stat label="Attributed processes" value={totals.procs} sub={`${data.unattributed.processCount} host processes unattributed`} icon={<Server className="size-4" />} />
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title={<span className="flex items-center gap-2"><UsersIcon className="size-4" /> Per-user usage</span>} bodyClass="p-0">
          {data.users.length === 0 ? (
            <Empty title="No dashboard users" hint="Create dashboard users to attribute workloads." />
          ) : (
            <div className="grid gap-3 p-3 md:grid-cols-2">
              {data.users.map((u) => (
                <UserCard key={u.username} user={u} memUsed={memUsed} vramTotal={vramTotal} onAssign={() => { setAssignFor(u); setKind("pattern"); setKey(""); }} />
              ))}
            </div>
          )}
        </Panel>

        <div className="space-y-3">
          <Panel title={<span className="flex items-center gap-2"><Gamepad2 className="size-4" /> GPU processes</span>} bodyClass="p-0">
            {data.gpuProcesses.length === 0 ? (
              <Empty title="No GPU processes right now" hint="When a workload allocates VRAM it appears here with its owner." />
            ) : (
              <ul className="divide-y">
                {data.gpuProcesses.map((p) => (
                  <li key={p.pid} className="flex items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">PID {p.pid} · {mib(p.vramMiB)} VRAM</div>
                    </div>
                    {p.owner ? <Pill tone="primary">{p.owner}</Pill> : <Pill tone="muted">unattributed</Pill>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={<span className="flex items-center gap-2"><AlertTriangle className="size-4" /> Unattributed host usage</span>}>
            <p className="mb-3 text-xs text-muted-foreground">
              System daemons and workloads without an ownership signal are reported here instead of being guessed. Assign a container label, name pattern or PID to make them visible.
            </p>
            <div className="grid grid-cols-2 gap-3 text-[13px]">
              <div><div className="label-caps">Processes</div><div className="text-lg font-semibold tabular">{data.unattributed.processCount}</div></div>
              <div><div className="label-caps">RAM</div><div className="text-lg font-semibold tabular">{mib(data.unattributed.memMiB)}</div></div>
              <div><div className="label-caps">CPU</div><div className="text-lg font-semibold tabular">{data.unattributed.cpuPercent.toFixed(1)}%</div></div>
              <div><div className="label-caps">VRAM</div><div className="text-lg font-semibold tabular">{mib(data.unattributed.gpuMiB)}</div></div>
            </div>
            <div className="mt-3 rounded-md border border-dashed border-border bg-muted/30 p-2.5 text-[11px] text-muted-foreground">
              Attribution sources: <b>container label</b> (kdg.owner), <b>KDG terminal</b> sessions, <b>name pattern</b>, <b>OS account</b>, <b>manual</b>.
            </div>
          </Panel>

          <Panel title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" /> API keys by user</span>} bodyClass="p-0">
            <ul className="divide-y">
              {data.users.filter((u) => u.apiKeys.length > 0).map((u) => (
                <li key={u.username} className="px-4 py-2.5 text-[13px]">
                  <div className="mb-1 flex items-center justify-between"><span className="font-medium">{u.displayName}</span><Pill tone={roleTone[u.role] ?? "muted"}>{u.role}</Pill></div>
                  {u.apiKeys.map((k) => (
                    <div key={k.id} className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5 truncate"><KeyRound className="size-3" /> {k.name} <span className="font-mono">{k.prefix}…</span></span>
                      <span className="flex items-center gap-2">
                        <Pill tone={k.enabled ? "success" : "destructive"}>{k.enabled ? "enabled" : "disabled"}</Pill>
                        <span className="tabular">{k.usageCount} calls</span>
                      </span>
                    </div>
                  ))}
                </li>
              ))}
              {data.users.every((u) => u.apiKeys.length === 0) && <li className="px-4 py-6 text-center text-xs text-muted-foreground">No user-owned API keys.</li>}
            </ul>
          </Panel>
        </div>
      </div>

      <TableWrap>
        <div className="border-b px-4 py-2.5 text-[13px] font-medium">All attributed processes</div>
        <table className="w-full min-w-[900px] text-[13px]">
          <thead className="bg-muted/40">
            <tr>{["Process", "Owner", "Attribution", "CPU %", "RSS", "VRAM", "PID"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {data.users.flatMap((u) => u.processes.map((p) => ({ ...p, owner: u.displayName, role: u.role }))).slice(0, 120).map((p) => (
              <tr key={`${p.owner}-${p.pid}`} className={tr}>
                <td className={td}><div className="font-medium">{p.name}</div><div className="max-w-[360px] truncate font-mono text-[11px] text-muted-foreground" title={p.command}>{p.command}</div></td>
                <td className={td}><Pill tone={roleTone[p.role] ?? "muted"}>{p.owner}</Pill></td>
                <td className={`${td} text-muted-foreground`}>{sourceLabel[p.source] ?? p.source}</td>
                <td className={`${td} tabular`}>{p.cpu.toFixed(1)}</td>
                <td className={`${td} tabular`}>{mib(p.rssMiB)}</td>
                <td className={`${td} tabular`}>{p.gpuMiB ? <Pill tone="primary">{mib(p.gpuMiB)}</Pill> : "—"}</td>
                <td className={`${td} tabular text-muted-foreground`}>{p.pid}</td>
              </tr>
            ))}
            {totals.procs === 0 && (
              <tr><td className="px-4 py-8 text-center text-sm text-muted-foreground" colSpan={7}>No attributed processes yet. Start a KDG terminal session or assign a container/pattern.</td></tr>
            )}
          </tbody>
        </table>
      </TableWrap>

      <Dialog open={!!assignFor} onOpenChange={(o) => !o && setAssignFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Attribute a workload to {assignFor?.displayName}</DialogTitle>
            <DialogDescription>
              Pick the evidence to match. Container labels are strongest; name patterns match process name or command line (case-insensitive).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="label-caps">Match type</label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
                className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="pattern">Process name pattern</option>
                <option value="container">Container name</option>
                <option value="os">OS account</option>
                <option value="pid">Live PID</option>
              </select>
            </div>
            <div>
              <label className="label-caps">Value</label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={kind === "pid" ? "e.g. 12345" : kind === "container" ? "e.g. jupyterlab" : kind === "os" ? "e.g. parth" : "e.g. jupyter-lab"}
                className="mt-1 h-9"
              />
            </div>
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              <Link2 className="mt-0.5 size-3.5 shrink-0" />
              <span>{assignFor?.displayName} will then be shown as the owner of matching CPU, RAM and VRAM in this page and on the Processes page.</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignFor(null)}>Cancel</Button>
            <Button disabled={!key.trim() || assign.isPending} onClick={() => assign.mutate()}>
              <Plus className="size-4" /> Assign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UserCard({ user, memUsed, vramTotal, onAssign }: { user: UserUsageEntry; memUsed: number; vramTotal: number; onAssign: () => void }) {
  const memShare = (user.memMiB / memUsed) * 100;
  const gpuShare = (user.gpuMiB / vramTotal) * 100;
  const live = user.activeSessions > 0;
  return (
    <div className="rounded-lg border bg-card p-3.5">
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div className="relative flex size-9 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {initials(user.displayName)}
            {live && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-card bg-success" />}
          </div>
          <div>
            <div className="flex items-center gap-2 text-[13px] font-semibold">{user.displayName}<Pill tone={roleTone[user.role] ?? "muted"}>{user.role}</Pill></div>
            <div className="text-[11px] text-muted-foreground">
              {live ? `${user.activeSessions} active session${user.activeSessions > 1 ? "s" : ""}` : "no active session"}
              {user.lastLogin ? ` · last login ${new Date(user.lastLogin).toLocaleString()}` : ""}
            </div>
          </div>
        </div>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onAssign}><Link2 className="size-3.5" /> Assign</Button>
      </div>

      <div className="space-y-2">
        <div>
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">CPU</span><span className="tabular">{user.cpuPercent.toFixed(1)}%</span></div>
          <Meter value={Math.min(100, user.cpuPercent)} />
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">RAM</span><span className="tabular">{mib(user.memMiB)} · {memShare.toFixed(0)}%</span></div>
          <Meter value={memShare} />
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px]"><span className="text-muted-foreground">GPU / VRAM</span><span className="tabular">{user.gpuMiB ? `${mib(user.gpuMiB)} · ${gpuShare.toFixed(0)}%` : "—"}</span></div>
          <Meter value={gpuShare} tone={user.gpuMiB ? "primary" : "muted"} />
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {user.gpuProcessCount > 0 && <Pill tone="primary" dot>{user.gpuProcessCount} GPU process{user.gpuProcessCount > 1 ? "es" : ""}</Pill>}
        {user.containers.map((c) => <Pill key={c.name} tone={toneFor(c.state)} dot>{c.name}</Pill>)}
        {user.apiKeys.length > 0 && <Pill tone="info"><KeyRound className="size-3" /> {user.apiKeys.length} key{user.apiKeys.length > 1 ? "s" : ""}</Pill>}
        {user.processCount > 0 && <Pill tone="muted"><UserRound className="size-3" /> {user.processCount} procs</Pill>}
        {user.processCount === 0 && user.containers.length === 0 && <span className="text-[11px] text-muted-foreground">No attributed workloads.</span>}
      </div>

      {user.processes.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {user.processes.slice(0, 4).map((p) => (
            <li key={p.pid} className="flex items-center justify-between gap-2 rounded border border-border/60 bg-muted/20 px-2 py-1 text-[11px]">
              <span className="truncate font-medium">{p.name}{p.gpuMiB ? <span className="ml-1 text-primary">GPU</span> : null}</span>
              <span className="shrink-0 text-muted-foreground tabular">{p.gpuMiB ? `${mib(p.gpuMiB)} VRAM · ` : ""}{mib(p.rssMiB)}</span>
            </li>
          ))}
          {user.processes.length > 4 && <li className="text-[11px] text-muted-foreground">+{user.processes.length - 4} more</li>}
        </ul>
      )}
    </div>
  );
}
