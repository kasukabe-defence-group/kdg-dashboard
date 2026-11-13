import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { api } from "@/services/api/client";
import { PageHeader, TableWrap, th, td, tr, Pill, Empty, Status } from "@/components/kdg/primitives";

export const Route = createFileRoute("/audit")({
  head: () => ({ meta: [
    { title: "Audit Logs · KDG Cloud" },
    { name: "description", content: "Audit trail of platform and security events." },
  ]}),
  component: AuditPage,
});

function resultTone(result: string): "success" | "warning" | "destructive" | "muted" {
  if (result === "success") return "success";
  if (result === "denied" || result === "error") return "destructive";
  if (result === "warning") return "warning";
  return "muted";
}

function AuditPage() {
  const { data: events = [], isPending, isError, error, refetch } = useQuery({
    queryKey: ["audit", 200],
    queryFn: () => api.audit(200),
    refetchInterval: 15000,
  });

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Audit Logs"
        badge={<span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary"><ShieldAlert className="size-3.5" /> {events.length} events</span>}
        description="Persisted audit trail for authentication, API key, rate limiting, and control actions."
        actions={<button className="text-sm text-primary hover:underline" onClick={() => void refetch()}>Refresh</button>}
      />
      <TableWrap>
        {isPending ? (
          <div className="p-5 text-sm text-muted-foreground">Loading audit events…</div>
        ) : isError ? (
          <Empty title="Could not load audit logs" hint={error instanceof Error ? error.message : "Request failed"} />
        ) : events.length === 0 ? (
          <Empty title="No audit events yet" hint="Events will appear as users authenticate and actions are performed." icon={<ShieldAlert className="size-6" />} />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40">
              <tr>{["Time", "Actor", "Event", "Resource", "Action", "Result", "IP"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className={tr}>
                  <td className={`${td} whitespace-nowrap font-mono text-xs text-muted-foreground`}>{e.at ? new Date(e.at).toLocaleString() : "—"}</td>
                  <td className={`${td} font-medium`}>{e.actor || "—"}</td>
                  <td className={td}><span className="font-mono text-xs text-primary">{e.event}</span></td>
                  <td className={`${td} max-w-[260px] truncate text-muted-foreground`} title={e.resource}>{e.resource || "—"}</td>
                  <td className={`${td} text-xs`}>{e.action || "—"}</td>
                  <td className={td}><Pill tone={resultTone(e.result)}>{e.result || "—"}</Pill></td>
                  <td className={`${td} font-mono text-xs text-muted-foreground`}>{e.ip || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      <p className="mt-2 text-xs text-muted-foreground">Audit events are recorded by the KDG API and stored server-side. Sensitive values (passwords, tokens) are not logged.</p>
    </div>
  );
}