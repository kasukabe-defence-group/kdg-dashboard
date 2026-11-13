import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, ExternalLink } from "lucide-react";
import { api } from "@/services/api/client";
import { PageHeader, TableWrap, th, td, tr, Pill, Empty } from "@/components/kdg/primitives";

export const Route = createFileRoute("/apps")({
  head: () => ({ meta: [{ title: "Applications · KDG Cloud" }, { name: "description", content: "Application catalogue and service status." }] }),
  component: AppsPage,
});

function AppsPage() {
  const { data: services = [], isPending, isError, error } = useQuery({
    queryKey: ["services"],
    queryFn: api.services,
    refetchInterval: 15000,
  });

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Applications" description="Installed and available services on the KDG node." />
      <TableWrap>
        {isPending ? (
          <div className="p-5 text-sm text-muted-foreground">Loading applications…</div>
        ) : isError ? (
          <Empty title="Could not load applications" hint={error instanceof Error ? error.message : "Request failed"} />
        ) : services.length === 0 ? (
          <Empty
            title="No applications configured"
            hint="No application services are registered in the KDG catalogue yet. Core platform services (Nextcloud, Traefik, dashboard/API) are running and available via their respective pages."
            icon={<AppWindow className="size-6" />}
          />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40"><tr>{["Application", "Category", "Status", "Access", "URL"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id} className={tr}>
                  <td className={td}><div className="font-medium">{s.name}</div><div className="text-xs text-muted-foreground">{s.description}</div></td>
                  <td className={`${td} text-muted-foreground`}>{s.category}</td>
                  <td className={td}><Pill tone={s.status === "installed-running" ? "success" : s.status === "installed-stopped" ? "warning" : "muted"}>{s.status}</Pill></td>
                  <td className={`${td} text-xs text-muted-foreground`}>{(s.access || []).join(", ") || "—"}</td>
                  <td className={td}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">Open <ExternalLink className="size-3" /></a> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </div>
  );
}