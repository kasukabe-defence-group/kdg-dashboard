import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Archive, Box, ExternalLink, Puzzle, Server, Share2, Shield, Users, Network as NetIcon, Route as RouteIcon, Globe } from "lucide-react";
import { api } from "@/services/api/client";
import { PageHeader, Panel, TableWrap, th, td, tr, Pill, Empty, KV, Status, Stat, Meter } from "@/components/kdg/primitives";
import { bytes, pct, uptime } from "@/utils/format";
import { overviewQuery, metricsHistoryQuery } from "@/services/api/queries";
import { MetricChart } from "@/components/charts/area-chart";

export const Route = createFileRoute("/m/$slug")({
  head: ({ params }) => ({ meta: [{ title: `${labelFor(params.slug)} · KDG Cloud` }] }),
  component: ModulePage,
});

function labelFor(slug: string) {
  const map: Record<string, string> = {
    infrastructure: "Infrastructure", utilization: "Resource utilization", activity: "Activity feed", alerts: "Alerts",
    services: "Services", shared: "Shared files", "access-keys": "Access keys", "storage-analytics": "Storage analytics", backups: "Backups",
    networks: "Networks", "reverse-proxy": "Reverse proxy", domains: "Domains & routes", endpoints: "Endpoints",
    minecraft: "Minecraft", websites: "Websites & APIs", "ai-workloads": "AI workloads", jupyterlab: "JupyterLab", devtools: "Developer tools",
    roles: "Roles & permissions", sessions: "Sessions", security: "Security",
  };
  return map[slug] || slug;
}

const BASE = (import.meta.env["VITE_KDG_API_URL"] as string | undefined)?.replace(/\/$/, "") ?? "";
async function jget<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, { credentials: "include" });
  if (!res.ok) { const b = await res.json().catch(()=>null) as any; throw new Error(b?.error?.message || b?.detail || `Request failed (${res.status})`); }
  return res.json() as Promise<T>;
}

function ServicesMod() {
  const q = useQuery({ queryKey: ["services"], queryFn: api.services, refetchInterval: 15000 });
  return (<div><PageHeader title="Services" description="Live platform and application services on this KDG node." />
    <TableWrap>{q.isPending ? <div className="p-5 text-sm text-muted-foreground">Loading services…</div>
      : q.isError ? <Empty title="Could not load services" hint={(q.error as Error)?.message} />
      : (q.data||[]).length===0 ? <Empty title="No services" hint="No services registered." icon={<Server className="size-6" />} />
      : <table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Service","Category","Status","Access","URL"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
        {(q.data||[]).map(s => <tr key={s.id} className={tr}>
          <td className={td}><div className="font-medium">{s.name}</div><div className="text-xs text-muted-foreground">{s.description}</div></td>
          <td className={`${td} text-muted-foreground`}>{s.category}</td>
          <td className={td}><Pill tone={s.status==="installed-running"?"success":s.status==="installed-stopped"?"warning":"muted"}>{s.status}</Pill></td>
          <td className={`${td} text-xs text-muted-foreground`}>{(s.access||[]).join(", ")||"—"}</td>
          <td className={td}>{s.url ? <a href={s.url} className="inline-flex items-center gap-1 text-primary hover:underline">Open <ExternalLink className="size-3"/></a> : "—"}</td>
        </tr>)}</tbody></table>}</TableWrap></div>);
}

function SharedMod() {
  const q = useQuery({ queryKey: ["drive-shares"], queryFn: api.driveShares, refetchInterval: 15000 });
  return (<div><PageHeader title="Shared files" description="Files and folders shared from KDG Drive / Nextcloud." />
    <TableWrap>{q.isPending ? <div className="p-5 text-sm text-muted-foreground">Loading shares…</div>
      : q.isError ? <Empty title="Could not load shares" hint={(q.error as Error)?.message} />
      : (q.data||[]).length===0 ? <Empty title="No shared items" hint="Create shares from KDG Drive to see them here." icon={<Share2 className="size-6" />} />
      : <table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Path","Type","With","Permissions","Expires","Link"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
        {(q.data||[]).map(s => <tr key={s.id} className={tr}>
          <td className={`${td} font-medium`}>{s.path}</td>
          <td className={td}><Pill tone="muted">{s.shareType===3?"Public link":s.shareType===0?"User":s.shareType===1?"Group":String(s.shareType)}</Pill></td>
          <td className={`${td} text-muted-foreground`}>{s.shareWithDisplayName || s.shareWith || "—"}</td>
          <td className={td}>{s.permissions}</td>
          <td className={`${td} text-muted-foreground`}>{s.expiration || "—"}</td>
          <td className={td}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">Open</a> : "—"}</td>
        </tr>)}</tbody></table>}</TableWrap></div>);
}

