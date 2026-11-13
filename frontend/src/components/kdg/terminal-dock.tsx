import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronsDown, ExternalLink, Loader2, Maximize2, MessageSquare, Minimize2,
  PanelRight, SquareTerminal, Terminal as TerminalIcon, X,
} from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "@/services/api/client";
import { useSession } from "@/hooks/use-session";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const XTERM_OPTIONS = {
  cursorBlink: true,
  fontSize: 12.5,
  lineHeight: 1.25,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  theme: {
    background: "#0b0f14",
    foreground: "#d7e2ea",
    cursor: "#7dd3fc",
    selectionBackground: "#1e3a5f",
    black: "#0b0f14",
    brightBlack: "#64748b",
  },
};

const QUICK = [
  { label: "status", cmd: "systemctl status kdg-api --no-pager -l | head -25", hint: "API service" },
  { label: "docker", cmd: "docker ps --format 'table {{.Names}}\\t{{.Status}}'", hint: "containers" },
  { label: "memory", cmd: "free -h", hint: "RAM" },
  { label: "disk", cmd: "df -h /", hint: "storage" },
  { label: "home", cmd: "kdg", hint: "server home screen" },
];

type Mode = "chat" | "dock";

function wsUrl(target: string, cols: number, rows: number) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const qs = new URLSearchParams({ target, cols: String(cols), rows: String(rows) });
  return `${proto}//${window.location.host}/api/v1/terminal/ws?${qs.toString()}`;
}

type Entry = { term: XTerm; fit: XFitAddon; ws: WebSocket; target: string };

