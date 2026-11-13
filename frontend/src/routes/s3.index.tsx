import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Database, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/services/api/client";
import { PageHeader, TableWrap, th, td, tr, Pill, Empty } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bytes } from "@/utils/format";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";

export const Route = createFileRoute("/s3/")({
  head: () => ({ meta: [
    { title: "S3 Buckets · KDG Cloud" }, { name: "description", content: "S3-compatible object storage buckets on the KDG node." },
  ]}),
  component: BucketsPage,
});

function BucketsPage() {
  const qc = useQueryClient();
  const { can } = useSession();
  const [name, setName] = useState("");
  const { data: buckets = [], isPending, isError, error, refetch } = useQuery({
    queryKey: ["s3-buckets"],
    queryFn: api.s3Buckets,
    refetchInterval: 15000,
  });

  const create = useMutation({
    mutationFn: (n: string) => api.s3CreateBucket(n),
    onSuccess: () => {
      setName("");
      void qc.invalidateQueries({ queryKey: ["s3-buckets"] });
      toast.success("Bucket created");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to create bucket"),
  });

  const del = useMutation({
    mutationFn: (n: string) => api.s3DeleteBucket(n),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["s3-buckets"] });
      toast.success("Bucket deleted");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to delete bucket"),
  });

  const valid = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="S3 Object Storage"
        badge={<span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-500"><Database className="size-3.5" /> Filesystem-backed</span>}
        description="Buckets and objects stored on the KDG node (filesystem-backed storage)."
        actions={<Button variant="outline" size="sm" onClick={() => void refetch()}><RefreshCw className="size-4" /> Refresh</Button>}
      />
      {can("admin") && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border/80 bg-card/70 p-2">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="bucket-name" className="max-w-xs" />
          <Button size="sm" disabled={!valid || create.isPending} onClick={() => valid && create.mutate(name)}><Plus className="size-4" /> Create bucket</Button>
          <p className="text-xs text-muted-foreground">Lowercase letters, numbers, and hyphens. 3–63 chars.</p>
        </div>
      )}
      <TableWrap>
        {isPending ? (
          <div className="p-5 text-sm text-muted-foreground">Loading buckets…</div>
        ) : isError ? (
          <Empty title="Could not load buckets" hint={error instanceof Error ? error.message : "Request failed"} />
        ) : buckets.length === 0 ? (
          <Empty title="No buckets" hint={can("admin") ? "Create a bucket above to get started." : "No buckets are available."} icon={<Database className="size-6" />} />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40">
              <tr>{["Bucket", "Objects", "Size", "Region", "Versioning", "Access", "Created", "Actions"].map((h) => <th key={h} className={th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.name} className={tr}>
                  <td className={td}><Link to="/s3/$bucket" params={{ bucket: b.name }} className="font-medium text-primary hover:underline">{b.name}</Link></td>
                  <td className={td}>{b.objects.toLocaleString()}</td>
                  <td className={td}>{bytes(b.sizeBytes)}</td>
                  <td className={`${td} text-muted-foreground`}>{b.region}</td>
                  <td className={td}><Pill tone="muted">{b.versioning}</Pill></td>
                  <td className={td}><Pill tone={b.access === "Public read" ? "warning" : "muted"}>{b.access}</Pill></td>
                  <td className={`${td} text-muted-foreground`}>{b.created || "—"}</td>
                  <td className={td}>{can("admin") && (
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={del.isPending} onClick={() => del.mutate(b.name)}><Trash2 className="size-4" /> Delete</Button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </div>
  );
}