function NetworksMod() {
  const q = useQuery({ queryKey: ["networks"], queryFn: () => jget<Array<{id:string;name:string;driver:string;scope:string}>>("/networks"), refetchInterval: 15000 });
  return (<div><PageHeader title="Networks" description="Docker networks on the KDG node." />
    <TableWrap>{q.isPending ? <div className="p-5 text-sm text-muted-foreground">Loading networks…</div>
      : q.isError ? <Empty title="Could not load networks" hint={(q.error as Error)?.message} />
      : (q.data||[]).length===0 ? <Empty title="No networks found" hint="No Docker networks were reported." icon={<NetIcon className="size-6" />} />
      : <table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Name","ID","Driver","Scope"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
        {(q.data||[]).map(n => <tr key={n.id} className={tr}><td className={`${td} font-medium`}>{n.name}</td><td className={`${td} font-mono text-xs`}>{n.id}</td><td className={td}>{n.driver}</td><td className={`${td} text-muted-foreground`}>{n.scope}</td></tr>)}
      </tbody></table>}</TableWrap></div>);
}

function ReverseProxyMod() {
  const q = useQuery({ queryKey: ["reverse-proxy"], queryFn: () => jget<any>("/reverse-proxy") });
  const d = q.data || {};
  return (<div className="space-y-4"><PageHeader title="Reverse proxy" description="Traefik reverse proxy status and configuration." />
    {q.isPending ? <div className="text-sm text-muted-foreground">Loading…</div> : q.isError ? <Empty title="Could not load reverse proxy info" hint={(q.error as Error)?.message} /> : (
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Proxy status"><KV rows={[ ["Provider", d.provider || "Traefik"], ["Container", d.container?.name || "—"], ["Image", <span key="i" className="font-mono text-xs">{d.container?.image || "—"}</span>], ["Status", <Pill key="s" tone={d.container?.status==="running"?"success":"warning"}>{d.container?.status || "unknown"}</Pill>], ["Routers", String(d.routersCount ?? "—")], ["Services", String(d.servicesCount ?? "—")], ["Middlewares", String(d.middlewaresCount ?? "—")] ]} /></Panel>
        <Panel title="Entrypoints & providers"><KV rows={[ ["Entrypoints", (d.entryPoints||[]).map((e:any)=>`${e.name} (${e.address})`).join(", ") || "—"], ["Providers", (d.providers||[]).join(", ") || "—"], ["Config files", (d.configFiles||[]).map((f:any)=>f.name).join(", ") || "—"] ]} /></Panel>
        <Panel title="Notes"><ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{(d.notes||[]).map((n:string,i:number)=><li key={i}>{n}</li>)}</ul></Panel>
      </div>)}
  </div>);
}

