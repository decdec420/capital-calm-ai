// ─────────────────────────────────────────────────────────────────────────────
// P1: NextBestAction.tsx
// New file → src/components/trader/NextBestAction.tsx
//
// Right-column card on Overview. Always shows the single highest-priority
// action the operator should take right now. Computed from live state —
// no configuration required.
//
// Priority order (highest → lowest):
//   1. Kill switch engaged → disarm it
//   2. Critical alert active → go to Alerts
//   3. Pending signal → review in Copilot
//   4. Bot halted (not by kill switch) → resume bot
//   5. Bot paused → resume bot
//   6. Stale market data → check Market Intel
//   7. Experiments need review → go to Learning
//   8. Default: desk clear, no action needed
//
// Wire into Overview.tsx right column:
//   import { NextBestAction } from "@/components/trader/NextBestAction";
//   // Inside the right column <div className="space-y-4">:
//   <NextBestAction onToggleBot={toggleBot} />
// ─────────────────────────────────────────────────────────────────────────────

import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  Play,
  ShieldCheck,
  Sparkles,
  WifiOff,
} from "lucide-react";
import { useSystemState } from "@/hooks/useSystemState";
import { useAlerts } from "@/hooks/useAlerts";
import { useSignals } from "@/hooks/useSignals";
import { useExperiments } from "@/hooks/useExperiments";
import { isStale } from "@/hooks/useRelativeTime";
import type { ReactNode } from "react";

// ─── action shape ─────────────────────────────────────────────────────────────

type ActionTone = "primary" | "safe" | "caution" | "blocked" | "muted";

interface Action {
  icon: ReactNode;
  heading: string;
  body: string;
  tone: ActionTone;
  /** If set, render a Link CTA */
  linkTo?: string;
  linkLabel?: string;
  /** If set, render a button CTA (mutually exclusive with linkTo) */
  onAction?: () => void;
  actionLabel?: string;
}

// ─── tone helpers ─────────────────────────────────────────────────────────────

const TONE_STYLES: Record<ActionTone, { border: string; bg: string; icon: string; heading: string }> = {
  primary:  { border: "border-primary/40",          bg: "bg-primary/5",          icon: "text-primary",        heading: "text-foreground" },
  safe:     { border: "border-status-safe/40",       bg: "bg-status-safe/5",      icon: "text-status-safe",    heading: "text-foreground" },
  caution:  { border: "border-status-caution/40",    bg: "bg-status-caution/5",   icon: "text-status-caution", heading: "text-foreground" },
  blocked:  { border: "border-status-blocked/40",    bg: "bg-status-blocked/5",   icon: "text-status-blocked", heading: "text-foreground" },
  muted:    { border: "border-border",               bg: "bg-card/40",            icon: "text-muted-foreground",heading: "text-muted-foreground" },
};

// ─── component ────────────────────────────────────────────────────────────────

interface NextBestActionProps {
  /** Passed from Overview so we can call toggleBot without duplicating the fn */
  onToggleBot?: () => void;
}

export function NextBestAction({ onToggleBot }: NextBestActionProps) {
  const { data: system } = useSystemState();
  const { alerts } = useAlerts();
  const { pending: pendingSignals } = useSignals();
  const { counts: expCounts } = useExperiments();

  const snapshot = system?.lastEngineSnapshot ?? null;
  const dataStale = isStale(snapshot ? new Date(snapshot.ranAt).getTime() : null);
  const criticalAlerts = alerts.filter((a) => a.severity === "critical");

  // ── Compute the single best action ────────────────────────────────────────

  let action: Action;

  if (system?.killSwitchEngaged) {
    action = {
      icon: <ShieldCheck className="h-5 w-5" />,
      heading: "Kill switch is engaged",
      body: "The bot is halted. Disarm the kill switch to allow new proposals on the next tick.",
      tone: "blocked",
      linkTo: "/risk",
      linkLabel: "Go to Risk Center →",
    };
  } else if (criticalAlerts.length > 0) {
    action = {
      icon: <AlertCircle className="h-5 w-5" />,
      heading: `${criticalAlerts.length} critical alert${criticalAlerts.length > 1 ? "s" : ""}`,
      body: criticalAlerts[0].title,
      tone: "blocked",
      linkTo: "/alerts",
      linkLabel: "View Alerts →",
    };
  } else if (pendingSignals.length > 0) {
    const sig = pendingSignals[0];
    action = {
      icon: <Sparkles className="h-5 w-5" />,
      heading: "Signal awaiting decision",
      body: `Wags proposed ${sig.side.toUpperCase()} ${sig.symbol} @ $${sig.proposedEntry.toFixed(2)} — ${(sig.confidence * 100).toFixed(0)}% confidence.`,
      tone: "primary",
      linkTo: "/copilot",
      linkLabel: "Review in Copilot →",
    };
  } else if (system?.bot === "halted") {
    action = {
      icon: <Play className="h-5 w-5" />,
      heading: "Bot is halted",
      body: "The desk has stopped. Resume the bot to allow the signal engine to run.",
      tone: "caution",
      onAction: onToggleBot,
      actionLabel: "Resume bot",
    };
  } else if (system?.bot === "paused") {
    action = {
      icon: <Play className="h-5 w-5" />,
      heading: "Bot is paused",
      body: "Resume the bot when you're ready to let Taylor scan for entries.",
      tone: "caution",
      onAction: onToggleBot,
      actionLabel: "Resume bot",
    };
  } else if (dataStale) {
    action = {
      icon: <WifiOff className="h-5 w-5" />,
      heading: "Market data is stale",
      body: "Brain Trust context hasn't refreshed recently. Signal quality may be reduced.",
      tone: "caution",
      linkTo: "/market",
      linkLabel: "Check Market Intel →",
    };
  } else if (expCounts.needsReview > 0) {
    action = {
      icon: <Brain className="h-5 w-5" />,
      heading: `${expCounts.needsReview} experiment${expCounts.needsReview > 1 ? "s" : ""} to review`,
      body: "Katrina has flagged strategy experiments that need your attention.",
      tone: "caution",
      linkTo: "/learning",
      linkLabel: "Open Learning →",
    };
  } else {
    // All clear
    action = {
      icon: <CheckCircle2 className="h-5 w-5" />,
      heading: "Desk is clear",
      body: system?.bot === "running"
        ? "Bot is running. Taylor is scanning. No action required."
        : "No urgent actions. Resume the bot when ready.",
      tone: "muted",
    };
  }

  const t = TONE_STYLES[action.tone];

  return (
    <div
      className={cn(
        "panel p-4 flex flex-col gap-3 animate-fade-in",
        t.border,
        t.bg,
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <div className={cn("mt-0.5 shrink-0", t.icon)}>{action.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            Next best action
          </div>
          <div className={cn("text-sm font-semibold leading-snug", t.heading)}>
            {action.heading}
          </div>
        </div>
      </div>

      {/* Body */}
      <p className="text-xs text-muted-foreground leading-relaxed -mt-1">
        {action.body}
      </p>

      {/* CTA */}
      {action.linkTo && action.linkLabel && (
        <Button variant="outline" size="sm" asChild className="self-start">
          <Link to={action.linkTo}>{action.linkLabel}</Link>
        </Button>
      )}
      {action.onAction && action.actionLabel && (
        <Button variant="outline" size="sm" className="self-start" onClick={action.onAction}>
          {action.actionLabel}
        </Button>
      )}
    </div>
  );
}
