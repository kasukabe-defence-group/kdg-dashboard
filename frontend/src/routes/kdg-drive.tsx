import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Archive, ChevronLeft, ChevronRight, Download, Eye, File, FileArchive, FileCode, FileImage, FileText, FileVideo,
  Folder, FolderPlus, HardDrive, Info, Pencil, RotateCcw, Search, Share2, Star, Trash2, Upload, X, CheckSquare, Square, Scissors,
} from "lucide-react";
import { PageHeader, TableWrap, th, td, tr, Empty, Pill } from "@/components/kdg/primitives";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Confirm } from "@/components/dialogs/confirm";
import { bytes } from "@/utils/format";
import { api } from "@/services/api/client";
import type { DriveItem, DriveShare, DriveStorage } from "@/types";
import { toast } from "sonner";

export const Route = createFileRoute("/kdg-drive")({
  head: () => ({ meta: [
    { title: "KDG Drive · KDG Cloud" }, { name: "description", content: "Personal and shared files stored on the KDG node." },
    { property: "og:title", content: "KDG Drive · KDG Cloud" }, { property: "og:description", content: "Personal and shared files stored on the KDG node." },
  ]}),
  component: DrivePage,
});

const icons = { folder: Folder, image: FileImage, video: FileVideo, pdf: FileText, text: FileText, code: FileCode, archive: FileArchive, other: File };
type View = "files" | "starred" | "shared" | "trash";
type Sort = "name" | "size" | "modified";
type DialogMode = "rename" | "move" | "share" | "details" | null;
type VideoOpts = { outputName: string; compress: boolean; videoCodec: "libx264" | "libx265" | "libvpx-vp9" | "copy"; crf: number; preset: string; videoBitrate: string; audioCodec: "aac" | "libopus" | "copy" | "none"; audioBitrate: string; scale: string; fps: string; trimStart: string; trimEnd: string; crop: string; outputFormat: "mp4" | "webm" | "mkv" | "mov"; useGpu: boolean };

function itemKind(item: DriveItem): keyof typeof icons {
  if (item.fileType === "folder") return "folder";
  const mime = item.mimeType ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("zip") || mime.includes("archive") || /\.(tar|gz|7z|rar)$/i.test(item.name)) return "archive";
  if (mime.startsWith("text/") || /\.(md|txt|csv)$/i.test(item.name)) return "text";
  if (mime.includes("javascript") || mime.includes("json") || /\.(ts|tsx|js|jsx|py|css|html|yaml|yml)$/i.test(item.name)) return "code";
  return "other";
}

function isPreviewable(item: DriveItem): "image" | "video" | null {
  if (item.fileType !== "file") return null;
  const kind = itemKind(item);
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  return null;
}