function DomainsRoutesMod() {
  const q = useQuery({ queryKey: ["domains-routes"], queryFn: () => jget<any>("/domains-routes") });
  const d = q.data || {};
  return (<div className="space-y-4"><PageHeader title="Domains & routes" description="Configured domains, Traefik routers, services, and middlewares." />
    {q.isPending ? <div className="text-sm text-muted-foreground">Loading…</div> : q.isError ? <Empty title="Could not load routes" hint={(q.error as Error)?.message} /> : <>
      <Panel title="Domains / entry points"><TableWrap><table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Host","Type","Port","Notes"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
        {(d.domains||[]).map((x:any,i:number)=><tr key={i} className={tr}><td className={`${td} font-mono text-xs`}>{x.host}</td><td className={td}>{x.type}</td><td className={td}>{x.port}</td><td className={`${td} text-muted-foreground`}>{x.notes}</td></tr>)}
      </tbody></table></TableWrap></Panel>
      <Panel title="Traefik routers"><TableWrap><table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Router","Rule","Priority","Service","File"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
        {(d.routes||[]).length===0 ? <tr><td className={td} colSpan={5}><span className="text-muted-foreground">No routers parsed.</span></td></tr> : (d.routes||[]).map((r:any,i:number)=><tr key={i} className={tr}><td className={`${td} font-medium`}>{r.name}</td><td className={`${td} font-mono text-xs`}>{r.rule || "—"}</td><td className={td}>{r.priority ?? "—"}</td><td className={td}>{r.service || "—"}</td><td className={`${td} text-muted-foreground`}>{r.file || "—"}</td></tr>)}
      </tbody></table></TableWrap></Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Backend services"><TableWrap><table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Service","URL","File"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
          {(d.services||[]).map((s:any,i:number)=><tr key={i} className={tr}><td className={`${td} font-medium`}>{s.name}</td><td className={`${td} font-mono text-xs`}>{s.url || "—"}</td><td className={`${td} text-muted-foreground`}>{s.file}</td></tr>)}
        </tbody></table></TableWrap></Panel>
        <Panel title="Middlewares"><TableWrap><table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Middleware","File"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
          {(d.middlewares||[]).map((m:any,i:number)=><tr key={i} className={tr}><td className={`${td} font-medium`}>{m.name}</td><td className={`${td} text-muted-foreground`}>{m.file}</td></tr>)}
        </tbody></table></TableWrap></Panel>
      </div>
    </>}
  </div>);
}

function EndpointsMod() {
  const q = useQuery({ queryKey: ["endpoints"], queryFn: () => jget<any>("/endpoints") });
  const d = q.data || {};
  return (<div className="space-y-4"><PageHeader title="Endpoints" description="Public, LAN, and Tailscale access endpoints." />
    {q.isPending ? <div className="text-sm text-muted-foreground">Loading…</div> : q.isError ? <Empty title="Could not load endpoints" hint={(q.error as Error)?.message} /> : (
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Public (Tailscale Funnel)"><KV rows={[ ["Dashboard", <span key="d" className="font-mono text-xs break-all">{d.public?.dashboard}</span>], ["API", <span key="a" className="font-mono text-xs break-all">{d.public?.api}</span>], ["Health", <span key="h" className="font-mono text-xs break-all">{d.public?.health}</span>], ["Terminal WS", <span key="w" className="font-mono text-xs break-all">{d.public?.terminalWs}</span>], ["Provider", d.public?.provider || "—"] ]} /></Panel>
        <Panel title="LAN / Tailscale"><KV rows={[ ["LAN Dashboard", <span key="l" className="font-mono text-xs">{d.lan?.dashboard}</span>], ["LAN API", <span key="la" className="font-mono text-xs">{d.lan?.api}</span>], ["Tailscale Dashboard", <span key="t" className="font-mono text-xs">{d.tailscale?.dashboard}</span>], ["Tailscale API", <span key="ta" className="font-mono text-xs">{d.tailscale?.api}</span>] ]} /></Panel>
        <Panel title="Notes"><ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{(d.notes||[]).map((n:string,i:number)=><li key={i}>{n}</li>)}</ul></Panel>
      </div>)}
  </div>);
}

function StorageAnalyticsMod() {
  const q = useQuery({ queryKey: ["storage-analytics"], queryFn: () => jget<any>("/storage/analytics"), refetchInterval: 30000 });
  const d = q.data || { filesystems: [], s3: {} };
  return (<div className="space-y-4"><PageHeader title="Storage analytics" description="Live storage usage across filesystems and KDG storage services." />
    {q.isPending ? <div className="text-sm text-muted-foreground">Loading…</div> : q.isError ? <Empty title="Could not load storage analytics" hint={(q.error as Error)?.message} /> : <>
      <div className="grid gap-3 sm:grid-cols-3"><Panel title="S3 (filesystem-backed)"><KV rows={[["Buckets", String(d.s3?.buckets ?? 0)],["Objects", String(d.s3?.objects ?? 0)],["Used", bytes(d.s3?.sizeBytes ?? 0)]]} /></Panel></div>
      <Panel title="Filesystems">{(d.filesystems||[]).length===0 ? <Empty title="No filesystem data" hint="Filesystem usage is unavailable." /> :
        <table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Mount","Device","Type","Used","Total","Free","Use %"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
          {(d.filesystems||[]).map((f:any)=><tr key={f.mount} className={tr}><td className={`${td} font-medium`}>{f.mount}</td><td className={`${td} font-mono text-xs`}>{f.device}</td><td className={td}>{f.fstype}</td><td className={td}>{bytes(f.usedBytes)}</td><td className={td}>{bytes(f.totalBytes)}</td><td className={td}>{bytes(f.freeBytes)}</td><td className={td}>{f.percent}%</td></tr>)}
        </tbody></table>}</Panel>
    </>}</div>);
}

