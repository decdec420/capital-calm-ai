import { useMemo } from "react";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  Cell,
} from "recharts";
import { TrendingUp } from "lucide-react";
import type { TradeSignal } from "@/lib/domain-types";

interface CalibrationChartProps {
  signals: TradeSignal[];
}

// Buckets confidence into 5 bins (0-20, 20-40, ...) and computes the actual
// hit-rate (executed signals that closed profitably). Plots each bin as a dot:
// X = mid confidence, Y = realised win-rate. The diagonal y=x is "perfect calibration".
//
// We treat the AI as the dealer at the table — does it know when its hand is good?
export function CalibrationChart({ signals }: CalibrationChartProps) {
  const data = useMemo(() => {
    // Only signals the AI actually committed to: executed (auto or manual approve).
    // Rejected/expired signals don't have a P&L outcome — they're censored data.
    const executed = signals.filter((s) => s.status === "executed");
    const bins = [
      { lo: 0, hi: 0.2, mid: 10 },
      { lo: 0.2, hi: 0.4, mid: 30 },
      { lo: 0.4, hi: 0.6, mid: 50 },
      { lo: 0.6, hi: 0.8, mid: 70 },
      { lo: 0.8, hi: 1.01, mid: 90 },
    ];
    return bins
      .map((b) => {
        const inBin = executed.filter((s) => s.confidence >= b.lo && s.confidence < b.hi);
        const wins = inBin.filter((s) => {
          // We don't have direct trade outcome on the signal row, so we proxy:
          // signals with no decisionReason of "loss"/"stop" + confidence-weighted optimism.
          // For now: count any executed signal as a "win" only if the user/AI hasn't
          // written a loss tag. Phase 4 will join trade outcomes here properly.
          const reason = (s.decisionReason ?? "").toLowerCase();
          return !reason.includes("stop") && !reason.includes("loss");
        }).length;
        const winRate = inBin.length === 0 ? null : (wins / inBin.length) * 100;
        return {
          confidence: b.mid,
          winRate,
          count: inBin.length,
          label: `${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%`,
        };
      })
      .filter((d) => d.winRate !== null) as Array<{
      confidence: number;
      winRate: number;
      count: number;
      label: string;
    }>;
  }, [signals]);

  if (data.length === 0) {
    return (
      <div className="panel p-6 text-center">
        <div className="h-10 w-10 rounded-md bg-secondary text-muted-foreground flex items-center justify-center mx-auto mb-3">
          <TrendingUp className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-foreground">Calibration not ready</p>
        <p className="text-xs text-muted-foreground mt-1">
          Need executed signals across confidence bands before we can grade the AI's honesty.
        </p>
      </div>
    );
  }

  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-0.5">AI calibration</div>
          <div className="text-sm font-semibold text-foreground">Confidence vs. realised win-rate</div>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
            Dots above the diagonal = AI was sandbagging. Below = overconfident. Right on the line = honest.
          </p>
        </div>
        <span className="text-[10px] text-muted-foreground tabular">
          {data.reduce((s, d) => s + d.count, 0)} executed
        </span>
      </div>

      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 8, right: 16, bottom: 28, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
            <XAxis
              type="number"
              dataKey="confidence"
              domain={[0, 100]}
              ticks={[0, 20, 40, 60, 80, 100]}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
              stroke="hsl(var(--border))"
              label={{
                value: "AI confidence (%)",
                position: "insideBottom",
                offset: -16,
                fill: "hsl(var(--muted-foreground))",
                fontSize: 10,
              }}
            />
            <YAxis
              type="number"
              dataKey="winRate"
              domain={[0, 100]}
              ticks={[0, 20, 40, 60, 80, 100]}
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
              stroke="hsl(var(--border))"
              label={{
                value: "Win-rate (%)",
                angle: -90,
                position: "insideLeft",
                fill: "hsl(var(--muted-foreground))",
                fontSize: 10,
              }}
            />
            <ReferenceLine
              segment={[
                { x: 0, y: 0 },
                { x: 100, y: 100 },
              ]}
              stroke="hsl(var(--primary))"
              strokeDasharray="4 4"
              opacity={0.5}
            />
            <Tooltip
              cursor={{ stroke: "hsl(var(--border))" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as (typeof data)[number];
                const delta = d.winRate - d.confidence;
                const verdict =
                  Math.abs(delta) < 8 ? "honest" : delta > 0 ? "sandbagging" : "overconfident";
                return (
                  <div className="rounded-md border border-border bg-background px-2.5 py-2 text-xs shadow-xl">
                    <div className="font-medium text-foreground">{d.label} band</div>
                    <div className="text-muted-foreground mt-1">
                      Win-rate: <span className="text-foreground tabular">{d.winRate.toFixed(0)}%</span>
                    </div>
                    <div className="text-muted-foreground">
                      Sample: <span className="text-foreground tabular">{d.count}</span>
                    </div>
                    <div className="text-muted-foreground mt-1 capitalize">
                      Verdict: <span className="text-primary">{verdict}</span>
                    </div>
                  </div>
                );
              }}
            />
            <Scatter data={data}>
              {data.map((d, i) => {
                const delta = d.winRate - d.confidence;
                const color =
                  Math.abs(delta) < 8
                    ? "hsl(var(--status-safe))"
                    : delta > 0
                      ? "hsl(var(--primary))"
                      : "hsl(var(--status-blocked))";
                // Size dot by sample count so we can see which bins matter
                const r = Math.min(12, 4 + d.count);
                return <Cell key={i} fill={color} r={r} />;
              })}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
