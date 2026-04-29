// PipelineFlowBanner — Feature 4: Backtest-first UX loop
// Shows the 5-stage strategy pipeline so the operator always knows
// where they are in the idea → live cycle.

import { ArrowRight, FlaskConical, Lightbulb, LineChart, Rocket, TestTube2 } from "lucide-react";

const STAGES = [
  { icon: Lightbulb,    label: "Idea",        hint: "Describe a hypothesis: what tweak might improve results?" },
  { icon: FlaskConical, label: "Experiment",  hint: "Wendy proposes a param change. Taylor backtests it." },
  { icon: LineChart,    label: "Backtest",    hint: "We replay the change on historical candles. Both sides run." },
  { icon: TestTube2,    label: "Paper test",  hint: "The candidate runs live-but-fake alongside the current strategy, collecting real data." },
  { icon: Rocket,       label: "Live",        hint: "If it clearly beats the baseline after 30–100 trades, it auto-promotes. One promotion per cooldown window." },
] as const;

export type PipelineStage = 0 | 1 | 2 | 3 | 4;

/**
 * @param activeStage  Which stage is currently in focus (0–4). Omit to show all as neutral.
 * @param compact      If true, renders a slim single-line version (for narrower panels).
 */
export function PipelineFlowBanner({
  activeStage,
  compact = false,
}: {
  activeStage?: PipelineStage;
  compact?: boolean;
}) {
  return (
    <div className={`rounded-md border border-border/50 bg-card/40 ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
      <div className="flex items-center gap-1 flex-wrap">
        {STAGES.map((stage, i) => {
          const Icon = stage.icon;
          const isActive  = activeStage === i;
          const isPast    = activeStage !== undefined && i < activeStage;
          const isFuture  = activeStage !== undefined && i > activeStage;

          const labelColor = isActive
            ? "text-foreground font-semibold"
            : isPast
            ? "text-status-safe"
            : isFuture
            ? "text-muted-foreground/50"
            : "text-muted-foreground";

          const iconColor = isActive
            ? "text-primary"
            : isPast
            ? "text-status-safe"
            : "text-muted-foreground/40";

          return (
            <div key={stage.label} className="flex items-center gap-1">
              {/* Step */}
              <div
                className="flex items-center gap-1 group cursor-help"
                title={stage.hint}
              >
                <Icon
                  className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5"} shrink-0 ${iconColor}`}
                />
                {!compact && (
                  <span className={`text-[11px] ${labelColor} whitespace-nowrap`}>
                    {stage.label}
                  </span>
                )}
              </div>
              {/* Arrow between steps */}
              {i < STAGES.length - 1 && (
                <ArrowRight
                  className={`${compact ? "h-2.5 w-2.5" : "h-3 w-3"} ${
                    isPast ? "text-status-safe/60" : "text-muted-foreground/25"
                  } shrink-0`}
                />
              )}
            </div>
          );
        })}

        {/* Active stage label (compact mode only) */}
        {compact && activeStage !== undefined && (
          <span className="ml-2 text-[10px] text-primary font-medium uppercase tracking-wider">
            {STAGES[activeStage].label}
          </span>
        )}
      </div>

      {/* Hint line for the active stage */}
      {!compact && activeStage !== undefined && (
        <p className="mt-1.5 text-[11px] text-muted-foreground leading-snug">
          <span className="text-foreground font-medium">{STAGES[activeStage].label}: </span>
          {STAGES[activeStage].hint}
        </p>
      )}
    </div>
  );
}