function RolesMod() {
  const q = useQuery({ queryKey: ["roles"], queryFn: () => jget<any[]>("/roles") });
  if (q.isPending) return <div><PageHeader title="Roles & permissions" /><div className="text-sm text-muted-foreground">Loading…</div></div>;
  if (q.isError) return <div><PageHeader title="Roles & permissions" /><Empty title="Could not load roles" hint={(q.error as Error)?.message} /></div>;
  return <div className="space-y-4"><PageHeader title="Roles & permissions" description="Role definitions and configured user counts." />
    <div className="grid gap-4 md:grid-cols-2">{(q.data||[]).map(r => <Panel key={r.role} title={<span className="flex items-center gap-2"><Shield className="size-4"/>{r.role} <Pill tone="muted">{r.userCount} users</Pill></span>}><p className="mb-2 text-sm text-muted-foreground">{r.description}</p><div className="flex flex-wrap gap-1">{(r.capabilities||[]).map((c:string)=><Pill key={c} tone="muted">{c}</Pill>)}</div></Panel>)}</div>
  </div>;
}

function SessionsMod() {
  const q = useQuery({ queryKey: ["sessions"], queryFn: () => jget<any>("/sessions"), refetchInterval: 10000 });
  if (q.isPending) return <div><PageHeader title="Sessions" /><div className="text-sm text-muted-foreground">Loading…</div></div>;
  if (q.isError) return <div><PageHeader title="Sessions" /><Empty title="Could not load sessions" hint={(q.error as Error)?.message} /></div>;
  const list = q.data?.sessions || [];
  return <div><PageHeader title="Sessions" description={`${q.data?.count||0} active dashboard session(s).`} />
    <TableWrap>{list.length===0?<Empty title="No active sessions" hint="No dashboard sessions are currently active." icon={<Users className="size-6"/>}/>:
      <table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["User","Role","Expires","Current"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
        {list.map((s:any,i:number)=><tr key={i} className={tr}><td className={td}><div className="font-medium">{s.displayName}</div><div className="text-xs text-muted-foreground">@{s.username}</div></td><td className={td}><Pill tone="muted">{s.role}</Pill></td><td className={`${td} text-muted-foreground`}>{s.expiresAt ? new Date(s.expiresAt*1000).toLocaleString() : "—"}</td><td className={td}>{s.current ? <Pill tone="success">current</Pill> : "—"}</td></tr>)}
      </tbody></table>}</TableWrap></div>;
}

function SecurityMod() {
  const q = useQuery({ queryKey: ["security-summary"], queryFn: () => jget<any>("/security/summary"), refetchInterval: 30000 });
  if (q.isPending) return <div><PageHeader title="Security" /><div className="text-sm text-muted-foreground">Loading…</div></div>;
  if (q.isError) return <div><PageHeader title="Security" /><Empty title="Could not load security summary" hint={(q.error as Error)?.message} /></div>;
  const d = q.data || {};
  return <div className="space-y-4"><PageHeader title="Security" description="Authentication, access, and recent security-relevant events." />
    <div className="grid gap-3 sm:grid-cols-3"><Panel title="Active sessions"><div className="text-2xl font-semibold">{d.activeSessions ?? 0}</div></Panel><Panel title="Failed logins (scanned)"><div className="text-2xl font-semibold">{d.totals?.failedLogins ?? 0}</div></Panel><Panel title="Denied events (scanned)"><div className="text-2xl font-semibold">{d.totals?.denied ?? 0}</div></Panel></div>
    <Panel title="Recent failed/blocked logins">{(d.recentFailedLogins||[]).length===0?<div className="text-sm text-muted-foreground">No recent failed login events.</div>:<ul className="space-y-1 text-sm">{(d.recentFailedLogins||[]).slice(0,10).map((e:any)=><li key={e.id} className="flex flex-wrap gap-2"><span className="font-mono text-xs text-muted-foreground">{(e.at||"").slice(11,19)}</span><span>{e.actor}</span><span className="text-muted-foreground">{e.event}</span><span className="ml-auto text-muted-foreground">{e.ip}</span></li>)}</ul>}</Panel>
    <Panel title="Recent API key events">{(d.keyEvents||[]).length===0?<div className="text-sm text-muted-foreground">No recent API key events.</div>:<ul className="space-y-1 text-sm">{(d.keyEvents||[]).slice(0,10).map((e:any)=><li key={e.id} className="flex flex-wrap gap-2"><span className="font-mono text-xs text-muted-foreground">{(e.at||"").slice(11,19)}</span><span>{e.event}</span><span className="text-muted-foreground truncate max-w-[320px]">{e.resource}</span><span className="ml-auto"><Status value={e.result}/></span></li>)}</ul>}</Panel>
  </div>;
}

function AccessKeysMod() {
  return <div className="space-y-4"><PageHeader title="Access keys" description="Credentials for programmatic access to KDG services." />
    <Panel title="Dashboard / API keys"><p className="mb-2 text-sm text-muted-foreground">Use dashboard-managed API keys (Bearer tokens) for authenticated access to the KDG API, including Drive and S3-compatible storage endpoints.</p><Link to="/api-keys" className="text-primary hover:underline">Open API Keys →</Link></Panel>
    <Panel title="S3-compatible storage"><p className="text-sm text-muted-foreground">KDG S3 object storage is filesystem-backed and accessed through the KDG API using your dashboard session or API keys. Dedicated S3 access/secret key pairs are not required for this backend.</p><div className="mt-2"><Link to="/s3" className="text-primary hover:underline">Open S3 Buckets →</Link></div></Panel>
  </div>;
}

function BackupsMod() {
  return <div className="space-y-4"><PageHeader title="Backups" description="Backup status and data protection for this KDG node." />
    <Panel title="Status"><KV rows={[["Automated backup jobs","Not configured"],["Nextcloud data/DB volumes","Present (managed by Nextcloud stack)"],["Drive / S3 data paths","Stored on node filesystem (persisted)"],["Recommendation","Configure periodic snapshots/backups of /srv/kdg, Nextcloud volumes, and KDG data to external/off-node storage."]]} /></Panel>
    <Empty title="No backup schedules detected" hint="No automated backup service or schedule is currently configured on this node. Core data volumes are persistent, but off-node backups are not yet set up." icon={<Archive className="size-6"/>} />
  </div>;
}

function AppWorkloadMod({ slug, title }: { slug: string; title: string }) {
  const q = useQuery({ queryKey: ["containers"], queryFn: api.containers, refetchInterval: 15000 });
  const keywords: Record<string, string[]> = {
    minecraft: ["minecraft", "paper", "mc"], websites: ["nginx", "caddy", "apache", "website", "web"],
    "ai-workloads": ["ollama", "cuda", "inference", "ai", "llm"], jupyterlab: ["jupyter"], devtools: ["forgejo", "gitea", "gitlab", "code", "jenkins"],
  };
  const kws = keywords[slug] || [slug];
  const matches = (q.data||[]).filter(c => kws.some(k => (c.name+" "+c.image).toLowerCase().includes(k)));
  return <div><PageHeader title={title} description={`Detected workloads and containers related to ${title.toLowerCase()}.`} />
    {q.isPending ? <div className="text-sm text-muted-foreground">Scanning…</div> : matches.length===0 ? <Empty title={`No ${title.toLowerCase()} workloads detected`} hint={`No running or installed containers matching ${title} were found on this node. Deploy them as Docker containers/stacks when needed.`} icon={<Box className="size-6"/>} /> :
    <TableWrap><table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Name","Image","State","Status"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
      {matches.map(c=><tr key={c.id} className={tr}><td className={`${td} font-medium`}>{c.name}</td><td className={`${td} font-mono text-xs`}>{c.image}</td><td className={td}><Pill tone={c.state==="running"?"success":"muted"}>{c.state}</Pill></td><td className={`${td} text-muted-foreground`}>{c.status}</td></tr>)}
    </tbody></table></TableWrap>}
  </div>;
}

function InfrastructureMod() {
  const ov = useQuery({ ...overviewQuery, refetchInterval: 10000 });
  const ct = useQuery({ queryKey: ["containers"], queryFn: api.containers, refetchInterval: 10000 });
  const sv = useQuery({ queryKey: ["services"], queryFn: api.services, refetchInterval: 15000 });
  const o = ov.data;
  return <div className="space-y-4"><PageHeader title="Infrastructure" description="Host, containers, and core platform status." />
    {ov.isPending ? <div className="text-sm text-muted-foreground">Loading…</div> : o && <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Host" value={o.hostname} sub={o.online ? "Online" : "Offline"} />
        <Stat label="OS" value={o.os} sub={uptime(o.uptimeSeconds)} />
        <Stat label="Containers" value={ct.data?.length ?? 0} sub={`${(ct.data||[]).filter(c=>c.state==="running").length} running`} />
        <Stat label="Services" value={sv.data?.length ?? 0} sub={`${(sv.data||[]).filter(s=>s.status==="installed-running").length} running`} />
      </div>
      <Panel title="Host"><KV rows={[ ["Hostname", o.hostname], ["OS", o.os], ["CPU", o.cpuModel], ["Uptime", uptime(o.uptimeSeconds)] ]} /></Panel>
      <Panel title="Containers">{(ct.data||[]).length===0 ? <div className="text-sm text-muted-foreground">No containers.</div> : <TableWrap><table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Name","Image","State","Status"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>{(ct.data||[]).map(c=><tr key={c.id} className={tr}><td className={`${td} font-medium`}>{c.name}</td><td className={`${td} font-mono text-xs`}>{c.image}</td><td className={td}><Pill tone={c.state==="running"?"success":"muted"}>{c.state}</Pill></td><td className={`${td} text-muted-foreground`}>{c.status}</td></tr>)}</tbody></table></TableWrap>}</Panel>
    </>}
  </div>;
}

function UtilizationMod() {
  const ov = useQuery({ ...overviewQuery, refetchInterval: 5000 });
  const hist = useQuery({ ...metricsHistoryQuery(360), refetchInterval: 15000 });
  const o = ov.data;
  const samples = (hist.data?.samples || []).map((s:any)=>({ t: new Date(s.t).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}), cpu: s.cpu, mem: s.mem, netDownMbps: s.netDownMbps, netUpMbps: s.netUpMbps }));
  return <div className="space-y-4"><PageHeader title="Resource utilization" description="Live CPU, memory, network, and filesystem utilization." />
    {ov.isPending || !o ? <div className="text-sm text-muted-foreground">Loading…</div> : <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="CPU" value={`${o.cpuPercent.toFixed(1)}%`} meter={o.cpuPercent} />
        <Stat label="Memory" value={`${pct(o.memUsedGiB, o.memTotalGiB)}%`} sub={`${o.memUsedGiB.toFixed(1)} / ${o.memTotalGiB.toFixed(1)} GiB`} meter={pct(o.memUsedGiB, o.memTotalGiB)} />
        <Stat label="Disk (/)" value={`${pct(o.diskUsedGiB, o.diskTotalGiB)}%`} sub={`${o.diskUsedGiB.toFixed(1)} / ${o.diskTotalGiB.toFixed(1)} GiB`} meter={pct(o.diskUsedGiB, o.diskTotalGiB)} />
        <Stat label="Network" value={`↓ ${o.netDownMbps.toFixed(2)} Mbps`} sub={`↑ ${o.netUpMbps.toFixed(2)} Mbps`} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="CPU history">{samples.length>1 ? <MetricChart data={samples} keys={[{key:"cpu", color:"var(--chart-1)", label:"CPU"}]} unit="%" height={180} max={100}/> : <div className="text-sm text-muted-foreground">Collecting samples…</div>}</Panel>
        <Panel title="Memory history">{samples.length>1 ? <MetricChart data={samples} keys={[{key:"mem", color:"var(--chart-2)", label:"Memory"}]} unit="%" height={180} max={100}/> : <div className="text-sm text-muted-foreground">Collecting samples…</div>}</Panel>
        <Panel title="Network history">{samples.length>1 ? <MetricChart data={samples} keys={[{key:"netDownMbps", color:"var(--chart-1)", label:"Download"}, {key:"netUpMbps", color:"var(--chart-3)", label:"Upload"}]} unit=" Mbps" height={180}/> : <div className="text-sm text-muted-foreground">Collecting samples…</div>}</Panel>
      </div>
    </>}
  </div>;
}

