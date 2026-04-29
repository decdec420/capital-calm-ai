import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import type { StrategyVersion } from "@/lib/domain-types";

const statusTone = {
  approved: "safe",
  candidate: "candidate",
  archived: "neutral",
} as const;

export function StrategyVersionCard({
  strategy,
  selected,
  onSelect,
  className,
}: {
  strategy: StrategyVersion;
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "panel p-4 text-left w-full space-y-3 transition-all hover:border-primary/30",
        selected && "ring-1 ring-primary/40 border-primary/40",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">
            {strategy.name} <span className="text-muted-foreground">{strategy.version}</span>
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{strategy.description}</p>
        </div>
        <StatusBadge tone={statusTone[strategy.status]} size="sm" dot>
          {strategy.status}
        </StatusBadge>
      </div>
      <div className="pt-2 border-t border-border space-y-2">
        <div className="grid grid-cols-4 gap-2">
          {strategy.metrics.trades === 0 ? (
            <>
              <Metric label="Expectancy" value="—" untested />
              <Metric label="Win rate" value="—" untested />
              <Metric label="Max DD" value="—" untested />
              <Metric label="Sharpe" value="—" untested />
            </>
          ) : (
            <>
              <Metric label="Expectancy" value={strategy.metrics.expectancy.toFixed(2) + "R"} />
              <Metric label="Win rate" value={(strategy.metrics.winRate * 100).toFixed(0) + "%"} />
              <Metric label="Max DD" value={(strategy.metrics.maxDrawdown * 100).toFixed(1) + "%"} />
              <Metric label="Sharpe" value={strategy.metrics.sharpe.toFixed(2)} />
            </>
          )}
        </div>
        {/* MED-11: Profit factor + avg win/loss — over-fit signal.
            PF values near 1.0 on a high win-rate strategy often mean
            one big loser is hiding in the tail. Only shown when the
            strategy has been backtested and the fields are present. */}
        {strategy.metrics.trades > 0 && strategy.metrics.profitFactor != null && (
          <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border/50">
            <Metric
              label="Profit factor"
              value={strategy.metrics.profitFactor === 999 ? "∞" : strategy.metrics.profitFactor!.toFixed(2)}
              tooltip="Gross wins ÷ gross losses in R. Values < 1.5 on a 50%+ win-rate may indicate over-fit."
            />
            <Metric
              label="Avg win"
              value={(strategy.metrics.avgWin ?? 0).toFixed(2) + "R"}
              tooltip="Average winning trade in R."
            />
            <Metric
              label="Avg loss"
              value={(strategy.metrics.avgLoss ?? 0).toFixed(2) + "R"}
              tooltip="Average losing trade magnitude in R."
            />
          </div>
        )}
      </div>
      {strategy.metrics.trades === 0 && (
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground italic pt-1">
          Not yet backtested — hit Backtest to measure
        </p>
      )}
    </button>
  );
}

function Metric({
  label, value, untested = false, tooltip,
}: {
  label: string; value: string; untested?: boolean; tooltip?: string;
}) {
  return (
    <div title={tooltip}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-sm tabular", untested ? "text-muted-foreground" : "text-foreground")}>{value}</div>
    </div>
  );
}
