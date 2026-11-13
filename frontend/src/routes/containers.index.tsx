import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, RotateCw, Search, Square } from "lucide-react";
import { api, type ContainerInfo } from "@/services/api/client";
import { PageHeader, Status, TableWrap, th, td, tr, Empty } from "@/components/kdg/primitives";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export const Route = createFileRoute("/containers/")({
  head: () => ({
    meta: [
      { title: "Containers · KDG Cloud" },
      { name: "description", content: "Docker containers running on the KDG node." },
      { property: "og:title", content: "Containers · KDG Cloud" },
      { property: "og:description", content: "Live Docker inventory from the KDG host." },
    ],
  }),
  component: ContainersPage,
});

function statusFor(c: ContainerInfo): "running" | "stopped" | "unhealthy" | "restarting" {
  const state = c.state.toLowerCase();
  if (state === "running") return "running";
  if (state === "restarting") return "restarting";
  if (["exited", "dead", "created"].includes(state)) return "stopped";
  return "unhealthy";
}

function ContainersPage() {
  const queryClient = useQueryClient();
  const { data: list = [], isPending, isError, error } = useQuery({
    queryKey: ["containers"],
    queryFn: api.containers,
    refetchInterval: 10000,
  });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const action = useMutation({
    mutationFn: ({ name, act }: { name: string; act: "start" | "stop" | "restart" }) => api.containerAction(name, act),
    onMutate: ({ name }) => { setBusy(name); setActionError(null); },
    onError: (e) => setActionError(e instanceof Error ? e.message : "Container action failed"),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["containers"] }); },
    onSettled: () => setBusy(null),
  });

  const rows = useMemo(
    () =>
      list
        .filter((c) => filter === "all" || statusFor(c) === filter)
        .filter((c) => (c.name + c.image + c.id).toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [list, q, filter],
  );

  const running = list.filter((c) => statusFor(c) === "running").length;

  const runAction = (name: string, act: "start" | "stop" | "restart") => {
    const labels = { start: "Start", stop: "Stop", restart: "Restart" } as const;
    if (!window.confirm(`${labels[act]} container "${name}"?`)) return;
    action.mutate({ name, act });
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Containers"
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Live Docker inventory
          </span>
        }
        description={`${running} running · ${list.length} total · refreshes every 10 seconds`}
      />
      {actionError && <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div>}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:w-72">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, image or ID" className="h-9 pl-8" />
        </div>
        <ToggleGroup type="single" value={filter} onValueChange={(v) => v && setFilter(v)} variant="outline" size="sm">
          {["all", "running", "stopped", "restarting", "unhealthy"].map((f) => (
            <ToggleGroupItem key={f} value={f} className="capitalize px-3">{f}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <TableWrap>
        {isPending ? (
          <div className="p-5 text-sm text-muted-foreground">Loading Docker inventory…</div>
        ) : isError ? (
          <Empty title="Docker inventory unavailable" hint={error instanceof Error ? error.message : "The API request failed."} />
        ) : rows.length === 0 ? (
          <Empty title="No containers match" hint="The Docker API returned no matching containers." />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40">
              <tr>
                <th className={th}>Name</th>
                <th className={th}>Image</th>
                <th className={th}>State</th>
                <th className={th}>Docker status</th>
                <th className={th}>Container ID</th>
                <th className={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const st = statusFor(c);
                const isBusy = busy === c.name;
                return (
                  <tr key={c.id} className={tr}>
                    <td className={td}>
                      <Link to="/containers/$id" params={{ id: c.id }} className="font-medium hover:text-primary">{c.name}</Link>
                    </td>
                    <td className={`${td} max-w-[320px] truncate font-mono text-xs`} title={c.image}>{c.image}</td>
                    <td className={td}><Status value={st} /></td>
                    <td className={`${td} text-xs text-muted-foreground`}>{c.status || "—"}</td>
                    <td className={`${td} font-mono text-xs text-muted-foreground`}>{c.id}</td>
                    <td className={td}>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={isBusy || st === "running"} onClick={() => runAction(c.name, "start")} title="Start"><Play className="size-3.5" /></Button>
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={isBusy || st === "stopped"} onClick={() => runAction(c.name, "stop")} title="Stop"><Square className="size-3.5" /></Button>
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={isBusy} onClick={() => runAction(c.name, "restart")} title="Restart"><RotateCw className="size-3.5" /></Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </TableWrap>
      <p className="mt-2 text-xs text-muted-foreground">
        Start/stop/restart actions require owner/admin role and are executed server-side via Docker CLI (socket proxy remains read-only). All containers are configured with restart policy <code>unless-stopped</code>.
      </p>
    </div>
  );
}
