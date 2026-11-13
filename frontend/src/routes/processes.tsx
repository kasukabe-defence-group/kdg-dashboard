import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Search, Skull } from "lucide-react";
import { processesQuery } from "@/services/api/queries";
import { api } from "@/services/api/client";
import { PageHeader, TableWrap, th, td, tr, Pill, Stat } from "@/components/kdg/primitives";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const Route = createFileRoute("/processes")({
  head: () => ({
    meta: [
      { title: "Processes · KDG Cloud" },
      { name: "description", content: "Live process list for the KDG node." },
      { property: "og:title", content: "Processes · KDG Cloud" },
      { property: "og:description", content: "Processes reported by the KDG host." },
    ],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(processesQuery("memory"));
    } catch {
      // SSR may run without a session cookie; client fetch will handle auth.
    }
  },
  component: ProcessesPage,
});

const stateLabel = {
  R: "running",
  S: "sleeping",
  D: "disk wait",
  Z: "zombie",
  I: "idle",
} as const;

function ProcessesPage() {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery({
    ...processesQuery("memory"),
    refetchInterval: 5000,
  });
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"cpu" | "mem" | "pid">("cpu");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);

  const kill = useMutation({
    mutationFn: ({ pid, signal }: { pid: number; signal: "TERM" | "KILL" }) => api.signalProcess(pid, signal),
    onMutate: ({ pid }) => { setBusyPid(pid); setActionError(null); },
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to signal process"),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["processes"] }); },
    onSettled: () => setBusyPid(null),
  });

  const rows = useMemo(
    () =>
      [...data]
        .filter((p) => (p.name + p.user + p.command + p.pid + (p.owner ?? "")).toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) =>
          sort === "cpu"
            ? b.cpu - a.cpu
            : sort === "mem"
              ? b.rssMiB - a.rssMiB
              : a.pid - b.pid,
        ),
    [data, q, sort],
  );

  const totalCpu = data.reduce((sum, p) => sum + p.cpu, 0);
  const totalRss = data.reduce((sum, p) => sum + p.rssMiB, 0);

  const onKill = (pid: number, name: string, force = false) => {
    const sig = force ? "KILL" : "TERM";
    const label = force ? "force kill (SIGKILL)" : "terminate (SIGTERM)";
    if (!window.confirm(`${label} process ${pid} (${name})?`)) return;
    kill.mutate({ pid, signal: sig });
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Processes"
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Live host process list
          </span>
        }
        description={`${rows.length} matching processes · refreshes every 5 seconds`}
      />
      {actionError && <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div>}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Processes" value={data.length} />
        <Stat label="CPU (sum)" value={`${totalCpu.toFixed(1)}%`} meter={Math.min(100, totalCpu)} />
        <Stat label="Resident memory" value={`${(totalRss / 1024).toFixed(2)} GiB`} />
        <Stat label="Attributed to users" value={data.filter((p) => p.owner).length} sub="processes with a dashboard owner" />
      </div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, user, PID" className="h-9 pl-8" />
        </div>
        <ToggleGroup type="single" value={sort} onValueChange={(v) => v && setSort(v as typeof sort)} variant="outline" size="sm">
          <ToggleGroupItem value="cpu">CPU</ToggleGroupItem>
          <ToggleGroupItem value="mem">Memory</ToggleGroupItem>
          <ToggleGroupItem value="pid">PID</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <TableWrap className="overflow-x-auto">
        <table className="w-full min-w-[1200px] text-[13px]">
          <thead>
            <tr>
              {["PID", "Name", "User", "Owner", "State", "CPU %", "Mem %", "RSS", "Read/Write", "Unit", "Actions"].map((h) => (
                <th key={h} className={`${th} ${h === "Actions" ? "sticky right-0 bg-muted/40 backdrop-blur" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pid} className={tr}>
                <td className={`${td} tabular text-muted-foreground`}>{p.pid}</td>
                <td className={td}>
                  <div className="font-medium">{p.name}</div>
                  <div className="max-w-[280px] truncate font-mono text-[11px] text-muted-foreground" title={p.command}>{p.command}</div>
                </td>
                <td className={td}>{p.user}</td>
                <td className={td}>
                  {p.owner ? <Pill tone="primary">{p.owner}</Pill> : <span className="text-muted-foreground">—</span>}
                </td>
                <td className={td}>
                  <Pill tone={p.status === "R" ? "success" : p.status === "D" ? "warning" : p.status === "Z" ? "destructive" : "muted"}>
                    {stateLabel[p.status]}
                  </Pill>
                </td>
                <td className={`${td} tabular`}>{p.cpu.toFixed(1)}</td>
                <td className={`${td} tabular`}>{p.memPercent.toFixed(1)}</td>
                <td className={`${td} tabular`}>{p.rssMiB} MiB</td>
                <td className={`${td} tabular text-muted-foreground`}>{p.readKBs} / {p.writeKBs} KB/s</td>
                <td className={`${td} text-muted-foreground`}>{p.unit ?? p.cgroup}</td>
                <td className={`${td} sticky right-0 bg-card`}>
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={busyPid === p.pid} onClick={() => onKill(p.pid, p.name, false)} title="Terminate (SIGTERM)">Kill</Button>
                    <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={busyPid === p.pid} onClick={() => onKill(p.pid, p.name, true)} title="Force kill (SIGKILL)"><Skull className="size-3.5" /> Force</Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
      <p className="mt-2 text-xs text-muted-foreground">
        Process kill actions are restricted to owner/admin roles and enforced by the backend. "Run process" is not exposed as arbitrary execution.
      </p>
    </div>
  );
}
