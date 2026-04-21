import { cn } from "@/lib/utils";

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  /** Force a tone; otherwise inferred from first vs last value. */
  tone?: "safe" | "blocked" | "neutral";
}

/**
 * Lightweight inline SVG sparkline. No deps. Tone-aware stroke + soft fill.
 */
export function Sparkline({ values, width = 240, height = 56, className, tone }: SparklineProps) {
  if (!values || values.length < 2) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-[10px] uppercase tracking-wider text-muted-foreground/60 border border-dashed border-border rounded-md",
          className,
        )}
        style={{ width: "100%", height }}
      >
        not enough history yet
      </div>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / span) * height;
    return [x, y] as const;
  });

  const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const areaPath = `${path} L ${width} ${height} L 0 ${height} Z`;

  const inferred = tone ?? (values[values.length - 1] >= values[0] ? "safe" : "blocked");
  const stroke =
    inferred === "safe"
      ? "hsl(var(--status-safe))"
      : inferred === "blocked"
        ? "hsl(var(--status-blocked))"
        : "hsl(var(--muted-foreground))";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("w-full block", className)}
      style={{ height }}
    >
      <defs>
        <linearGradient id={`spark-fill-${inferred}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#spark-fill-${inferred})`} />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
