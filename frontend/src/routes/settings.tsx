import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Server, Shield, User, Globe, HardDrive } from "lucide-react";
import { overviewQuery } from "@/services/api/queries";
import { useSession } from "@/hooks/use-session";
import { PageHeader, Panel, KV, Pill } from "@/components/kdg/primitives";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings · KDG Cloud" }, { name: "description", content: "Platform and account information." }] }),
  component: SettingsPage,
});

function SettingsPage() {
  const { user } = useSession();
  const { data: overview } = useQuery({ ...overviewQuery, refetchInterval: 30000 });

  return (
    <div className="mx-auto max-w-[1100px] space-y-4">
      <PageHeader title="Settings" description="Account, server, and access information for this KDG Cloud node." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={<span className="flex items-center gap-2"><User className="size-4" /> Current session</span>}>
          <KV rows={[
            ["Display name", user?.displayName || "—"],
            ["Username", user?.username || "—"],
            ["Role", user?.role ? <Pill key="r" tone={user.role === "owner" ? "success" : user.role === "admin" ? "warning" : "muted"}>{user.role}</Pill> : "—"],
            ["Auth", "Dashboard session (cookie) · API keys supported (Bearer)"],
          ]} />
        </Panel>

        <Panel title={<span className="flex items-center gap-2"><Server className="size-4" /> Server</span>}>
          <KV rows={[
            ["Hostname", overview?.hostname || "—"],
            ["OS", overview?.os || "—"],
            ["CPU", overview?.cpuModel || "—"],
            ["Status", overview ? <Pill key="s" tone={overview.online ? "success" : "destructive"}>{overview.online ? "Online" : "Offline"}</Pill> : "—"],
          ]} />
        </Panel>

        <Panel title={<span className="flex items-center gap-2"><Globe className="size-4" /> Access & endpoints</span>}>
          <KV rows={[
            ["Public dashboard", <span key="p" className="font-mono text-xs break-all">https://kasukabedefensegroup.taila4fe10.ts.net:8443/</span>],
            ["Public API", <span key="a" className="font-mono text-xs break-all">https://kasukabedefensegroup.taila4fe10.ts.net:8443/api/v1</span>],
            ["LAN", <span key="l" className="font-mono text-xs">http://192.168.1.18:8080</span>],
            ["Tailscale", <span key="t" className="font-mono text-xs">http://100.119.120.20:8080</span>],
            ["Terminal (WS)", <span key="w" className="font-mono text-xs break-all">wss://kasukabedefensegroup.taila4fe10.ts.net:8443/api/v1/terminal/ws</span>],
          ]} />
        </Panel>

        <Panel title={<span className="flex items-center gap-2"><Shield className="size-4" /> Platform notes</span>}>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>Core services: KDG API, dashboard frontend, Traefik, Nextcloud, and supporting containers run with restart policies and systemd persistence.</p>
            <p>Use <span className="font-medium text-foreground">API Keys</span> to grant scoped token access to external apps. Use <span className="font-medium text-foreground">Audit Logs</span> to review authentication and control actions.</p>
            <p className="flex items-center gap-1.5"><HardDrive className="size-3.5" /> File storage and sharing are provided via KDG Drive / Nextcloud integration.</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}