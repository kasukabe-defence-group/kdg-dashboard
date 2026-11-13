import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Cpu, Thermometer, Zap, MemoryStick } from "lucide-react";
import { gpuQuery } from "@/services/api/queries";
import { PageHeader, Panel, Stat, KV, TableWrap, th, td, tr, Meter, Empty } from "@/components/kdg/primitives";
import { pct } from "@/utils/format";

export const Route = createFileRoute("/gpu")({
  head: () => ({
    meta: [
      { title: "GPU Lab · KDG Cloud" },
      { name: "description", content: "Live GPU utilization, VRAM and device information." },
      { property: "og:title", content: "GPU Lab · KDG Cloud" },
      { property: "og:description", content: "Live GPU utilization, VRAM and device information." },
    ],
  }),
  loader: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(gpuQuery);
    } catch {
      // SSR may run without a session cookie; client fetch will handle auth.
    }
  },
  component: GpuPage,
});

function GpuPage() {
  const { data: g } = useSuspenseQuery({
    ...gpuQuery,
    refetchInterval: 5000,
  });
  const vram = pct(g.vramUsedMiB, g.vramTotalMiB);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="GPU Lab"
        badge={
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            Live NVIDIA telemetry
          </span>
        }
        description={g.name}
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Utilization" value={`${g.utilPercent}%`} meter={g.utilPercent} icon={<Cpu className="size-4" />} />
        <Stat label="VRAM" value={`${vram}%`} sub={`${g.vramUsedMiB} / ${g.vramTotalMiB} MiB`} meter={vram} icon={<MemoryStick className="size-4" />} />
        <Stat label="Temperature" value={`${g.tempC}°C`} icon={<Thermometer className="size-4" />} />
        <Stat label="Power" value={g.powerW != null ? `${g.powerW} W` : "N/A"} sub={g.powerLimitW != null ? `limit ${g.powerLimitW} W` : "Not reported by driver"} icon={<Zap className="size-4" />} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Device">
          <KV rows={[
            ["Model", g.name],
            ["Driver", g.driver],
            ["CUDA", g.cuda],
            ["VRAM total", `${g.vramTotalMiB} MiB`],
          ]} />
        </Panel>
        <div className="lg:col-span-2">
          <Panel title="GPU processes">
            {g.processes.length === 0 ? (
              <Empty
                title="No GPU processes reported"
                hint="The NVIDIA driver did not report any active GPU compute processes at this sample."
              />
            ) : (
              <TableWrap>
                <table className="w-full text-[13px]">
                  <thead><tr>{["PID", "Process", "VRAM", "Share", "Util"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {g.processes.map((p) => (
                      <tr key={p.pid} className={tr}>
                        <td className={`${td} tabular text-muted-foreground`}>{p.pid}</td>
                        <td className={`${td} font-medium`}>{p.name}</td>
                        <td className={`${td} tabular`}>{p.vramMiB} MiB</td>
                        <td className={`${td} w-40`}><Meter value={pct(p.vramMiB, g.vramTotalMiB)} /></td>
                        <td className={`${td} tabular text-muted-foreground`}>{p.utilPercent != null ? `${p.utilPercent}%` : "Not reported"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </Panel>
          <p className="mt-2 text-xs text-muted-foreground">
            Values come from the host NVIDIA telemetry endpoint. Per-process utilization may not be available on this GPU driver.
          </p>
        </div>
      </div>
    </div>
  );
}
