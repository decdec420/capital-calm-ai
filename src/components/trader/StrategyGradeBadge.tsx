// StrategyGradeBadge — Feature 2: Confidence/Risk Scorecard
// Computes a letter grade from strategy metrics and renders it as a compact badge
// with separate confidence and risk indicators.

import type { StrategyMetrics } from "@/lib/domain-types";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ─── Grade computation ────────────────────────────────────────────
// Confidence score (0–80 pts):
//   Expectancy:  clamp(exp / 1.5, 0, 1) × 30  — 1.5R+ = full score
//   Win rate:    winRate × 30                   — 100% = full score
//   Sharpe:      clamp(sharpe / 2.0, 0, 1) × 20 — 2.0+ = full score
// Risk score (0–20 pts):
//   Drawdown:    (1 - clamp(maxDrawdown / 0.30, 0, 1)) × 20 — 0% DD = full score
// Total out of 100.
export function computeStrategyScore(m: StrategyMetrics): {
  total: number;
  confidence: number;
  risk: number;
  grade: string;
  gradeColor: string;
} {
  if ((m.trades ?? 0) === 0) {
    return { total: 0, confidence: 0, risk: 0, grade: "N/A", gradeColor: "text-muted-foreground" };
  }
  const expScore  = Math.min(Math.max(m.expectancy  / 1.5, 0), 1) * 30;
  const winScore  = Math.min(Math.max(m.winRate,       0), 1) * 30;
  const sharpeScore = Math.min(Math.max(m.sharpe / 2.0, 0), 1) * 20;
  const ddScore   = (1 - Math.min(Math.max(m.maxDrawdown / 0.30, 0), 1)) * 20;

  const confidence = expScore + winScore + sharpeScore; // 0–80
  const risk       = ddScore;                            // 0–20
  const total      = confidence + risk;                  // 0–100

  let grade: string;
  let gradeColor: string;
  if (total >= 88)       { grade = "A+"; gradeColor = "text-status-safe"; }
  else if (total >= 76)  { grade = "A";  gradeColor = "text-status-safe"; }
  else if (total >= 64)  { grade = "B";  gradeColor = "text-primary"; }
  else if (total >= 52)  { grade = "C";  gradeColor = "text-status-caution"; }
  else if (total >= 40)  { grade = "D";  gradeColor = "text-status-blocked"; }
  else                   { grade = "F";  gradeColor = "text-status-blocked"; }

  return { total, confidence, risk, grade, gradeColor };
}

// ─── Component ───────────────────────────────────────────────────
export function StrategyGradeBadge({
  metrics,
  size = "sm",
}: {
  metrics: StrategyMetrics;
  size?: "sm" | "md";
}) {
  const { total, confidence, risk, grade, gradeColor } = computeStrategyScore(metrics);
  const noData = (metrics.trades ?? 0) === 0;

  const pctConf = (confidence / 80) * 100;
  const pctRisk = (risk / 20) * 100;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className={`inline-flex items-center gap-1.5 cursor-help ${size === "md" ? "text-sm" : "text-xs"}`}>
            {/* Grade letter */}
            <span className={`font-bold tabular ${size === "md" ? "text-base" : "text-sm"} ${gradeColor}`}>
              {grade}
            </span>
            {/* Mini bar strip — confidence (blue) + risk (green) */}
            {!noData && (
              <div className="flex gap-0.5 items-center">
                <div className="w-8 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/70 transition-all"
                    style={{ width: `${pctConf}%` }}
                  />
                </div>
                <div className="w-4 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-status-safe/70 transition-all"
                    style={{ width: `${pctRisk}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="space-y-1 text-xs max-w-[220px]">
          {noData ? (
            <p>No trades yet — grade available after first data.</p>
          ) : (
            <>
              <div className="font-medium text-foreground">
                Strategy grade: {grade} ({total.toFixed(0)}/100)
              </div>
              <div className="text-muted-foreground space-y-0.5">
                <div>Confidence {confidence.toFixed(0)}/80 — expectancy, win rate, sharpe</div>
                <div>Risk score {risk.toFixed(0)}/20 — drawdown headroom</div>
              </div>
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
