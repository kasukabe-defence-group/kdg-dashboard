import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SeriesPoint } from "@/types";
import { useId } from "react";

interface Props {
  data: SeriesPoint[];
  keys: { key: string; color: string; label?: string }[];
  unit?: string;
  height?: number;
  max?: number;
}

export function MetricChart({ data, keys, unit = "", height = 180, max }: Props) {
  const chartId = useId().replace(/:/g, "");
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <defs>
            {keys.map((k) => (
              <linearGradient key={k.key} id={`${chartId}-${k.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={k.color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={k.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="t" tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={32} />
          <YAxis tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} axisLine={false} tickLine={false} domain={[0, max ?? "auto"]} />
          <Tooltip
            contentStyle={{ background: "var(--popover)", color: "var(--foreground)", border: "1px solid var(--glass-border)", borderRadius: 12, boxShadow: "var(--glass-shadow)", fontSize: 12 }}
            labelStyle={{ color: "var(--muted-foreground)" }}
            formatter={(v: number, n: string) => [`${v}${unit}`, keys.find((k) => k.key === n)?.label ?? n]}
          />
          {keys.map((k) => (
            <Area key={k.key} type="monotone" dataKey={k.key} stroke={k.color} strokeWidth={2} fill={`url(#${chartId}-${k.key})`} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
