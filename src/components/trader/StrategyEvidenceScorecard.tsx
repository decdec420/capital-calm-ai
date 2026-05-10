// ============================================================
// StrategyEvidenceScorecard — P0.5
// ------------------------------------------------------------
// Shows full strategy evidence metrics with sample-quality guard.
// Never shows fake/zeroed metrics. If trades < MIN_SAMPLE_FOR_METRICS,
// every derived metric shows "Insufficient data".
//
// Uses existing StrategyMetrics from domain-types.
// Uses computeStrategyScore from StrategyGradeBadge (no duplication).
// ============================================================

import { cn } from "@/lib/utils";
import type { StrategyVersion, StrategyMetrics } from "@/lib/domain-types";
import { computeStrategyScore, StrategyGradeBadge } from "./StrategyGradeBadge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Info } from "lucide-react";
import type { ReactNode } from "react";

// ─── sample quality ───────────────────────────────────────────────────────────

/** Minimum trades required to show any derived metric. */
export const MIN_SAMPLE_FOR_METRICS = 5;

/** Minimum trades for "building data" label. */
export const MIN_SAMPLE_BUILDING = 30;

/** Minimum trades for "significant sample" label. */
export const MIN_SAMPLE_SIGNIFICANT = 100;

export type SampleQualityLabel =
  | "Insufficient data (< 5)"
  | "Very early data (5–29)"
  | "Building data (30–99)"
  | "Significant (≥ 100)";

export function getSampleQualityLabel(trades: number): SampleQualityLabel {
  if (trades < MIN_SAMPLE_FOR_METRICS) return "Insufficient data (< 5)";
  if (trades < MIN_SAMPLE_BUILDING) return "Very early data (5–29)";
  if (trades < MIN_SAMPLE_SIGNIFICANT) return "Building data (30–99)";
  return "Significant (≥ 100)";
}

/** True when the sample is large enough to show derived metrics. */
export function hasSufficientData(trades: number): boolean {
  return trades >= MIN_SAMPLE_FOR_METRICS;
}

/** True when paper promotion threshold is met (30 trades). */
export function isPaperPromotionEligible(trades: number): boolean {
  return trades >= MIN_SAMPLE_BUILDING;
}

