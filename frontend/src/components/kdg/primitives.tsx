import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FlaskConical } from "lucide-react";

type Tone = "success" | "warning" | "destructive" | "muted" | "info" | "primary";
const toneCls: Record<Tone, string> = {
  success: "text-success bg-success/10 border-success/25",
  warning: "text-warning bg-warning/10 border-warning/25",
  destructive: "text-destructive bg-destructive/10 border-destructive/25",
  info: "text-info bg-info/10 border-info/25",
  primary: "text-primary bg-primary/10 border-primary/25",
  muted: "text-muted-foreground bg-muted border-border",
};
const dotCls: Record<Tone, string> = {
  success: "bg-success", warning: "bg-warning", destructive: "bg-destructive",
  info: "bg-info", primary: "bg-primary", muted: "bg-muted-foreground",
};

export function toneFor(s: string): Tone {
  if (["running", "active", "success", "installed-running", "healthy", "Enabled", "connected"].includes(s)) return "success";
  if (["unhealthy", "error", "critical", "failed", "disabled"].includes(s)) return "destructive";
  if (["restarting", "warning", "invited", "denied", "Suspended"].includes(s)) return "warning";
  if (["info", "available"].includes(s)) return "info";
  return "muted";
}

export function Pill({ tone = "muted", children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium leading-none whitespace-nowrap", toneCls[tone], className)}>
      {dot && <span className={cn("size-1.5 rounded-full", dotCls[tone])} />}
      {children}
    </span>
  );
}

export function Status({ value, label }: { value: string; label?: string }) {
  return <Pill tone={toneFor(value)} dot>{label ?? value.replace("installed-", "")}</Pill>;
}

export function Simulated({ className }: { className?: string }) {
  return (
    <span title="Mock data — not connected to a live backend" className={cn("inline-flex items-center gap-1 rounded-sm border border-dashed border-warning/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning", className)}>
      <FlaskConical className="size-3" /> Mock
    </span>
  );
}

export function PageHeader({ title, description, actions, badge }: { title: string; description?: string; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <div className="page-enter mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-medium tracking-tight sm:text-[28px]">{title}</h1>
          {badge}
        </div>
        {description && <p className="mt-1.5 max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cn("panel overflow-hidden", className)}>
      {title && (
        <header className="flex min-h-12 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
          <h2 className="text-sm font-medium tracking-tight">{title}</h2>
          {actions}
        </header>
      )}
      <div className={cn("p-4", bodyClass)}>{children}</div>
    </section>
  );
}

export function Meter({ value, tone, className }: { value: number; tone?: Tone; className?: string }) {
  const t = tone ?? (value > 85 ? "destructive" : value > 70 ? "warning" : "primary");
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full transition-all", dotCls[t])} style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

export function Stat({ label, value, sub, meter, icon }: { label: string; value: ReactNode; sub?: ReactNode; meter?: number; icon?: ReactNode }) {
  return (
    <div className="panel stat-card min-w-0 p-4">
      <div className="flex items-center justify-between">
        <span className="label-caps">{label}</span>
        <span className="grid size-8 place-items-center rounded-xl border border-border bg-muted/40 text-foreground">{icon}</span>
      </div>
      <div className="mt-3 break-words text-[26px] font-medium leading-tight tracking-tight tabular">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground tabular">{sub}</div>}
      {meter !== undefined && <Meter value={meter} className="mt-2.5" />}
    </div>
  );
}

export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="divide-y text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-start justify-between gap-4 py-2">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right font-medium break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="text-muted-foreground">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("panel overflow-x-auto", className)}>{children}</div>;
}

export const th = "h-9 px-3 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground whitespace-nowrap";
export const td = "px-3 py-2.5 whitespace-nowrap";
export const tr = "border-t hover:bg-accent/40 transition-colors";