function ActivityMod() {
  const q = useQuery({ queryKey: ["audit", 50], queryFn: () => api.audit(50), refetchInterval: 15000 });
  return <div><PageHeader title="Activity feed" description="Recent audit and platform activity." actions={<Link to="/audit" className="text-sm text-primary hover:underline">Open Audit Logs →</Link>} />
    <TableWrap>{q.isPending ? <div className="p-5 text-sm text-muted-foreground">Loading…</div> : q.isError ? <Empty title="Could not load activity" hint={(q.error as Error)?.message} /> : (q.data||[]).length===0 ? <Empty title="No recent activity" hint="No audit events recorded yet." /> :
      <table className="w-full text-[13px]"><thead className="bg-muted/40"><tr>{["Time","Actor","Event","Resource","Result"].map(h=><th key={h} className={th}>{h}</th>)}</tr></thead><tbody>
        {(q.data||[]).map(e => <tr key={e.id} className={tr}><td className={`${td} font-mono text-xs text-muted-foreground`}>{(e.at||"").slice(11,19)}</td><td className={td}>{e.actor}</td><td className={`${td} font-mono text-xs text-primary`}>{e.event}</td><td className={`${td} truncate max-w-[320px] text-muted-foreground`}>{e.resource}</td><td className={td}><Status value={e.result} /></td></tr>)}
      </tbody></table>}</TableWrap>
  </div>;
}