/** True when live promotion threshold is met (100 trades). */
export function isLivePromotionEligible(trades: number): boolean {
  return trades >= MIN_SAMPLE_SIGNIFICANT;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const NA = "—";

function fmt(
  value: number | undefined | null,
  formatter: (v: number) => string,
  sufficient: boolean,
): string {
  if (!sufficient || value == null) return NA;
  return formatter(value);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function r2(v: number): string {
  return v.toFixed(2);
}

function r2pos(v: number): string {
  return v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
}

// ─── MetricRow ────────────────────────────────────────────────────────────────

function MetricRow({
  label,
  value,
  tooltip,
  highlight,
}: {
  label: string;
  value: string;
  tooltip?: string;
  highlight?: "good" | "bad" | "neutral";
}) {
  const valueColor =
    highlight === "good"
      ? "text-status-safe"
      : highlight === "bad"
        ? "text-status-blocked"
        : "text-foreground";

  return (
    <div className="flex items-center justify-between gap-2 py-1 border-b border-border/30 last:border-b-0">
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-xs text-muted-foreground truncate">{label}</span>
        {tooltip && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3 w-3 text-muted-foreground/50 shrink-0 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[200px] text-xs">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <span className={cn("text-xs font-medium tabular shrink-0", valueColor, value === NA && "text-muted-foreground/50")}>
        {value}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mt-3 mb-1 first:mt-0">
      {children}
    </div>
  );
}

// ─── component ────────────────────────────────────────────────────────────────

interface StrategyEvidenceScorecardProps {
  strategy: StrategyVersion;
  className?: string;
}

export function StrategyEvidenceScorecard({
  strategy,
  className,
}: StrategyEvidenceScorecardProps) {
  const m: StrategyMetrics = strategy.metrics;
  const trades = m.trades ?? 0;
  const sufficient = hasSufficientData(trades);
  const { grade, gradeColor } = computeStrategyScore(m);
  const qualityLabel = getSampleQualityLabel(trades);
  const paperEligible = isPaperPromotionEligible(trades);
  const liveEligible = isLivePromotionEligible(trades);

  // Highlight direction helpers
  const winRateHighlight = sufficient
    ? m.winRate >= 0.55 ? "good" : m.winRate >= 0.45 ? "neutral" : "bad"
    : "neutral";
  const expectancyHighlight = sufficient
    ? m.expectancy > 0 ? "good" : "bad"
    : "neutral";
  const sharpeHighlight = sufficient
    ? m.sharpe >= 1.0 ? "good" : m.sharpe >= 0.5 ? "neutral" : "bad"
    : "neutral";
  const drawdownHighlight = sufficient
    ? m.maxDrawdown <= 0.15 ? "good" : m.maxDrawdown <= 0.25 ? "neutral" : "bad"
    : "neutral";
  const pfHighlight = sufficient && m.profitFactor != null
    ? m.profitFactor >= 1.5 ? "good" : m.profitFactor >= 1.0 ? "neutral" : "bad"
    : "neutral";

  return (
    <div className={cn("panel p-4 space-y-1", className)}>
      {/* Header */}
      <div className="flex items-start gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            Strategy evidence scorecard
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground truncate">
              {strategy.displayName ?? strategy.name}
            </span>
            <span className="text-[10px] text-muted-foreground">v{strategy.version}</span>
            <StrategyGradeBadge metrics={m} size="sm" />
          </div>
          {strategy.friendlySummary && (
            <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{strategy.friendlySummary}</p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className={cn("text-2xl font-bold tabular", gradeColor)}>{grade}</div>
          <div className="text-[10px] text-muted-foreground">score</div>
        </div>
      </div>

      {/* Sample quality banner */}
      <div
        className={cn(
          "rounded-md px-3 py-2 flex items-center justify-between",
          !sufficient
            ? "bg-status-blocked/5 border border-status-blocked/20"
            : trades < MIN_SAMPLE_SIGNIFICANT
              ? "bg-status-caution/5 border border-status-caution/20"
              : "bg-status-safe/5 border border-status-safe/20",
        )}
      >
        <span className="text-xs font-medium">
          {trades.toLocaleString()} trade{trades !== 1 ? "s" : ""}
        </span>
        <span
          className={cn(
            "text-[10px] font-semibold",
            !sufficient ? "text-status-blocked" : trades < MIN_SAMPLE_SIGNIFICANT ? "text-status-caution" : "text-status-safe",
          )}
        >
          {qualityLabel}
        </span>
      </div>

      {/* Metrics */}
      <SectionLabel>Performance</SectionLabel>
      <MetricRow
        label="Win rate"
        value={fmt(m.winRate, pct, sufficient)}
        highlight={winRateHighlight}
        tooltip="Percentage of closed trades that were profitable."
      />
      <MetricRow
        label="Expectancy"
        value={fmt(m.expectancy, r2pos, sufficient)}
        highlight={expectancyHighlight}
        tooltip="Average R earned per trade. Positive = edge exists."
      />
      <MetricRow
        label="Avg win"
        value={fmt(m.avgWin, (v) => `+${r2(v)}R`, sufficient)}
        tooltip="Average winning trade in R-multiples."
      />
      <MetricRow
        label="Avg loss"
        value={fmt(m.avgLoss, (v) => `-${r2(v)}R`, sufficient)}
        tooltip="Average losing trade in R-multiples (shown as positive)."
      />
      <MetricRow
        label="Profit factor"
        value={
          !sufficient
            ? NA
            : m.profitFactor == null
              ? NA
              : m.profitFactor >= 999
                ? "∞ (no losses)"
                : r2(m.profitFactor)
        }
        highlight={pfHighlight}
        tooltip="Gross profit ÷ gross loss. > 1.5 is solid."
      />

      <SectionLabel>Risk</SectionLabel>
      <MetricRow
        label="Max drawdown"
        value={fmt(m.maxDrawdown, pct, sufficient)}
        highlight={drawdownHighlight}
        tooltip="Largest peak-to-trough equity decline in the backtest."
      />
      <MetricRow
        label="Sharpe ratio"
        value={fmt(m.sharpe, r2, sufficient)}
        highlight={sharpeHighlight}
        tooltip="Annualized risk-adjusted return. ≥ 1.0 is acceptable, ≥ 2.0 is excellent."
      />
      <MetricRow
        label="Fees / slippage"
        value="~0.1% round-trip (assumed)"
        tooltip="Fee and slippage assumption used in backtesting. Actual costs may differ."
      />

      {/* Promotion eligibility */}
      <SectionLabel>Promotion eligibility</SectionLabel>
      <MetricRow
        label="Paper promotion"
        value={paperEligible ? `Eligible (≥ ${MIN_SAMPLE_BUILDING} trades)` : `Not yet (need ${MIN_SAMPLE_BUILDING - trades} more)`}
        highlight={paperEligible ? "good" : "neutral"}
      />
      <MetricRow
        label="Live promotion"
        value={liveEligible ? `Eligible (≥ ${MIN_SAMPLE_SIGNIFICANT} trades)` : `Not yet (need ${MIN_SAMPLE_SIGNIFICANT - trades} more)`}
        highlight={liveEligible ? "good" : "neutral"}
      />

      {!sufficient && (
        <p className="text-[10px] text-muted-foreground/70 italic mt-2">
          Metric values show — until {MIN_SAMPLE_FOR_METRICS}+ trades are recorded. Run more simulations to build evidence.
        </p>
      )}
    </div>
  );
}
