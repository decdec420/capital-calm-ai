import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import {
  AlertOctagon,
  DollarSign,
  Gauge,
  Hand,
  Hourglass,
  ShieldAlert,
  TrendingDown,
  Waves,
  WifiOff,
} from "lucide-react";
import type { RiskGuardrail, GuardrailType } from "@/lib/domain-types";

interface GuardrailRowProps {
  guardrail: RiskGuardrail;
  className?: string;
}

const levelTone = {
  safe: "safe",
  caution: "caution",
  blocked: "blocked",
} as const;

const barColor = {
  safe: "bg-status-safe",
  caution: "bg-status-caution",
  blocked: "bg-status-blocked",
} as const;

const TYPE_ICON: Record<GuardrailType, typeof ShieldAlert> = {
  size_cap: Gauge,
  daily_loss: TrendingDown,
  trade_count: Hand,
  balance_floor: DollarSign,
  spread: Waves,
  stale_data: WifiOff,
  drawdown: TrendingDown,
  latency: Hourglass,
  generic: ShieldAlert,
};

export function GuardrailRow({ guardrail, className }: GuardrailRowProps) {
  const pct = Math.min(100, Math.max(0, guardrail.utilization * 100));
  const Icon = TYPE_ICON[guardrail.guardrailType] ?? AlertOctagon;
  return (
    <div className={cn("panel p-4 space-y-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex items-start gap-2.5">
          <div className="h-7 w-7 rounded-md bg-secondary border border-border text-muted-foreground flex items-center justify-center shrink-0 mt-0.5">
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-foreground">{guardrail.label}</p>
              <StatusBadge tone={levelTone[guardrail.level]} size="sm" dot>
                {guardrail.level}
              </StatusBadge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{guardrail.description}</p>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm tabular text-foreground">{guardrail.current}</div>
          <div className="text-[11px] text-muted-foreground tabular">limit {guardrail.limit}</div>
        </div>
      </div>
      <div className="h-1 w-full rounded-full bg-secondary overflow-hidden">
        <div className={cn("h-full transition-all", barColor[guardrail.level])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

