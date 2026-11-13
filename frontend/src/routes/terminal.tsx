import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X, SquareTerminal, RefreshCw } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "@/services/api/client";
import { PageHeader, Pill } from "@/components/kdg/primitives";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/terminal")({
  head: () => ({ meta: [
    { title: "Terminal · KDG Cloud" }, { name: "description", content: "Interactive terminal sessions for the KDG host and containers." },
    { property: "og:title", content: "Terminal · KDG Cloud" }, { property: "og:description", content: "Interactive terminal sessions for the KDG host and containers." },
  ]}),
  component: TerminalPage,
});

interface Session {
  id: string;
  target: string;
  status: "connecting" | "ready" | "closed" | "error";
  error?: string;
}

function wsUrl(target: string, cols: number, rows: number) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const qs = new URLSearchParams({ target, cols: String(cols), rows: String(rows) });
  return `${proto}//${window.location.host}/api/v1/terminal/ws?${qs.toString()}`;
}

function TerminalPage() {
  const { data: containers = [] } = useQuery({ queryKey: ["containers"], queryFn: api.containers, refetchInterval: 15000 });
  const [target, setTarget] = useState("host");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const termsRef = useRef<Map<string, { term: Terminal; fit: FitAddon; ws: WebSocket; el: HTMLDivElement }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  const runningContainers = useMemo(() => containers.filter((c) => c.state === "running"), [containers]);

  const open = () => {
    const id = `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const s: Session = { id, target, status: "connecting" };
    setSessions((prev) => [...prev, s]);
    setActive(id);
    // create terminal next tick after render
    setTimeout(() => attach(id, target), 0);
  };

  const close = (id: string) => {
    const entry = termsRef.current.get(id);
    try { entry?.ws.close(); } catch {}
    try { entry?.term.dispose(); } catch {}
    try { entry?.el.remove(); } catch {}
    termsRef.current.delete(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActive((cur) => (cur === id ? (sessions.find((s) => s.id !== id)?.id ?? null) : cur));
  };

  const attach = (id: string, tgt: string) => {
    const host = document.getElementById(`term-${id}`);
    if (!host || termsRef.current.has(id)) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace', theme: { background: "#0b0f14" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();
    const ws = new WebSocket(wsUrl(tgt, term.cols, term.rows));
    const el = host as HTMLDivElement;
    termsRef.current.set(id, { term, fit, ws, el });

    ws.onopen = () => setSessions((prev) => prev.map((s) => s.id === id ? { ...s, status: "ready" } : s));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "output") term.write(msg.data || "");
        else if (msg.type === "error") { term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`); setSessions((prev) => prev.map((s) => s.id === id ? { ...s, status: "error", error: msg.message } : s)); }
        else if (msg.type === "ready") setSessions((prev) => prev.map((s) => s.id === id ? { ...s, status: "ready" } : s));
      } catch { term.write(ev.data); }
    };
    ws.onerror = () => setSessions((prev) => prev.map((s) => s.id === id ? { ...s, status: "error", error: "WebSocket error" } : s));
    ws.onclose = () => { setSessions((prev) => prev.map((s) => s.id === id ? { ...s, status: "closed" } : s)); term.writeln("\r\n\x1b[33m[session closed]\x1b[0m"); };
    term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data })); });
    term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows })); });
  };

  // fit active terminal on resize/visibility
  useEffect(() => {
    const onResize = () => {
      if (!active) return;
      const entry = termsRef.current.get(active);
      if (entry) { try { entry.fit.fit(); } catch {} }
    };
    window.addEventListener("resize", onResize);
    setTimeout(onResize, 50);
    return () => window.removeEventListener("resize", onResize);
  }, [active, sessions.length]);

  // cleanup on unmount
  useEffect(() => () => {
    for (const [id] of termsRef.current) close(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasActive = sessions.some((s) => s.status === "connecting" || s.status === "ready");
  useEffect(() => {
    if (!hasActive) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Active terminal session — closing this page may lose unsaved work.";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasActive]);

  const activeSession = sessions.find((s) => s.id === active);

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader title="Terminal" badge={<Pill tone="success">live PTY</Pill>} description="Interactive shell sessions via WebSocket (owner/admin). Host and running container targets supported."
        actions={<>
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm">
            <option value="host">Host (server shell)</option>
            {runningContainers.map((c) => <option key={c.id} value={c.name}>{c.name} (container)</option>)}
          </select>
          <Button size="sm" onClick={open}><Plus className="size-4" /> New session</Button>
        </>} />
      {hasActive && (
        <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Active terminal session in progress. If you close or refresh this page, the session may end and unsaved work/output can be lost.
        </div>
      )}
      <section className="panel overflow-hidden">
        <div className="flex items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
          {sessions.map((s) => (
            <div key={s.id} className={`flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs ${s.id === active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}>
              <button onClick={() => setActive(s.id)} className="flex items-center gap-1.5"><SquareTerminal className="size-3.5" />{s.target} <span className={`size-1.5 rounded-full ${s.status === "ready" ? "bg-emerald-500" : s.status === "connecting" ? "bg-amber-500" : s.status === "error" ? "bg-red-500" : "bg-muted-foreground"}`} /></button>
              <button aria-label="Close session" onClick={() => close(s.id)} className="opacity-60 hover:opacity-100"><X className="size-3" /></button>
            </div>
          ))}
          {sessions.length === 0 && <span className="px-2 py-1 text-xs text-muted-foreground">No open sessions. Select a target and click “New session”.</span>}
        </div>
        <div ref={containerRef} className="relative h-[65vh] bg-[#0b0f14]">
          {sessions.map((s) => (
            <div key={s.id} id={`term-${s.id}`} className="absolute inset-0 p-2" style={{ display: s.id === active ? "block" : "none" }} />
          ))}
          {sessions.length === 0 && <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Open a session to start an interactive terminal.</div>}
        </div>
        {activeSession?.status === "error" && <div className="border-t px-3 py-2 text-xs text-destructive">{activeSession.error || "Terminal connection error. Ensure you are logged in as owner/admin."}</div>}
      </section>
    </div>
  );
}
