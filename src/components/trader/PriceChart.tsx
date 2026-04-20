import { useMemo } from "react";
import type { Candle } from "@/mocks/types";
import { cn } from "@/lib/utils";

interface PriceChartProps {
  candles: Candle[];
  height?: number;
  className?: string;
  showMA?: boolean;
}

export function PriceChart({ candles, height = 280, className, showMA = true }: PriceChartProps) {
  const { path, area, ma20, min, max, width, points } = useMemo(() => {
    const w = 800;
    const h = height;
    const closes = candles.map((c) => c.c);
    const min = Math.min(...candles.map((c) => c.l));
    const max = Math.max(...candles.map((c) => c.h));
    const range = max - min || 1;
    const xStep = w / Math.max(1, candles.length - 1);
    const y = (v: number) => h - 8 - ((v - min) / range) * (h - 24);

    const points = candles.map((c, i) => ({ x: i * xStep, y: y(c.c) }));
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const area = `${path} L${(points[points.length - 1].x).toFixed(1)},${h} L0,${h} Z`;

    // MA20
    const maPoints: { x: number; y: number }[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < 19) continue;
      const slice = closes.slice(i - 19, i + 1);
      const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
      maPoints.push({ x: i * xStep, y: y(avg) });
    }
    const ma20 = maPoints.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

    return { path, area, ma20, min, max, width: w, points };
  }, [candles, height]);

  const last = candles[candles.length - 1];
  const first = candles[0];
  const change = ((last.c - first.c) / first.c) * 100;
  const up = change >= 0;

  return (
    <div className={cn("panel p-4", className)}>
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">BTC-USD · 1H</div>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="metric-value text-2xl font-semibold text-foreground">
              ${last.c.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <span className={cn("text-sm tabular", up ? "text-status-safe" : "text-status-blocked")}>
              {up ? "+" : ""}
              {change.toFixed(2)}%
            </span>
          </div>
        </div>
        <div className="text-right text-[11px] text-muted-foreground tabular space-y-0.5">
          <div>H ${Math.max(...candles.map((c) => c.h)).toFixed(0)}</div>
          <div>L ${Math.min(...candles.map((c) => c.l)).toFixed(0)}</div>
        </div>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="none" style={{ height }}>
        <defs>
          <linearGradient id="area-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.25" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* horizontal grid */}
        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1="0"
            x2={width}
            y1={height * p}
            y2={height * p}
            stroke="hsl(var(--border))"
            strokeDasharray="2 4"
            strokeWidth="1"
          />
        ))}
        <path d={area} fill="url(#area-grad)" />
        <path d={path} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" />
        {showMA && <path d={ma20} fill="none" stroke="hsl(var(--status-candidate))" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />}
        {/* last point */}
        <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="3" fill="hsl(var(--primary))" />
      </svg>
      <div className="flex items-center gap-4 text-[10px] uppercase tracking-wider text-muted-foreground mt-2">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 bg-primary" /> price
        </span>
        {showMA && (
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 bg-status-candidate" /> MA20
          </span>
        )}
      </div>
    </div>
  );
}
