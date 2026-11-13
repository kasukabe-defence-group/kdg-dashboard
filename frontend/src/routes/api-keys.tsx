import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Copy, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/services/api/client";
import type { ApiKeyInfo } from "@/types";
import { PageHeader, TableWrap, th, td, tr, Pill, Empty } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/api-keys")({
  head: () => ({ meta: [{ title: "API Keys · KDG Cloud" }, { name: "description", content: "Manage API keys for external access." }] }),
  component: ApiKeysPage,
});

const SCOPE_OPTIONS = ["read", "write", "drive", "control", "admin"] as const;

function ApiKeysPage() {
  const qc = useQueryClient();
  const { data: keys = [], isPending, isError, error } = useQuery({ queryKey: ["api-keys"], queryFn: api.apiKeys, refetchInterval: 15000 });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.createApiKey({ name: name.trim(), scopes, expiresAt: expiresAt || null }),
    onSuccess: (res) => {
      setCreatedToken(res.token ?? null);
      setName(""); setScopes(["read"]); setExpiresAt("");
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to create API key"),
  });
  const update = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: { enabled?: boolean; scopes?: string[] } }) => api.updateApiKey(id, payload),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["api-keys"] }),
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to update API key"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteApiKey(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["api-keys"] }),
    onError: (e) => setActionError(e instanceof Error ? e.message : "Failed to delete API key"),
  });

  const toggleScope = (s: string) => setScopes((cur) => cur.includes(s) ? (cur.filter(x => x !== s).length ? cur.filter(x => x !== s) : cur) : [...cur, s]);

  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); } catch {} };

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="API Keys" description="Create and manage token-based API keys for external apps. Keys are shown once at creation and stored hashed on the server." actions={
        <Button size="sm" onClick={() => { setActionError(null); setCreatedToken(null); setOpen(true); }}><Plus className="size-4" /> Create key</Button>
      } />
      {actionError && <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div>}

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setCreatedToken(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{createdToken ? "API key created" : "Create API key"}</DialogTitle>
            <DialogDescription>{createdToken ? "Copy this token now. It will not be shown again." : "Generate a new token for external access (Authorization: Bearer <token>)."}</DialogDescription>
          </DialogHeader>
          {createdToken ? (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/40 p-3 font-mono text-xs break-all">{createdToken}</div>
              <Button variant="outline" size="sm" onClick={() => copy(createdToken)}><Copy className="size-4" /> Copy token</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5"><Label htmlFor="key-name">Name</Label><Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CI deploy, Mobile app" /></div>
              <div className="space-y-1.5">
                <Label>Scopes</Label>
                <div className="flex flex-wrap gap-2">
                  {SCOPE_OPTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => toggleScope(s)} className={`rounded-full border px-2.5 py-1 text-xs ${scopes.includes(s) ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}>{s}</button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">read/write/drive for data access; control for process/container actions; admin for privileged operations.</p>
              </div>
              <div className="space-y-1.5"><Label htmlFor="key-exp">Expires (optional, YYYY-MM-DD)</Label><Input id="key-exp" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} placeholder="2026-12-31" /></div>
            </div>
          )}
          <DialogFooter>
            {createdToken ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <Button onClick={() => { setActionError(null); create.mutate(); }} disabled={!name.trim() || create.isPending}>Create</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TableWrap>
        {isPending ? <div className="p-5 text-sm text-muted-foreground">Loading API keys…</div> :
         isError ? <Empty title="Could not load API keys" hint={error instanceof Error ? error.message : "Request failed"} /> :
         keys.length === 0 ? <Empty title="No API keys" hint="Create a key to allow external apps to access the KDG API with Authorization: Bearer <token>." /> : (
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40"><tr>{["Name","Prefix","Scopes","Status","Usage","Last used","Created","Actions"].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={tr}>
                  <td className={td}><div className="font-medium">{k.name}</div><div className="text-xs text-muted-foreground">by {k.createdBy ?? "—"}{k.expiresAt ? ` · expires ${k.expiresAt}` : ""}</div></td>
                  <td className={`${td} font-mono text-xs`}>{k.prefix}…</td>
                  <td className={td}><div className="flex flex-wrap gap-1">{k.scopes.map(s => <Pill key={s} tone={s === "admin" || s === "control" ? "warning" : "muted"}>{s}</Pill>)}</div></td>
                  <td className={td}><div className="flex items-center gap-2"><Switch checked={k.enabled} onCheckedChange={(v) => update.mutate({ id: k.id, payload: { enabled: v } })} /><span className="text-xs text-muted-foreground">{k.enabled ? "Enabled" : "Disabled"}</span></div></td>
                  <td className={`${td} tabular`}>{k.usageCount}</td>
                  <td className={`${td} text-xs text-muted-foreground`}>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "—"}</td>
                  <td className={`${td} text-xs text-muted-foreground`}>{k.createdAt ? new Date(k.createdAt).toLocaleString() : "—"}</td>
                  <td className={td}><Button size="sm" variant="outline" className="h-7 px-2 text-destructive" onClick={() => { if (window.confirm(`Revoke/delete API key "${k.name}"?`)) remove.mutate(k.id); }} title="Revoke"><Trash2 className="size-3.5" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
      <p className="mt-2 text-xs text-muted-foreground">Use keys via <code>Authorization: Bearer &lt;token&gt;</code> header. Session cookie auth continues to work for dashboard users. Key management requires owner/admin access.</p>
    </div>
  );
}