function AlertsMod() {
  const ov = useQuery({ ...overviewQuery, refetchInterval: 15000 });
  const alerts = ov.data?.alerts || [];
  return <div><PageHeader title="Alerts" description="Current system alerts and health signals." actions={<Link to="/" className="text-sm text-primary hover:underline">Open Dashboard →</Link>} />
    <Panel title="Active alerts">{alerts.length===0 ? <div className="text-sm text-muted-foreground">No active alerts. System operating normally.</div> : <ul className="space-y-2">{alerts.map((a:any)=><li key={a.id} className="rounded-md border p-2"><div className="flex items-center gap-2"><Pill tone={a.severity==="critical"?"destructive":a.severity==="warning"?"warning":"muted"}>{a.severity}</Pill><span className="font-medium">{a.title}</span><span className="ml-auto text-xs text-muted-foreground">{a.at}</span></div><div className="mt-1 text-sm text-muted-foreground">{a.detail}</div></li>)}</ul>}</Panel>
  </div>;
}

function ModulePage() {
  const { slug } = Route.useParams();
  const title = labelFor(slug);
  let content: React.ReactNode;
  if (slug === "services") content = <ServicesMod />;
  else if (slug === "shared") content = <SharedMod />;
  else if (slug === "networks") content = <NetworksMod />;
  else if (slug === "reverse-proxy") content = <ReverseProxyMod />;
  else if (slug === "domains") content = <DomainsRoutesMod />;
  else if (slug === "endpoints") content = <EndpointsMod />;
  else if (slug === "storage-analytics") content = <StorageAnalyticsMod />;
  else if (slug === "roles") content = <RolesMod />;
  else if (slug === "sessions") content = <SessionsMod />;
  else if (slug === "security") content = <SecurityMod />;
  else if (slug === "access-keys") content = <AccessKeysMod />;
  else if (slug === "backups") content = <BackupsMod />;
  else if (slug === "infrastructure") content = <InfrastructureMod />;
  else if (slug === "utilization") content = <UtilizationMod />;
  else if (slug === "activity") content = <ActivityMod />;
  else if (slug === "alerts") content = <AlertsMod />;
  else if (["minecraft","websites","ai-workloads","jupyterlab","devtools"].includes(slug)) content = <AppWorkloadMod slug={slug} title={title} />;
  else content = <div><Empty title={title} hint="This module is not configured on this KDG Cloud node." icon={<Puzzle className="size-6" />} /><div className="mt-3 text-center text-sm"><Link to="/" className="text-primary hover:underline">Back to dashboard</Link></div></div>;
  return <div className="mx-auto max-w-[1400px]">{content}</div>;
}
