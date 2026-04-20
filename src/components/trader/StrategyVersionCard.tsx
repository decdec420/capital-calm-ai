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
      <div className="grid grid-cols-4 gap-2 pt-2 border-t border-border">
        <Metric label="Expectancy" value={strategy.metrics.expectancy.toFixed(2) + "R"} />
        <Metric label="Win rate" value={(strategy.metrics.winRate * 100).toFixed(0) + "%"} />
        <Metric label="Max DD" value={(strategy.metrics.maxDrawdown * 100).toFixed(1) + "%"} />
        <Metric label="Sharpe" value={strategy.metrics.sharpe.toFixed(2)} />
      </div>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular text-foreground">{value}</div>
    </div>
  );
}