export function TerminalDock() {
  const { user } = useSession();
  const canUse = user?.role === "owner" || user?.role === "admin";
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("chat");
  const [maximized, setMaximized] = useState(false);
  const [target, setTarget] = useState("host");
  const [status, setStatus] = useState<"idle" | "connecting" | "ready" | "closed" | "error">("idle");
  const [error, setError] = useState("");
  const hostRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<Entry | null>(null);
  const attachSeq = useRef(0);

  const containers = useQuery({
    queryKey: ["containers"],
    queryFn: api.containers,
    enabled: open && canUse,
    refetchInterval: open ? 30000 : false,
    staleTime: 15000,
  });
  const running = (containers.data ?? []).filter((c) => c.state === "running");

  const send = useCallback((data: string) => {
    const entry = entryRef.current;
    if (entry && entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify({ type: "input", data }));
  }, []);

  const fitNow = useCallback(() => {
    const entry = entryRef.current;
    if (!entry) return;
    try { entry.fit.fit(); } catch { /* hidden or zero-size */ }
  }, []);

  const dispose = useCallback(() => {
    attachSeq.current += 1;
    const entry = entryRef.current;
    if (!entry) return;
    try { entry.ws.close(); } catch { /* ignore */ }
    try { entry.term.dispose(); } catch { /* ignore */ }
    entryRef.current = null;
    if (hostRef.current) hostRef.current.innerHTML = "";
  }, []);

  const attach = useCallback(async (tgt: string) => {
    const host = hostRef.current;
    if (!host) return;
    dispose();
    const seq = attachSeq.current;
    host.innerHTML = "";
    setStatus("connecting");
    setError("");

    let TerminalCtor: typeof XTerm;
    let FitAddonCtor: typeof XFitAddon;
    try {
      const [xterm, fitAddon] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      TerminalCtor = xterm.Terminal;
      FitAddonCtor = fitAddon.FitAddon;
    } catch {
      setStatus("error");
      setError("Could not load the terminal renderer.");
      return;
    }
    if (seq !== attachSeq.current || !hostRef.current) return;

    const term = new TerminalCtor(XTERM_OPTIONS);
    const fit = new FitAddonCtor();
    term.loadAddon(fit);
    term.open(host);
    try { fit.fit(); } catch { /* ignore */ }
    const ws = new WebSocket(wsUrl(tgt, term.cols || 100, term.rows || 30));
    const entry: Entry = { term, fit, ws, target: tgt };
    entryRef.current = entry;
    const live = () => entryRef.current === entry;

    ws.onopen = () => { if (!live()) return; setStatus("ready"); term.focus(); };
    ws.onmessage = (ev) => {
      if (!live()) return;
      try {
        const msg = JSON.parse(ev.data) as { type?: string; data?: string; message?: string };
        if (msg.type === "output") term.write(msg.data || "");
        else if (msg.type === "error") {
          term.writeln(`\r\n\x1b[31m${msg.message ?? "terminal error"}\x1b[0m`);
          setStatus("error");
          setError(msg.message ?? "Terminal error");
        } else if (msg.type === "ready") setStatus("ready");
      } catch {
        term.write(ev.data);
      }
    };
    ws.onerror = () => { if (!live()) return; setStatus("error"); setError("WebSocket error — are you signed in as owner/admin?"); };
    ws.onclose = () => {
      if (!live()) return;
      setStatus((prev) => (prev === "error" ? prev : "closed"));
      term.writeln("\r\n\x1b[33m[session closed — press restart]\x1b[0m");
    };
    term.onData((data) => { if (live() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data })); });
    term.onResize(({ cols, rows }) => { if (live() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows })); });
  }, [dispose]);

  const restart = useCallback(() => attach(target), [attach, target]);

  // open / close from the topbar button and the keyboard shortcut
  useEffect(() => {
    const toggle = () => setOpen((o) => !o);
    const handler = () => { setOpen(true); setMode("chat"); };
    window.addEventListener("kdg:terminal", handler);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("kdg:terminal", handler);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  // attach lazily the first time it opens, then keep the session alive while hidden
  useEffect(() => {
    if (!open || !canUse) return;
    if (!entryRef.current || entryRef.current.target !== target) attach(target);
    const t = setTimeout(fitNow, 120);
    return () => clearTimeout(t);
  }, [open, canUse, target, attach, fitNow]);

  // refit when the layout changes
  useEffect(() => {
    if (!open) return;
    const t1 = setTimeout(fitNow, 60);
    const t2 = setTimeout(fitNow, 320);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [mode, maximized, open, fitNow]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => fitNow();
    window.addEventListener("resize", onResize);
    const ro = typeof ResizeObserver !== "undefined" && hostRef.current ? new ResizeObserver(() => fitNow()) : null;
    if (ro && hostRef.current) ro.observe(hostRef.current);
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [open, fitNow]);

  useEffect(() => () => dispose(), [dispose]);

  if (!canUse) return null;

  const statusDot = status === "ready" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-400 animate-pulse" : status === "error" ? "bg-red-500" : "bg-muted-foreground";

  return (
    <div
      className={cn(
        "panel fixed z-40 flex flex-col overflow-hidden shadow-2xl transition-all duration-200",
        mode === "dock"
          ? "inset-y-0 right-0 w-[min(600px,100vw)] rounded-none border-y-0 border-r-0"
          : maximized
            ? "inset-3 rounded-lg md:inset-6"
            : "bottom-20 right-3 h-[min(460px,72vh)] w-[min(540px,calc(100vw-1.5rem))] rounded-lg md:bottom-5 md:right-5",
        open ? "pointer-events-auto visible translate-y-0 opacity-100" : "pointer-events-none invisible translate-y-3 opacity-0",
      )}
      aria-hidden={!open}
    >
      <header className="glass-toolbar flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <span className={cn("size-2 rounded-full", statusDot)} />
        <TerminalIcon className="size-4 text-primary" />
        <span className="text-[12px] font-medium">server shell</span>
        <select
          value={target}
          onChange={(e) => { setTarget(e.target.value); setStatus("connecting"); }}
          className="h-6 max-w-[160px] rounded border bg-background px-1.5 text-[11px] text-muted-foreground"
          aria-label="Terminal target"
        >
          <option value="host">host</option>
          {running.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <span className="ml-auto flex items-center gap-0.5">
          <button
            title={mode === "dock" ? "Pop out as chat" : "Dock to the right"}
            onClick={() => { setMode((m) => (m === "dock" ? "chat" : "dock")); setMaximized(false); }}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {mode === "dock" ? <MessageSquare className="size-3.5" /> : <PanelRight className="size-3.5" />}
          </button>
          <button
            title={maximized ? "Restore" : "Maximize"}
            onClick={() => { setMode("chat"); setMaximized((m) => !m); }}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <button
            title="Restart session"
            onClick={restart}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Loader2 className={cn("size-3.5", status === "connecting" && "animate-spin")} />
          </button>
          <button
            title="Close (Ctrl+`)"
            onClick={() => setOpen(false)}
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </span>
      </header>

      <div className="flex items-center gap-1 overflow-x-auto border-b bg-muted/20 px-2 py-1.5">
        {QUICK.map((q) => (
          <button
            key={q.label}
            title={q.cmd}
            onClick={() => { send(`${q.cmd}\r`); }}
            disabled={status !== "ready"}
            className="shrink-0 rounded-full border bg-card px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground disabled:opacity-40"
          >
            {q.label}
          </button>
        ))}
        <span className="ml-auto hidden shrink-0 items-center gap-2 text-[10px] text-muted-foreground sm:flex">
          <span className="rounded border px-1 font-mono">Ctrl+`</span>
          <Link to="/terminal" onClick={() => setOpen(false)} className="inline-flex items-center gap-0.5 hover:text-foreground">
            full page <ExternalLink className="size-2.5" />
          </Link>
        </span>
      </div>

      <div className="relative min-h-0 flex-1 bg-[#0b0f14]">
        <div ref={hostRef} className="absolute inset-0 p-2" />
        {status === "connecting" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <span className="rounded-full border border-white/10 bg-black/60 px-2 py-0.5 text-[10px] text-white/70">connecting to host…</span>
          </div>
        )}
      </div>

      {status === "error" && (
        <div className="flex shrink-0 items-center gap-2 border-t border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          <span className="truncate">{error}</span>
          <button onClick={restart} className="ml-auto shrink-0 underline">retry</button>
        </div>
      )}

      {mode === "chat" && !maximized && (
        <button
          onClick={() => setMaximized(true)}
          className="absolute bottom-2 right-2 hidden rounded bg-black/40 p-1 text-white/40 hover:text-white md:block"
          title="Expand"
        >
          <ChevronsDown className="size-3 rotate-180" />
        </button>
      )}
    </div>
  );
}

export function TerminalDockButton() {
  const { user } = useSession();
  if (user?.role !== "owner" && user?.role !== "admin") return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-9"
      aria-label="Open terminal"
      title="Terminal — Ctrl+`"
      onClick={() => window.dispatchEvent(new Event("kdg:terminal"))}
    >
      <SquareTerminal className="size-4" />
    </Button>
  );
}

export function TerminalHint() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <SquareTerminal className="size-3" /> terminal docks anywhere · Ctrl+`
    </span>
  );
}
