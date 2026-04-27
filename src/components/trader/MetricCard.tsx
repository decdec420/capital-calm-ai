import { cn } from "@/lib/utils";
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpRight } from "lucide-react";
import { ExplainIcon } from "./Explain";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "./Sparkline";
import type { ReactNode } from "react";

interface MetricCardProps {
  label: string;
  value: string | number;
  hint?: string;
  delta?: { value: string; direction: "up" | "down" | "flat" };
  tone?: "default" | "safe" | "caution" | "blocked" | "accent";
  icon?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
  /** Plain-English meaning. Surfaces as a hover tooltip on a tiny ⓘ next to the label. */
  explain?: ReactNode;
  /** When provided, the whole card becomes clickable. */
  onClick?: () => void;
  /** Optional aria label for the interactive surface. */
  interactiveLabel?: string;
  /** When true, render a skeleton placeholder instead of content. */
  loading?: boolean;
  /** Optional inline freshness indicator rendered beside the value. */
  freshness?: ReactNode;
  /** Optional 8-10 point sparkline rendered below the body. */
  sparkValues?: number[];
  /** Optional thin progress bar pinned to the bottom edge. */
  progress?: { value: number; max: number; tone?: "safe" | "caution" | "blocked" };
  /** Optional second-line context (e.g. "prev: +$0.03"). */
  sublabel?: string;
}

const toneRing: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  default: "",
  safe: "ring-1 ring-inset ring-status-safe/20",
  caution: "ring-1 ring-inset ring-status-caution/25",
  blocked: "ring-1 ring-inset ring-status-blocked/25",
  accent: "ring-1 ring-inset ring-primary/25",
};

const progressFill: Record<NonNullable<NonNullable<MetricCardProps["progress"]>["tone"]>, string> = {
  safe: "bg-status-safe",
  caution: "bg-status-caution",
  blocked: "bg-status-blocked",
};

export function MetricCard({
  label,
  value,
  hint,
  delta,
  tone = "default",
  icon,
  className,
  children,
  explain,
  onClick,
  interactiveLabel,
  loading,
  freshness,
  sparkValues,
  progress,
  sublabel,
}: MetricCardProps) {
  if (loading) {
    return (
      <div className={cn("panel p-4 flex flex-col gap-2", className)}>
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-2 w-12" />
      </div>
    );
  }

  const interactive = !!onClick;
  const progressPct = progress
    ? Math.max(0, Math.min(100, (progress.value / Math.max(progress.max, 1e-9)) * 100))
    : 0;
  const fillClass = progress ? progressFill[progress.tone ?? "safe"] : "";

  const inner = (
    <>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
          {explain && <ExplainIcon title={label} hint={explain} />}
        </div>
        <div className="flex items-center gap-1">
          {icon && <span className="text-muted-foreground">{icon}</span>}
          {interactive && (
            <ArrowUpRight className="h-3 w-3 text-muted-foreground/50 group-hover:text-primary group-hover:-translate-y-0.5 group-hover:translate-x-0.5 transition-all" />
          )}
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="metric-value text-xl font-semibold text-foreground">{value}</span>
        {delta && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs tabular",
              delta.direction === "up" && "text-status-safe",
              delta.direction === "down" && "text-status-blocked",
              delta.direction === "flat" && "text-muted-foreground",
            )}
          >
            {delta.direction === "up" && <ArrowUp className="h-3 w-3" />}
            {delta.direction === "down" && <ArrowDown className="h-3 w-3" />}
            {delta.direction === "flat" && <ArrowRight className="h-3 w-3" />}
            {delta.value}
          </span>
        )}
        {freshness}
      </div>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {sublabel && (
        <span className="text-[10px] text-muted-foreground/70 -mt-1">{sublabel}</span>
      )}
      {children}
      {sparkValues && sparkValues.length >= 2 && (
        <div className="mt-1 -mx-1">
          <Sparkline values={sparkValues} height={28} />
        </div>
      )}
    </>
  );

  const baseClass = cn(
    "panel p-4 flex flex-col gap-2 animate-fade-in text-left w-full relative overflow-hidden",
    toneRing[tone],
    interactive &&
      "group cursor-pointer transition-all hover:border-primary/40 hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
    className,
  );

  const progressBar = progress ? (
    <div
      className="absolute bottom-0 left-0 right-0 h-[3px] bg-secondary/60"
      aria-hidden
    >
      <div
        className={cn("h-full transition-all", fillClass)}
        style={{ width: `${progressPct}%` }}
      />
    </div>
  ) : null;

  if (interactive) {
    return (
      <button type="button" onClick={onClick} aria-label={interactiveLabel ?? label} className={baseClass}>
        {inner}
        {progressBar}
      </button>
    );
  }

  return (
    <div className={baseClass}>
      {inner}
      {progressBar}
    </div>
  );
}