function formatModified(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatQuota(storage: DriveStorage | null) {
  if (!storage) return "Storage unavailable";
  if (storage.unlimited || storage.totalBytes === null) return `${bytes(storage.usedBytes)} used · Unlimited quota`;
  return `${bytes(storage.usedBytes)} used of ${bytes(storage.totalBytes)} quota`;
}

function breadcrumbs(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join("/")}` }));
}

function sharedRows(shares: DriveShare[]): DriveItem[] {
  return shares.map((share) => ({
    name: share.path.split("/").filter(Boolean).pop() ?? share.path,
    path: share.path,
    fileType: "file",
    mimeType: null,
    sizeBytes: 0,
    modified: null,
    etag: null,
    fileId: null,
    owner: share.shareWithDisplayName ?? share.shareWith ?? "Shared",
    starred: false,
    shared: true,
    trashed: false,
  }));
}

function Thumb({ item }: { item: DriveItem }) {
  const [failed, setFailed] = useState(false);
  const previewKind = isPreviewable(item);
  const Icon = icons[itemKind(item)];
  const token = (item.etag || item.modified || "").replace(/"/g, "");
  if (previewKind && !failed) {
    return <img src={api.drivePreviewUrl(item.path, 96, token)} alt="" loading="lazy" decoding="async" className="size-8 rounded-md object-cover bg-muted" onError={() => setFailed(true)} />;
  }
  return <Icon className={`size-4 ${item.fileType === "folder" ? "text-primary" : "text-muted-foreground"}`} />;
}

function Viewer({ item, onClose }: { item: DriveItem; onClose: () => void }) {
  const kind = isPreviewable(item);
  if (!kind) return null;
  const src = api.driveViewUrl(item.path);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[min(96vw,1100px)] p-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b flex flex-row items-center justify-between gap-3 space-y-0">
          <div className="min-w-0">
            <DialogTitle className="truncate text-sm font-medium">{item.name}</DialogTitle>
            <DialogDescription className="truncate text-xs">{item.path}{item.sizeBytes ? ` · ${bytes(item.sizeBytes)}` : ""}</DialogDescription>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button size="sm" variant="outline" onClick={() => window.location.assign(api.driveDownloadUrl(item.path))}><Download className="size-4" /> Download</Button>
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close"><X className="size-4" /></Button>
          </div>
        </DialogHeader>
        <div className="bg-black/90 flex items-center justify-center min-h-[40vh] max-h-[80vh]">
          {kind === "image" ? (
            <img src={src} alt={item.name} className="max-h-[80vh] max-w-full object-contain" />
          ) : (
            <video src={src} controls autoPlay playsInline preload="metadata" className="max-h-[80vh] max-w-full" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Staged = { id: string; file: File; previewUrl?: string; compressed?: File; compressing?: boolean };

function DrivePage() {
  const [view, setView] = useState<View>("files");
  const [currentPath, setCurrentPath] = useState("/");
  const [items, setItems] = useState<DriveItem[]>([]);
  const [storage, setStorage] = useState<DriveStorage | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [selected, setSelected] = useState<DriveItem | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [dialogValue, setDialogValue] = useState("");
  const [shareType, setShareType] = useState<"user" | "group" | "link">("user");
  const [shareWith, setShareWith] = useState("");
  const [writePermission, setWritePermission] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [uploadXhrs, setUploadXhrs] = useState<Record<string, XMLHttpRequest>>({});
  const [viewerItem, setViewerItem] = useState<DriveItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [staged, setStaged] = useState<Staged[]>([]);
  const [compressEnabled, setCompressEnabled] = useState(false);
  const [compressFormat, setCompressFormat] = useState<"image/jpeg" | "image/webp" | "image/png">("image/webp");
  const [compressQuality, setCompressQuality] = useState(0.8);
  const [compressMaxDim, setCompressMaxDim] = useState(1920);
  const [processItem, setProcessItem] = useState<DriveItem | null>(null);
  const [videoOpts, setVideoOpts] = useState<VideoOpts>({ outputName: "", compress: true, videoCodec: "libx264", crf: 28, preset: "veryfast", videoBitrate: "", audioCodec: "aac", audioBitrate: "128k", scale: "", fps: "", trimStart: "", trimEnd: "", crop: "", outputFormat: "mp4", useGpu: true });
  const [processing, setProcessing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadStorage = useCallback(async () => {
    try { setStorage(await api.driveStorage()); } catch {}
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (view === "files") {
        const params: { path: string; page: number; limit: number; sort: Sort; order: "asc" | "desc"; search?: string } = { path: currentPath, page, limit: 100, sort, order };
        if (search.trim()) params.search = search.trim();
        const result = await api.driveFiles(params);
        setItems(result.items);
        setTotal(result.total);
      } else if (view === "starred") {
        const result = await api.driveFavorites();
        setItems(result.filter((item) => !search || item.name.toLowerCase().includes(search.toLowerCase())));
        setTotal(result.length);
      } else if (view === "shared") {
        const result = await api.driveShares();
        const rows = sharedRows(result).filter((item) => !search || item.name.toLowerCase().includes(search.toLowerCase()));
        setItems(rows);
        setTotal(rows.length);
      } else {
        const result = await api.driveTrash();
        setItems(result.filter((item) => !search || item.name.toLowerCase().includes(search.toLowerCase())));
        setTotal(result.length);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "KDG Drive could not connect to Nextcloud.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [currentPath, order, page, search, sort, view]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadStorage(); }, [loadStorage]);
  useEffect(() => { setSelectedPaths(new Set()); }, [view, currentPath, page]);
  useEffect(() => () => { staged.forEach((s) => s.previewUrl && URL.revokeObjectURL(s.previewUrl)); }, []); // eslint-disable-line

  const crumbs = useMemo(() => breadcrumbs(currentPath), [currentPath]);
  const parentPath = currentPath === "/" ? "/" : currentPath.split("/").slice(0, -1).join("/") || "/";
  const pageCount = Math.max(1, Math.ceil(total / 100));
  const tabs: [View, string][] = [["files", "My files"], ["starred", "Starred"], ["shared", "Shared"], ["trash", "Trash"]];
  const uploading = Object.keys(uploadProgress).length > 0;

  useEffect(() => {
    if (!uploading) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "File upload in progress — closing this page will cancel the upload and data may not be saved.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [uploading]);

  const refresh = async () => { await Promise.all([load(), loadStorage()]); };

  const runAction = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(message);
      setDialogMode(null);
      setSelected(null);
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "The Drive action failed.");
    } finally {
      setBusy(false);
    }
  };

  const compressImage = async (file: File): Promise<File> => {
    if (!file.type.startsWith("image/")) return file;
    try {
      const bitmap = await createImageBitmap(file);
      let { width, height } = bitmap;
      const max = Math.max(256, compressMaxDim || 1920);
      if (width > max || height > max) {
        const scale = max / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return file;
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const q = Math.min(1, Math.max(0.1, compressQuality));
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, compressFormat, q));
      if (!blob) return file;
      if (blob.size >= file.size && compressFormat === file.type) return file;
      const ext = compressFormat === "image/jpeg" ? "jpg" : compressFormat === "image/webp" ? "webp" : "png";
      const base = file.name.replace(/\.[^.]+$/, "") || "image";
      return new File([blob], `${base}.${ext}`, { type: compressFormat, lastModified: Date.now() });
    } catch { return file; }
  };

  const stageFiles = (files: File[]) => {
    const next: Staged[] = files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: (file.type.startsWith("image/") || file.type.startsWith("video/")) ? URL.createObjectURL(file) : undefined,
    }));
    setStaged((prev) => [...prev, ...next]);
  };

  const onPickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length) stageFiles(files);
  };

  const removeStaged = (id: string) => {
    setStaged((prev) => {
      const s = prev.find((x) => x.id === id);
      if (s?.previewUrl) URL.revokeObjectURL(s.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const startUpload = async () => {
    if (!staged.length) return;
    setBusy(true);
    setUploadOpen(false);
    try {
      const prepared = await Promise.all(staged.map(async (s) => {
        if (compressEnabled && s.file.type.startsWith("image/")) return compressImage(s.file);
        return s.file;
      }));
      const xhrs: Record<string, XMLHttpRequest> = {};
      await api.uploadDriveFiles(currentPath, prepared, (file, percent) => setUploadProgress((old) => ({ ...old, [file.name]: percent })), (file, xhr) => { xhrs[file.name] = xhr; setUploadXhrs((o) => ({ ...o, [file.name]: xhr })); });
      toast.success(`${prepared.length} file${prepared.length === 1 ? "" : "s"} uploaded${compressEnabled ? " (image compression applied where supported)" : ""}`);
      staged.forEach((s) => s.previewUrl && URL.revokeObjectURL(s.previewUrl));
      setStaged([]);
      await refresh();
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "One or more uploads failed.";
      if (!/cancel/i.test(msg)) toast.error(msg);
    } finally {
      setBusy(false);
      setUploadProgress({});
      setUploadXhrs({});
    }
  };

  const cancelUpload = (name: string) => { uploadXhrs[name]?.abort(); };
  const cancelAllUploads = () => { Object.values(uploadXhrs).forEach((x) => x.abort()); };

  const toggleSelect = (path: string) => {
    setSelectedPaths((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
  };
  const allSelected = items.length > 0 && items.every((i) => selectedPaths.has(i.path));
  const toggleSelectAll = () => {
    setSelectedPaths(allSelected ? new Set() : new Set(items.map((i) => i.path)));
  };

  const bulkDelete = async () => {
    const paths = [...selectedPaths];
    if (!paths.length) return;
    setBusy(true);
    try {
      await Promise.all(paths.map((p) => view === "trash" ? api.deleteDriveTrash(p) : api.deleteDriveItem(p)));
      toast.success(view === "trash" ? "Selected items permanently deleted" : "Selected items moved to trash");
      setSelectedPaths(new Set());
      await refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Bulk delete failed"); }
    finally { setBusy(false); }
  };

  const bulkDownload = () => {
    const files = items.filter((i) => selectedPaths.has(i.path) && i.fileType === "file");
    if (!files.length) { toast.error("Select files to download (folders not supported for bulk download)."); return; }
    files.forEach((f) => window.open(api.driveDownloadUrl(f.path), "_blank"));
  };

  const openDialog = (mode: DialogMode, item: DriveItem) => {
    setSelected(item);
    setDialogMode(mode);
    setDialogValue(mode === "rename" ? item.name : mode === "move" ? parentPath : "");
    setShareType("user"); setShareWith(""); setWritePermission(false);
  };

  const openProcess = (item: DriveItem) => {
    setProcessItem(item);
    setVideoOpts({ outputName: "", compress: true, videoCodec: "libx264", crf: 28, preset: "veryfast", videoBitrate: "", audioCodec: "aac", audioBitrate: "128k", scale: "", fps: "", trimStart: "", trimEnd: "", crop: "", outputFormat: "mp4", useGpu: true });
  };

  const runVideoProcess = async () => {
    if (!processItem) return;
    setProcessing(true);
    try {
      const num = (v: string) => v.trim() === "" ? undefined : Number(v);
      const str = (v: string) => v.trim() === "" ? undefined : v.trim();
      const payload = {
        path: processItem.path,
        outputName: str(videoOpts.outputName),
        compress: videoOpts.compress,
        videoCodec: videoOpts.videoCodec,
        crf: videoOpts.videoBitrate.trim() ? null : videoOpts.crf,
        preset: videoOpts.preset,
        videoBitrate: str(videoOpts.videoBitrate) ?? null,
        audioCodec: videoOpts.audioCodec,
        audioBitrate: str(videoOpts.audioBitrate) ?? null,
        scale: str(videoOpts.scale) ?? null,
        fps: num(videoOpts.fps) ?? null,
        trimStart: num(videoOpts.trimStart) ?? null,
        trimEnd: num(videoOpts.trimEnd) ?? null,
        crop: str(videoOpts.crop) ?? null,
        outputFormat: videoOpts.outputFormat,
        useGpu: videoOpts.useGpu,
      };
      const res = await api.processDriveVideo(payload);
      toast.success(`Processed video saved: ${res.output?.name ?? "output file"}`);
      setProcessItem(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Video processing failed");
    } finally {
      setProcessing(false);
    }
  };

  const openFolder = (item: DriveItem) => {
    if (item.fileType === "folder") { setCurrentPath(item.path); setPage(1); setSearch(""); setView("files"); return; }
    const previewKind = isPreviewable(item);
    if (previewKind) { setViewerItem(item); return; }
    window.location.assign(api.driveDownloadUrl(item.path));
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="KDG Drive" description={formatQuota(storage)} actions={<>
        <input ref={inputRef} type="file" multiple className="hidden" onChange={onPickFiles} />
        <Button size="sm" variant="outline" disabled={busy || view !== "files"} onClick={() => { setSelected(null); setDialogValue(""); setDialogMode("details"); }}>
          <FolderPlus className="size-4" /> New folder
        </Button>
        <Button size="sm" disabled={busy || view !== "files"} onClick={() => setUploadOpen(true)}><Upload className="size-4" /> Upload</Button>
      </>} />

      {uploading && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <span>Uploads in progress. Closing/refreshing may cancel uploads and files may not be saved.</span>
          <Button size="sm" variant="outline" onClick={cancelAllUploads}>Cancel all</Button>
        </div>
      )}

      {storage && <div className="mb-4 panel px-4 py-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>Storage</span><span>{storage.percentageUsed === null ? "Unlimited" : `${storage.percentageUsed}% used`}</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${storage.percentageUsed === null ? 0 : Math.min(100, storage.percentageUsed)}%` }} /></div>
      </div>}

      {Object.keys(uploadProgress).length > 0 && <div className="mb-3 space-y-1 text-xs text-muted-foreground">{Object.entries(uploadProgress).map(([name, progress]) => (
        <div key={name} className="flex items-center justify-between gap-2">
          <span className="truncate">Uploading {name} — {progress}%</span>
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => cancelUpload(name)}>Cancel</Button>
        </div>
      ))}</div>}

      {selectedPaths.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium">{selectedPaths.size} selected</span>
          <Button size="sm" variant="outline" onClick={bulkDownload} disabled={busy}>Download files</Button>
          {view !== "shared" && <Button size="sm" variant="outline" onClick={() => void bulkDelete()} disabled={busy}>{view === "trash" ? "Delete permanently" : "Move to trash"}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setSelectedPaths(new Set())}>Clear</Button>
        </div>
      )}

      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1">{tabs.map(([value, label]) => <Button key={value} size="sm" variant={view === value ? "secondary" : "ghost"} onClick={() => { setView(value); setCurrentPath("/"); setPage(1); }}>{label}</Button>)}</div>
        <div className="flex gap-2"><div className="relative sm:w-72"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" /><Input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search files" className="h-9 pl-8" /></div>{view === "files" && <><select aria-label="Sort files" className="h-9 rounded-md border bg-background px-2 text-xs" value={sort} onChange={(event) => { setSort(event.target.value as Sort); setPage(1); }}><option value="name">Name</option><option value="size">Size</option><option value="modified">Modified</option></select><Button size="sm" variant="outline" onClick={() => setOrder((value) => value === "asc" ? "desc" : "asc")} aria-label={`Sort ${order === "asc" ? "descending" : "ascending"}`}>{order === "asc" ? "A→Z" : "Z→A"}</Button></>}</div>
      </div>

      {view === "files" && <nav className="mb-2 flex flex-wrap items-center gap-1 text-[13px] text-muted-foreground">
        <button onClick={() => { setCurrentPath("/"); setPage(1); }} className="flex items-center gap-1 hover:text-foreground"><HardDrive className="size-3.5" /> My files</button>
        {crumbs.map((crumb) => <span key={crumb.path} className="flex items-center gap-1"><ChevronRight className="size-3.5" /><button onClick={() => { setCurrentPath(crumb.path); setPage(1); }} className="hover:text-foreground">{crumb.name}</button></span>)}
      </nav>}

      {error && <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"><span>{error}</span><Button size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button></div>}
      {view === "files" && currentPath !== "/" && <Button size="sm" variant="ghost" className="mb-2" onClick={() => { setCurrentPath(parentPath); setPage(1); }}><ChevronLeft className="size-4" /> Back</Button>}

      <TableWrap>
        {loading ? <div className="space-y-3 p-4">{[1, 2, 3, 4].map((row) => <Skeleton key={row} className="h-9 w-full" />)}</div> : items.length === 0 ? <Empty title={error ? "Drive unavailable" : "Nothing here"} hint={error ? "Nextcloud returned a connection error. Retry after checking the server." : view === "trash" ? "Trash is empty." : "Upload files or create a folder."} icon={<Folder className="size-6" />} /> : <table className="w-full text-[13px]">
          <thead><tr>
            <th className={th}><button className="flex items-center" onClick={toggleSelectAll} aria-label="Select all">{allSelected ? <CheckSquare className="size-4" /> : <Square className="size-4" />}</button></th>
            {["Name", "Owner", "Modified", "Size", ""].map((heading) => <th key={heading} className={th}>{heading}</th>)}
          </tr></thead>
          <tbody>{items.map((item) => {
            const previewKind = isPreviewable(item);
            const checked = selectedPaths.has(item.path);
            return <tr key={`${item.path}-${item.fileId ?? "item"}`} className={tr}>
              <td className={td}><button onClick={() => toggleSelect(item.path)} aria-label={`Select ${item.name}`}>{checked ? <CheckSquare className="size-4" /> : <Square className="size-4 text-muted-foreground" />}</button></td>
              <td className={td}><button className="flex items-center gap-2 font-medium max-w-full" onClick={() => openFolder(item)}><span className="shrink-0 flex items-center justify-center size-8"><Thumb item={item} /></span> <span className="truncate text-left">{item.name}</span>{item.shared && <Pill tone="info">shared</Pill>}</button></td>
              <td className={`${td} text-muted-foreground`}>{item.owner ?? "—"}</td>
              <td className={`${td} text-muted-foreground`}>{formatModified(item.modified)}</td>
              <td className={`${td} tabular`}>{item.sizeBytes ? bytes(item.sizeBytes) : "—"}</td>
              <td className={`${td} text-right`}><div className="flex justify-end gap-1">
                {view === "trash" ? <><Button size="sm" variant="ghost" aria-label={`Restore ${item.name}`} onClick={() => void runAction(() => api.restoreDriveTrash(item.path), "Item restored")}><RotateCcw className="size-4" /></Button><Confirm trigger={<Button size="sm" variant="ghost" aria-label={`Delete ${item.name} permanently`}><Trash2 className="size-4" /></Button>} title="Delete permanently?" description={`This permanently deletes ${item.name} from Nextcloud.`} destructive confirmLabel="Delete permanently" onConfirm={() => void runAction(() => api.deleteDriveTrash(item.path), "Item permanently deleted")} /></> : <>
                  {previewKind && <Button size="sm" variant="ghost" aria-label={`View ${item.name}`} onClick={() => setViewerItem(item)}><Eye className="size-4" /></Button>}
                  {item.fileType === "file" && <Button size="sm" variant="ghost" aria-label={`Download ${item.name}`} onClick={() => window.location.assign(api.driveDownloadUrl(item.path))}><Download className="size-4" /></Button>}
                  {item.fileType === "file" && item.mimeType?.startsWith("video/") && <Button size="sm" variant="ghost" aria-label={`Process ${item.name}`} title="Server-side video compress/trim/crop" onClick={() => openProcess(item)}><Scissors className="size-4" /></Button>}
                  <Button size="sm" variant="ghost" aria-label={item.starred ? `Unstar ${item.name}` : `Star ${item.name}`} onClick={() => void runAction(() => api.setDriveFavorite(item.path, !item.starred), item.starred ? "Removed from Starred" : "Added to Starred")}><Star className={`size-4 ${item.starred ? "fill-warning text-warning" : ""}`} /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Rename ${item.name}`} onClick={() => openDialog("rename", item)}><Pencil className="size-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Move ${item.name}`} onClick={() => openDialog("move", item)}><Archive className="size-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Share ${item.name}`} onClick={() => openDialog("share", item)}><Share2 className="size-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Details for ${item.name}`} onClick={() => openDialog("details", item)}><Info className="size-4" /></Button>
                  <Confirm trigger={<Button size="sm" variant="ghost" aria-label={`Delete ${item.name}`}><Trash2 className="size-4" /></Button>} title="Move to trash?" description={`This moves ${item.name} to Nextcloud Trash.`} destructive confirmLabel="Move to trash" onConfirm={() => void runAction(() => api.deleteDriveItem(item.path), "Moved to trash")} />
                </>}
              </div></td>
            </tr>;
          })}</tbody>
        </table>}
      </TableWrap>

      {!loading && view === "files" && pageCount > 1 && <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground"><span>Page {page} of {pageCount}</span><div className="flex gap-1"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button><Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)}>Next</Button></div></div>}

      <Dialog open={uploadOpen} onOpenChange={(open) => { if (!open) setUploadOpen(false); else setUploadOpen(true); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upload files</DialogTitle>
            <DialogDescription>Select files to upload and preview before sending. <strong>Image compression</strong> runs in-browser when enabled. <strong>Video compression/trim/crop</strong> runs <strong>server-side on demand</strong> (ffmpeg) — upload the video first, then use the <strong>Process</strong> (scissors) action on it; resources are used only when you process.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => inputRef.current?.click()}><Upload className="size-4" /> Choose files</Button>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={compressEnabled} onChange={(e) => setCompressEnabled(e.target.checked)} /> Compress images before upload</label>
            </div>
            {compressEnabled && (
              <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
                <label className="space-y-1"><span className="text-xs text-muted-foreground">Image format</span>
                  <select className="h-9 w-full rounded-md border bg-background px-2" value={compressFormat} onChange={(e) => setCompressFormat(e.target.value as typeof compressFormat)}>
                    <option value="image/webp">WebP (recommended)</option>
                    <option value="image/jpeg">JPEG</option>
                    <option value="image/png">PNG</option>
                  </select>
                </label>
                <label className="space-y-1"><span className="text-xs text-muted-foreground">Max dimension (px)</span>
                  <Input type="number" min={256} max={8192} value={compressMaxDim} onChange={(e) => setCompressMaxDim(Number(e.target.value) || 1920)} />
                </label>
                <label className="space-y-1"><span className="flex justify-between text-xs text-muted-foreground"><span>Quality</span><span className="font-mono">{Math.round(compressQuality * 100)}%</span></span>
                  <input type="range" min={0.1} max={1} step={0.05} value={compressQuality} onChange={(e) => setCompressQuality(Number(e.target.value))} className="w-full" disabled={compressFormat === "image/png"} />
                </label>
              </div>
            )}
            {staged.length > 0 ? (
              <div className="max-h-64 space-y-2 overflow-auto rounded-lg border p-2">
                {staged.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 rounded-md border p-2">
                    <div className="size-14 shrink-0 overflow-hidden rounded-md bg-muted flex items-center justify-center">
                      {s.file.type.startsWith("image/") && s.previewUrl ? <img src={s.previewUrl} alt="" className="h-full w-full object-cover" /> :
                       s.file.type.startsWith("video/") && s.previewUrl ? <video src={s.previewUrl} className="h-full w-full object-cover" muted /> :
                       <File className="size-5 text-muted-foreground" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{s.file.name}</div>
                      <div className="text-xs text-muted-foreground">{s.file.type || "file"} · {bytes(s.file.size)}{s.file.type.startsWith("video/") ? " · video compression/trim/crop unavailable in browser" : ""}</div>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => removeStaged(s.id)} aria-label={`Remove ${s.file.name}`}><X className="size-4" /></Button>
                  </div>
                ))}
              </div>
            ) : <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No files selected yet.</div>}
            <p className="text-xs text-muted-foreground">To create a public shareable link, upload then use <strong>Share → Public link</strong> on the file.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { staged.forEach((s) => s.previewUrl && URL.revokeObjectURL(s.previewUrl)); setStaged([]); setUploadOpen(false); }}>Close</Button>
            <Button onClick={() => void startUpload()} disabled={!staged.length || busy}><Upload className="size-4" /> Upload {staged.length ? `(${staged.length})` : ""}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!processItem} onOpenChange={(open) => { if (!open && !processing) setProcessItem(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Process video (server-side)</DialogTitle>
            <DialogDescription>Runs ffmpeg on the server <strong>only when you click Process</strong> (no background resource use). Uses <strong>GPU encoding (NVENC)</strong> when available for faster H.264/H.265. Creates a new processed file in the same folder. Source: <span className="font-mono text-xs">{processItem?.name}</span></DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <label className="space-y-1 sm:col-span-2"><span className="text-xs text-muted-foreground">Output filename (optional)</span><Input value={videoOpts.outputName} onChange={(e) => setVideoOpts((o) => ({ ...o, outputName: e.target.value }))} placeholder="auto (e.g. video-compressed.mp4)" /></label>
            <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={videoOpts.compress} onChange={(e) => setVideoOpts((o) => ({ ...o, compress: e.target.checked }))} /> Compress / re-encode</label>
            <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={videoOpts.useGpu} onChange={(e) => setVideoOpts((o) => ({ ...o, useGpu: e.target.checked }))} /> Use GPU encoding when available (NVENC) — faster for H.264/H.265</label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Video codec</span><select className="h-9 w-full rounded-md border bg-background px-2" value={videoOpts.videoCodec} onChange={(e) => setVideoOpts((o) => ({ ...o, videoCodec: e.target.value as VideoOpts["videoCodec"] }))}><option value="libx264">H.264 (libx264)</option><option value="libx265">H.265 (libx265)</option><option value="libvpx-vp9">VP9 (webm)</option><option value="copy">Copy (no re-encode)</option></select></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Output format</span><select className="h-9 w-full rounded-md border bg-background px-2" value={videoOpts.outputFormat} onChange={(e) => setVideoOpts((o) => ({ ...o, outputFormat: e.target.value as VideoOpts["outputFormat"] }))}><option value="mp4">mp4</option><option value="webm">webm</option><option value="mkv">mkv</option><option value="mov">mov</option></select></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">CRF (quality, lower=better)</span><Input type="number" min={0} max={51} value={videoOpts.crf} onChange={(e) => setVideoOpts((o) => ({ ...o, crf: Number(e.target.value) }))} /></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Preset</span><select className="h-9 w-full rounded-md border bg-background px-2" value={videoOpts.preset} onChange={(e) => setVideoOpts((o) => ({ ...o, preset: e.target.value }))}>{["ultrafast","superfast","veryfast","faster","fast","medium","slow"].map(p=><option key={p} value={p}>{p}</option>)}</select></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Scale (e.g. 1280:-2, blank=keep)</span><Input value={videoOpts.scale} onChange={(e) => setVideoOpts((o) => ({ ...o, scale: e.target.value }))} placeholder="1280:-2" /></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">FPS (blank=keep)</span><Input value={videoOpts.fps} onChange={(e) => setVideoOpts((o) => ({ ...o, fps: e.target.value }))} placeholder="30" /></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Video bitrate (optional, e.g. 2M)</span><Input value={videoOpts.videoBitrate} onChange={(e) => setVideoOpts((o) => ({ ...o, videoBitrate: e.target.value }))} placeholder="overrides CRF if set" /></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Audio</span><select className="h-9 w-full rounded-md border bg-background px-2" value={videoOpts.audioCodec} onChange={(e) => setVideoOpts((o) => ({ ...o, audioCodec: e.target.value as VideoOpts["audioCodec"] }))}><option value="aac">AAC</option><option value="libopus">Opus</option><option value="copy">Copy</option><option value="none">None (remove audio)</option></select></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Trim start (seconds)</span><Input value={videoOpts.trimStart} onChange={(e) => setVideoOpts((o) => ({ ...o, trimStart: e.target.value }))} placeholder="0" /></label>
            <label className="space-y-1"><span className="text-xs text-muted-foreground">Trim end (seconds)</span><Input value={videoOpts.trimEnd} onChange={(e) => setVideoOpts((o) => ({ ...o, trimEnd: e.target.value }))} placeholder="e.g. 30" /></label>
            <label className="space-y-1 sm:col-span-2"><span className="text-xs text-muted-foreground">Crop (w:h:x:y, blank=none)</span><Input value={videoOpts.crop} onChange={(e) => setVideoOpts((o) => ({ ...o, crop: e.target.value }))} placeholder="1280:720:0:0" /></label>
            <p className="sm:col-span-2 text-xs text-muted-foreground">Processing can take time depending on video length/quality. No server resources are used until you click Process.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProcessItem(null)} disabled={processing}>Cancel</Button>
            <Button onClick={() => void runVideoProcess()} disabled={processing || !processItem}>{processing ? "Processing…" : "Process video"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogMode !== null} onOpenChange={(open) => { if (!open) { setDialogMode(null); setSelected(null); } }}>
        <DialogContent>
          {dialogMode === "details" && !selected && <><DialogHeader><DialogTitle>New folder</DialogTitle><DialogDescription>Create a folder in {currentPath}.</DialogDescription></DialogHeader><Input autoFocus value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} placeholder="Folder name" /><DialogFooter><Button variant="outline" onClick={() => setDialogMode(null)}>Cancel</Button><Button disabled={!dialogValue.trim() || busy} onClick={() => void runAction(() => api.createDriveFolder(currentPath, dialogValue.trim()), "Folder created")}>Create folder</Button></DialogFooter></>}
          {dialogMode === "rename" && selected && <><DialogHeader><DialogTitle>Rename item</DialogTitle><DialogDescription>Rename {selected.name} in Nextcloud.</DialogDescription></DialogHeader><Input autoFocus value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} /><DialogFooter><Button variant="outline" onClick={() => setDialogMode(null)}>Cancel</Button><Button disabled={!dialogValue.trim() || busy} onClick={() => void runAction(() => api.renameDriveItem(selected.path, dialogValue.trim()), "Item renamed")}>Rename</Button></DialogFooter></>}
          {dialogMode === "move" && selected && <><DialogHeader><DialogTitle>Move item</DialogTitle><DialogDescription>Enter the destination directory path.</DialogDescription></DialogHeader><Input autoFocus value={dialogValue} onChange={(event) => setDialogValue(event.target.value)} placeholder="/Projects" /><DialogFooter><Button variant="outline" onClick={() => setDialogMode(null)}>Cancel</Button><Button disabled={!dialogValue.trim() || busy} onClick={() => void runAction(() => api.moveDriveItem(selected.path, `${dialogValue.replace(/\/$/, "")}/${selected.name}`), "Item moved")}>Move</Button></DialogFooter></>}
          {dialogMode === "share" && selected && <><DialogHeader><DialogTitle>Share {selected.name}</DialogTitle><DialogDescription>Create a user/group share or a <strong>public shareable link</strong>.</DialogDescription></DialogHeader><select className="h-9 rounded-md border bg-background px-3 text-sm" value={shareType} onChange={(event) => setShareType(event.target.value as typeof shareType)}><option value="link">Public link (shareable)</option><option value="user">User share</option><option value="group">Group share</option></select>{shareType !== "link" && <Input value={shareWith} onChange={(event) => setShareWith(event.target.value)} placeholder={shareType === "user" ? "Nextcloud username" : "Nextcloud group"} />}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={writePermission} onChange={(event) => setWritePermission(event.target.checked)} /> Allow editing</label><DialogFooter><Button variant="outline" onClick={() => setDialogMode(null)}>Cancel</Button><Button disabled={busy || (shareType !== "link" && !shareWith.trim())} onClick={() => { const payload: { path: string; shareType: "user" | "group" | "link"; permissions: 1 | 31; shareWith?: string } = { path: selected.path, shareType, permissions: writePermission ? 31 : 1 }; if (shareType !== "link") payload.shareWith = shareWith.trim(); void runAction(() => api.createDriveShare(payload), shareType === "link" ? "Public link created" : "Share created"); }}>Create share</Button></DialogFooter></>}
          {dialogMode === "details" && selected && <><DialogHeader><DialogTitle>{selected.name}</DialogTitle><DialogDescription>Live metadata from Nextcloud.</DialogDescription></DialogHeader><dl className="divide-y text-sm"><div className="flex justify-between gap-4 py-2"><dt className="text-muted-foreground">Path</dt><dd className="break-all text-right">{selected.path}</dd></div><div className="flex justify-between gap-4 py-2"><dt className="text-muted-foreground">Type</dt><dd>{selected.mimeType ?? selected.fileType}</dd></div><div className="flex justify-between gap-4 py-2"><dt className="text-muted-foreground">Size</dt><dd>{bytes(selected.sizeBytes)}</dd></div><div className="flex justify-between gap-4 py-2"><dt className="text-muted-foreground">ETag</dt><dd className="break-all text-right font-mono text-xs">{selected.etag ?? "—"}</dd></div></dl><DialogFooter><Button variant="outline" onClick={() => void navigator.clipboard.writeText(selected.path).then(() => toast.success("Path copied"))}>Copy path</Button><Button onClick={() => setDialogMode(null)}>Close</Button></DialogFooter></>}
        </DialogContent>
      </Dialog>

      {viewerItem && <Viewer item={viewerItem} onClose={() => setViewerItem(null)} />}
    </div>
  );
}
