import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Database, Download, File, Folder, RefreshCw, Trash2, Upload } from "lucide-react";
import { api } from "@/services/api/client";
import { PageHeader, Panel, TableWrap, th, td, tr, Empty, Pill } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";
import { bytes } from "@/utils/format";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";

export const Route = createFileRoute("/s3/$bucket")({
  head: ({ params }) => ({ meta: [{ title: `${params.bucket} · S3 · KDG Cloud` }] }),
  component: BucketPage,
});

function BucketPage() {
  const { bucket } = Route.useParams();
  const qc = useQueryClient();
  const { can } = useSession();
  const [prefix, setPrefix] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { data: objects = [], isPending, isError, error, refetch } = useQuery({
    queryKey: ["s3-objects", bucket, prefix],
    queryFn: () => api.s3Objects(bucket, prefix),
    refetchInterval: 15000,
  });

  const del = useMutation({
    mutationFn: (key: string) => api.s3DeleteObject(bucket, key),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["s3-objects", bucket] }); toast.success("Deleted"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      for (const f of Array.from(files)) {
        const key = `${prefix}${f.name}`;
        await api.s3UploadObject(bucket, key, f);
      }
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["s3-objects", bucket] }); void qc.invalidateQueries({ queryKey: ["s3-buckets"] }); toast.success("Upload complete"); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Upload failed"),
  });

  const parts = prefix.split("/").filter(Boolean);
  const crumbs = parts.map((part, i) => ({ label: part, path: parts.slice(0, i + 1).join("/") + "/" }));

  return (
    <div className="mx-auto max-w-[1400px]">
      <Link to="/s3" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3" /> Buckets</Link>
      <PageHeader
        title={bucket}
        description="Browse and manage objects in this bucket."
        actions={<div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()}><RefreshCw className="size-4" /> Refresh</Button>
          {can("admin") && <Button size="sm" onClick={() => inputRef.current?.click()} disabled={upload.isPending}><Upload className="size-4" /> Upload</Button>}
          <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) upload.mutate(e.target.files); e.currentTarget.value = ""; }} />
        </div>}
      />

      <Panel className="mb-3" title="Path">
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <button className={`hover:text-primary ${prefix ? "text-muted-foreground" : "font-medium text-foreground"}`} onClick={() => setPrefix("")}>{bucket}</button>
          {crumbs.map((c) => (
            <span key={c.path} className="inline-flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <button className="text-muted-foreground hover:text-primary" onClick={() => setPrefix(c.path)}>{c.label}</button>
            </span>
          ))}
        </div>
      </Panel>

      <TableWrap>
        {isPending ? (
          <div className="p-5 text-sm text-muted-foreground">Loading objects…</div>
        ) : isError ? (
          <Empty title="Could not load objects" hint={error instanceof Error ? error.message : "Request failed"} />
        ) : objects.length === 0 ? (
          <Empty title="No objects" hint={prefix ? "This folder is empty." : "Upload files to this bucket to get started."} icon={<Database className="size-6" />} />
        ) : (
          <table className="w-full text-[13px]">
            <thead className="bg-muted/40"><tr>{["Name", "Size", "Modified", "Type", "Actions"].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
            <tbody>
              {objects.map((o) => (
                <tr key={o.key} className={tr}>
                  <td className={td}>
                    {o.isPrefix ? (
                      <button className="inline-flex items-center gap-2 font-medium text-primary hover:underline" onClick={() => setPrefix(o.key)}>
                        <Folder className="size-4 text-amber-500" /> {o.key.slice(prefix.length).replace(/\/$/, "")}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-2"><File className="size-4 text-muted-foreground" /> {o.key.slice(prefix.length)}</span>
                    )}
                  </td>
                  <td className={`${td} text-muted-foreground`}>{o.isPrefix ? "—" : bytes(o.sizeBytes)}</td>
                  <td className={`${td} text-muted-foreground`}>{o.modified || "—"}</td>
                  <td className={td}>{o.isPrefix ? <Pill tone="muted">folder</Pill> : <span className="text-xs text-muted-foreground">{o.contentType || "file"}</span>}</td>
                  <td className={td}>
                    <div className="flex items-center gap-1">
                      {!o.isPrefix && <a href={api.s3DownloadUrl(bucket, o.key)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-primary hover:bg-accent"><Download className="size-3.5" /> Download</a>}
                      {can("admin") && <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={del.isPending} onClick={() => del.mutate(o.key)}><Trash2 className="size-3.5" /> Delete</Button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableWrap>
    </div>
  );
}
