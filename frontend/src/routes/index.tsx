import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  ArrowDownUp,
  Container as ContainerIcon,
  AppWindow,
  Users,
  Thermometer,
  ArrowUpRight,
  Folder,
  Gamepad2,
  FlaskConical,
} from "lucide-react";

import { metricsHistoryQuery, overviewQuery, usersUsageQuery } from "@/services/api/queries";
import { api, type ContainerInfo } from "@/services/api/client";
import {
  PageHeader,
  Panel,
  Pill,
  Stat,
  Status,
  toneFor,
  Meter,
  Empty,
} from "@/components/kdg/primitives";
import { MetricChart } from "@/components/charts/area-chart";
import { pct, uptime } from "@/utils/format";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard · KDG Cloud" },
      {
        name: "description",
        content: "Infrastructure overview for your KDG private cloud node.",
      },
      { property: "og:title", content: "Dashboard · KDG Cloud" },
      {
        property: "og:description",
        content: "Infrastructure overview for your KDG private cloud node.",
      },
    ],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(overviewQuery);
    } catch {
      // SSR may run without a session cookie; client fetch will handle auth.
    }
  },
  component: Dashboard,
});

type ExtendedOverview = {
  dataDiskUsedGiB?: number;
  dataDiskTotalGiB?: number;
};

function containerHealth(container: ContainerInfo): "running" | "stopped" | "unhealthy" | "restarting" {
  const state = container.state.toLowerCase();

  if (state === "running") return "running";
  if (state === "restarting") return "restarting";
  if (state === "exited" || state === "dead" || state === "created") return "stopped";
  return "unhealthy";
}

function DiskUsage({
  label,
  used,
  total,
}: {
  label: string;
  used: number;
  total: number;
}) {
  const valid = Number.isFinite(used) && Number.isFinite(total) && total > 0;
  const percent = valid ? pct(used, total) : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="tabular text-muted-foreground">
          {valid ? `${used.toFixed(2)} / ${total.toFixed(2)} GiB · ${percent}%` : "Unavailable"}
        </span>
      </div>
      {valid ? (
        <Meter value={percent} />
      ) : (
        <p className="text-xs text-muted-foreground">Filesystem capacity was not reported.</p>
      )}
    </div>
  );
}

