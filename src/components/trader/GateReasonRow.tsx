import {
  AlertOctagon,
  Ban,
  Brain,
  Clock,
  DollarSign,
  Hand,
  PauseOctagon,
  ShieldAlert,
  ShieldX,
  Signpost,
  TrendingDown,
  Waves,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { GateReason, GateReasonCode, GateSeverity } from "@/lib/domain-types";

// Map a backend gate code to a friendly icon. Defaults to a halt icon.
const ICON_BY_CODE: Record<string, typeof AlertOctagon> = {
  KILL_SWITCH: ShieldX,
  BOT_PAUSED: PauseOctagon,
  DAILY_LOSS_CAP: TrendingDown,
  TRADE_COUNT_CAP: Hand,
  BALANCE_FLOOR: DollarSign,
  OPEN_POSITION: Signpost,
  PENDING_SIGNAL: Clock,
  CHOP_REGIME: Waves,
  RANGE_REGIME: Waves,
  LOW_SETUP_SCORE: Brain,
  STALE_DATA: WifiOff,
  AI_SKIP: Brain,
  AI_ERROR: Zap,
  INSERT_ERROR: AlertOctagon,
  NO_SYSTEM_STATE: AlertOctagon,
  COOLDOWN: Clock,
  REENTRY_COOLDOWN: Clock,
  ANTI_TILT_LOCK: ShieldX,
  ANTI_TILT_CAUTION: ShieldAlert,
  ANTI_TILT_COOLDOWN: PauseOctagon,
  CONSECUTIVE_LOSS_HARD_STOP: ShieldX,
  BRAIN_TRUST_MOMENTUM_STALE: WifiOff,
  DEFAULT_LONG_FALLBACK_BLOCKED: Ban,
  TRADING_PAUSED_EVENT_MODE: PauseOctagon,
  TRADING_PAUSED_VOLATILITY_SPIKE: AlertOctagon,
};

// Severity tone — drives the dot/border colour.
const SEVERITY_TONE: Record<GateSeverity, { ring: string; bg: string; text: string; dot: string; label: string }> = {
  halt: {
    ring: "border-status-blocked/40",
    bg: "bg-status-blocked/10",
    text: "text-status-blocked",
    dot: "bg-status-blocked",
    label: "halt",
  },
  block: {
    ring: "border-status-caution/40",
    bg: "bg-status-caution/10",
    text: "text-status-caution",
    dot: "bg-status-caution",
    label: "block",
  },
  skip: {
    ring: "border-border",
    bg: "bg-secondary/60",
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/60",
    label: "skip",
  },
  warn: {
    ring: "border-status-caution/40",
    bg: "bg-status-caution/10",
    text: "text-status-caution",
    dot: "bg-status-caution",
    label: "warn",
  },
  info: {
    ring: "border-primary/30",
    bg: "bg-primary/5",
    text: "text-primary",
    dot: "bg-primary",
    label: "info",
  },
};

export function gateIconFor(code: GateReasonCode): typeof AlertOctagon {
  return ICON_BY_CODE[code] ?? ShieldAlert;
}

export function gateToneFor(severity: GateSeverity) {
  return SEVERITY_TONE[severity];
}

interface GateReasonRowProps {
  reason: GateReason;
  className?: string;
  compact?: boolean;
}

export function GateReasonRow({ reason, className, compact }: GateReasonRowProps) {
  const Icon = gateIconFor(reason.code);
  const tone = gateToneFor(reason.severity);
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border px-3 py-2",
        tone.bg,
        tone.ring,
        className,
      )}
    >
      <div
        className={cn(
          "h-7 w-7 rounded-md flex items-center justify-center shrink-0",
          "bg-card border border-border",
          tone.text,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
            {reason.code}
          </span>
          <span
            className={cn(
              "text-[9px] uppercase tracking-wider font-semibold rounded-sm px-1.5 py-0.5",
              tone.text,
              tone.bg,
            )}
          >
            {tone.label}
          </span>
          {reason.meta?.symbol && (
            <span className="text-[10px] tabular text-muted-foreground">
              · {String(reason.meta.symbol)}
            </span>
          )}
        </div>
        {!compact && (
          <p className="text-xs text-foreground mt-0.5 leading-snug">{reason.message}</p>
        )}
      </div>
    </div>
  );
}

interface GateReasonListProps {
  reasons: GateReason[];
  className?: string;
  emptyLabel?: string;
  compact?: boolean;
  max?: number;
}

export function GateReasonList({ reasons, className, emptyLabel, compact, max }: GateReasonListProps) {
  if (!reasons || reasons.length === 0) {
    if (!emptyLabel) return null;
    return (
      <div className={cn("text-xs text-status-safe italic", className)}>{emptyLabel}</div>
    );
  }
  const shown = max ? reasons.slice(0, max) : reasons;
  const overflow = max && reasons.length > max ? reasons.length - max : 0;
  return (
    <div className={cn("space-y-1.5", className)}>
      {shown.map((r, i) => (
        <GateReasonRow key={`${r.code}-${i}`} reason={r} compact={compact} />
      ))}
      {overflow > 0 && (
        <div className="text-[10px] text-muted-foreground italic px-1">
          +{overflow} more reason{overflow === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}