function Dashboard() {
  const { data: o } = useSuspenseQuery({
    ...overviewQuery,
    refetchInterval: 5000,
  });

  const {
    data: containerList = [],
    isPending: containersPending,
    isError: containersError,
  } = useQuery({
    queryKey: ["containers"],
    queryFn: api.containers,
    refetchInterval: 5000,
  });

  const {
    data: recentActivity = [],
    isPending: activityPending,
    isError: activityError,
  } = useQuery({
    queryKey: ["audit", 10],
    queryFn: () => api.audit(10),
    refetchInterval: 15000,
  });

  const { data: history } = useQuery(metricsHistoryQuery(360));

  const {
    data: usage,
    isError: usageError,
  } = useQuery(usersUsageQuery);

  const extended = o as typeof o & ExtendedOverview;
  const runningCount = containerList.filter(
    (container) => container.state.toLowerCase() === "running",
  ).length;

  const historySamples = (history?.samples ?? []).map((s) => ({
    t: new Date(s.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    cpu: s.cpu,
    mem: s.mem,
    netUpMbps: s.netUpMbps,
    netDownMbps: s.netDownMbps,
  }));

  return (
    <div className="mx-auto max-w-[1400px] space-y-5">
      <PageHeader
        title="Your cloud, at a glance."
        badge={
          <Status value={o.online ? "running" : "stopped"} label={o.online ? "Node online" : "Node offline"} />
        }
        description={`${o.hostname} · ${o.os} · ${o.cpuModel}`}
      />

      <div className="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 text-[13px]">
        <span className="flex items-center gap-2">
          <Status
            value={o.online ? "running" : "stopped"}
            label={o.online ? "Online" : "Offline"}
          />
          <span className="font-mono">{o.hostname}</span>
        </span>
        <span className="text-muted-foreground">
          Uptime{" "}
          <span className="text-foreground tabular">
            {uptime(o.uptimeSeconds)}
          </span>
        </span>
        <span className="text-muted-foreground">
          Swap{" "}
          <span className="text-foreground tabular">
            {o.swapUsedGiB} / {o.swapTotalGiB} GiB
          </span>
        </span>
        <span className="text-muted-foreground">
          GPU temperature{" "}
          <span className="text-foreground tabular">{o.gpu.tempC}°C</span>
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="CPU"
          icon={<Cpu className="size-4" />}
          value={`${o.cpuPercent}%`}
          sub="Host utilization"
          meter={o.cpuPercent}
        />
        <Stat
          label="Memory"
          icon={<MemoryStick className="size-4" />}
          value={`${pct(o.memUsedGiB, o.memTotalGiB)}%`}
          sub={`${o.memUsedGiB} / ${o.memTotalGiB} GiB`}
          meter={pct(o.memUsedGiB, o.memTotalGiB)}
        />
        <Stat
          label="System disk"
          icon={<HardDrive className="size-4" />}
          value={`${pct(o.diskUsedGiB, o.diskTotalGiB)}%`}
          sub={`${o.diskUsedGiB} / ${o.diskTotalGiB} GiB reported`}
          meter={pct(o.diskUsedGiB, o.diskTotalGiB)}
        />
        <Stat
          label="Network"
          icon={<ArrowDownUp className="size-4" />}
          value={`${o.netDownMbps} Mbps`}
          sub={`↓ download · ↑ ${o.netUpMbps} Mbps`}
        />
        <Stat
          label="GPU"
          icon={<Cpu className="size-4" />}
          value={`${o.gpu.utilPercent}%`}
          sub={`${(o.gpu.vramUsedMiB / 1024).toFixed(1)} / ${(o.gpu.vramTotalMiB / 1024).toFixed(1)} GiB VRAM`}
          meter={pct(o.gpu.vramUsedMiB, o.gpu.vramTotalMiB)}
        />
        <Stat
          label="GPU temp"
          icon={<Thermometer className="size-4" />}
          value={`${o.gpu.tempC}°C`}
          sub="Live sensor reading"
        />
        <Stat
          label="Containers"
          icon={<ContainerIcon className="size-4" />}
          value={containersPending ? "…" : runningCount}
          sub={
            containersError
              ? "Inventory unavailable"
              : `${containerList.length} total · Docker inventory`
          }
        />
        <Stat
          label="Apps / Users"
          icon={<AppWindow className="size-4" />}
          value={`${o.runningApps} / ${o.activeUsers}`}
          sub={<span className="flex items-center gap-1"><Users className="size-3" /> backend-reported</span>}
        />
      </div>

      <nav aria-label="Quick access" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {([
          { to: "/containers", title: "Containers", detail: "Manage compute", icon: ContainerIcon },
          { to: "/kdg-drive", title: "KDG Drive", detail: "Files & storage", icon: Folder },
          { to: "/minecraft", title: "Minecraft", detail: "Servers & worlds", icon: Gamepad2 },
          { to: "/lab", title: "JupyterLab", detail: "Notebooks & GPU", icon: FlaskConical },
        ] as const).map((item) => (
          <Link key={item.to} to={item.to} className="panel quick-link flex min-w-0 items-center gap-3 p-4">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-muted/40"><item.icon aria-hidden="true" className="size-5 text-foreground" /></span>
            <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{item.title}</span><span className="block text-[11px] text-muted-foreground">{item.detail}</span></span>
            <ArrowUpRight aria-hidden="true" className="hidden size-4 text-muted-foreground sm:block" />
          </Link>
        ))}
      </nav>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="CPU utilization history">
          {historySamples.length > 1 ? (
            <MetricChart data={historySamples} keys={[{ key: "cpu", color: "var(--chart-1)", label: "CPU" }]} unit="%" height={180} max={100} />
          ) : (
            <Empty title="Collecting samples…" hint="Live CPU utilization is shown above. Historical samples appear after a short period of collection." />
          )}
        </Panel>
        <Panel title="Memory history">
          {historySamples.length > 1 ? (
            <MetricChart data={historySamples} keys={[{ key: "mem", color: "var(--chart-2)", label: "Memory" }]} unit="%" height={180} max={100} />
          ) : (
            <Empty title="Collecting samples…" hint="Live memory usage is shown above. Historical samples appear after a short period of collection." />
          )}
        </Panel>
        <Panel title="Network traffic history">
          {historySamples.length > 1 ? (
            <MetricChart data={historySamples} keys={[{ key: "netDownMbps", color: "var(--chart-1)", label: "Download" }, { key: "netUpMbps", color: "var(--chart-3)", label: "Upload" }]} unit=" Mbps" height={180} />
          ) : (
            <Empty title="Collecting samples…" hint="Current network rates are shown above. Historical samples appear after a short period of collection." />
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Filesystem usage">
          <div className="space-y-5 py-2">
            <DiskUsage
              label="System filesystem (/)"
              used={o.diskUsedGiB}
              total={o.diskTotalGiB}
            />
            {typeof extended.dataDiskUsedGiB === "number" &&
              typeof extended.dataDiskTotalGiB === "number" && (
                <DiskUsage
                  label="KDG data volume (/srv/kdg)"
                  used={extended.dataDiskUsedGiB}
                  total={extended.dataDiskTotalGiB}
                />
              )}
            <p className="text-xs text-muted-foreground">
              Filesystem usage reported by the host metrics API (system / and KDG data /srv/kdg).
            </p>
          </div>
        </Panel>

        <Panel
          title="Docker container health"
          bodyClass="p-0"
          actions={
            <span className="text-xs text-muted-foreground">
              {containerList.length} discovered
            </span>
          }
        >
          {containersError ? (
            <Empty
              title="Container inventory unavailable"
              hint="The dashboard could not read the Docker inventory endpoint."
            />
          ) : containersPending ? (
            <div className="p-4 text-sm text-muted-foreground">Loading Docker inventory…</div>
          ) : containerList.length === 0 ? (
            <Empty
              title="No containers discovered"
              hint="The Docker API returned an empty inventory."
            />
          ) : (
            <ul className="divide-y">
              {containerList.slice(0, 8).map((container) => (
                <li
                  key={container.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{container.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {container.image}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <Status value={containerHealth(container)} />
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {container.status}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Alerts" bodyClass="p-0">
          {o.alerts.length === 0 ? (
            <Empty
              title="No active alerts"
              hint="The host API has not reported any alerts."
            />
          ) : (
            <ul className="divide-y">
              {o.alerts.map((alert) => (
                <li key={alert.id} className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Pill tone={toneFor(alert.severity)} dot>
                      {alert.severity}
                    </Pill>
                    <span className="text-[13px] font-medium">{alert.title}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {alert.detail} · {alert.at}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title="Who's using what"
        bodyClass="p-0"
        actions={
          <Link to="/user-usage" className="text-xs text-primary hover:underline">
            Full breakdown →
          </Link>
        }
      >
        {usageError ? (
          <Empty title="User attribution unavailable" hint="The API could not return per-user usage." />
        ) : !usage ? (
          <div className="p-4 text-sm text-muted-foreground">Loading user attribution…</div>
        ) : usage.users.every((u) => u.processCount === 0 && u.containers.length === 0) ? (
          <Empty
            title="No attributed workloads yet"
            hint="Start a KDG terminal session, create a managed Minecraft server, or assign a container to a user to see CPU, RAM and VRAM ownership here."
          />
        ) : (
          <ul className="divide-y">
            {usage.users
              .filter((u) => u.processCount > 0 || u.containers.length > 0 || u.activeSessions > 0)
              .map((u) => (
                <li key={u.username} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="relative flex size-7 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                      {u.displayName.slice(0, 2).toUpperCase()}
                      {u.activeSessions > 0 && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full border-2 border-card bg-success" />}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium">
                        {u.displayName}
                        <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{u.role}</span>
                        {u.gpuProcessCount > 0 && <Pill tone="primary" dot>GPU</Pill>}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {u.processes.slice(0, 3).map((p) => p.name).join(", ") || u.containers.map((c) => c.name).join(", ") || "idle session"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-[11px] tabular">
                    <span className="text-muted-foreground">CPU <span className="text-foreground">{u.cpuPercent.toFixed(1)}%</span></span>
                    <span className="text-muted-foreground">RAM <span className="text-foreground">{u.memMiB >= 1024 ? `${(u.memMiB / 1024).toFixed(1)} GiB` : `${u.memMiB.toFixed(0)} MiB`}</span></span>
                    <span className={u.gpuMiB ? "text-primary" : "text-muted-foreground"}>
                      VRAM <span className="text-foreground">{u.gpuMiB ? `${(u.gpuMiB / 1024).toFixed(2)} GiB` : "—"}</span>
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recent activity">
        {activityError ? (
          <Empty
            title="Activity log unavailable"
            hint="The audit endpoint could not be reached."
          />
        ) : activityPending ? (
          <div className="text-sm text-muted-foreground">Loading audit events…</div>
        ) : recentActivity.length === 0 ? (
          <Empty
            title="No audit events recorded"
            hint="The audit endpoint currently returns no events. Actions are not fabricated here."
          />
        ) : (
          <ul className="divide-y">
            {recentActivity.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]"
              >
                <span className="w-28 font-mono text-xs text-muted-foreground">
                  {event.at.slice(11)}
                </span>
                <span className="font-medium">{event.actor}</span>
                <span className="font-mono text-xs text-primary">{event.event}</span>
                <span className="truncate text-muted-foreground">{event.resource}</span>
                <span className="ml-auto"><Status value={event.result} /></span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
