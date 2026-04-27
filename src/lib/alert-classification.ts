// Pure classification of alerts into actionable categories.
// We don't change the DB — alerts are produced by triggers we own
// (see migrations: alert_on_*, check_jessica_heartbeat). Pattern-match
// the title we already emit and frame it with what / why / fix copy.

import type { Alert } from "@/lib/domain-types";

export type AlertCategory =
  | "cron_health"
  | "guardrail"
  | "kill_switch"
  | "signal"
  | "trade"
  | "experiment"
  | "system";

export interface AlertAction {
  label: string;
  to: string;
}

export interface ClassifiedAlert {
  category: AlertCategory;
  categoryLabel: string;
  /** One-line headline shown in the collapsed card under the title. */
  summary: string;
  /** Plain-English description of what's happening. */
  what: string;
  /** Why the operator should care. */
  why: string;
  /** Ordered, actionable fixes. */
  fixes: string[];
  /** Most useful navigation target — surfaced as the primary button. */
  primaryAction?: AlertAction;
  /** Optional secondary navigation. */
  secondaryAction?: AlertAction;
}

const CATEGORY_LABEL: Record<AlertCategory, string> = {
  cron_health: "Cron health",
  guardrail: "Guardrail",
  kill_switch: "System",
  signal: "Signal",
  trade: "Trade",
  experiment: "Experiment",
  system: "System",
};

export function classifyAlert(alert: Alert): ClassifiedAlert {
  const title = alert.title ?? "";
  const message = alert.message ?? "";
  const hay = `${title} ${message}`.toLowerCase();

  // ---- Cron / heartbeat ----
  if (/heartbeat|cron may be down|never recorded a decision/.test(hay)) {
    return {
      category: "cron_health",
      categoryLabel: CATEGORY_LABEL.cron_health,
      summary: message || "A scheduled job may have stopped running.",
      what:
        message ||
        "A scheduled background job (cron) hasn't reported in within its expected window.",
      why: "While the heartbeat is missed, no new signals are generated and automated lifecycle steps (approvals, exits, learning) pause. Open positions are unaffected by the heartbeat itself, but won't be re-evaluated until ticks resume.",
      fixes: [
        "Open Risk Center to check system state and confirm whether the bot is paused or the kill-switch is engaged.",
        "If the bot is paused or the kill-switch is engaged, this clears on its own once you resume — the alert will stop firing within a few minutes.",
        "If the cron really stopped, redeploy the related edge function or contact support.",
      ],
      primaryAction: { label: "Open Risk Center", to: "/risk" },
      secondaryAction: { label: "Open Settings", to: "/settings" },
    };
  }

  // ---- Kill-switch ----
  if (/kill[- ]?switch/.test(hay)) {
    return {
      category: "kill_switch",
      categoryLabel: CATEGORY_LABEL.kill_switch,
      summary: message || "Kill-switch engaged — trading halted.",
      what:
        "The kill-switch is engaged. The engine will not place any new orders until it is disarmed.",
      why: "This is the hard stop. Existing positions are still tracked and marked-to-market, but no entries, exits, or scale-ins fire. Use this when something is clearly wrong.",
      fixes: [
        "Open Risk Center to review what triggered the halt and the current guardrail status.",
        "Investigate the underlying issue (loss cap, broker outage, bad data) before disarming.",
        "Disarm from the Risk Center when you're satisfied it's safe to resume.",
      ],
      primaryAction: { label: "Open Risk Center", to: "/risk" },
    };
  }

  // ---- Guardrail ----
  if (/guardrail/.test(hay)) {
    const blocked = /blocked/.test(hay);
    return {
      category: "guardrail",
      categoryLabel: CATEGORY_LABEL.guardrail,
      summary: message || (blocked ? "Guardrail is blocking trades." : "Guardrail tripped to caution."),
      what: message || "A risk guardrail crossed its limit.",
      why: blocked
        ? "While blocked, the engine will refuse to open new positions on the affected dimension (size, daily loss, trade count, etc.). Existing trades continue to run."
        : "Caution is a soft warning — trading continues, but the engine is closer to a hard limit and you should plan accordingly.",
      fixes: [
        "Open Risk Center to see the live value vs. limit and which guardrail tripped.",
        blocked
          ? "Either wait for the limit to reset (e.g. daily loss resets at the day boundary) or adjust the guardrail in Strategy Lab if it's miscalibrated."
          : "Consider reducing exposure or pausing manually before it escalates to a block.",
        "Review recent trades to understand what pushed utilisation up.",
      ],
      primaryAction: { label: "Open Risk Center", to: "/risk" },
      secondaryAction: { label: "Open Strategy Lab", to: "/strategy" },
    };
  }

  // ---- Signal proposed ----
  if (/signal proposed|signal/.test(hay) && !/closed|filled/.test(hay)) {
    return {
      category: "signal",
      categoryLabel: CATEGORY_LABEL.signal,
      summary: message || "A new trade signal is awaiting your decision.",
      what:
        message ||
        "The engine has proposed a new trade. It's waiting for an approve/reject decision and will expire automatically.",
      why: "Signals expire after 15 minutes by default. If you're on assisted/manual autonomy, no order is placed until you approve.",
      fixes: [
        "Open Copilot to see the full reasoning, context, and proposed sizing.",
        "Approve, reject, or let it expire — every decision is recorded in the audit log.",
        "If you want signals auto-approved, raise autonomy to 'autonomous' in Settings.",
      ],
      primaryAction: { label: "Open Copilot", to: "/copilot" },
      secondaryAction: { label: "Open Trades", to: "/trades" },
    };
  }

  // ---- Trade closed ----
  if (/trade closed|closed [+-]?\$|filled|stopped|exit/.test(hay)) {
    return {
      category: "trade",
      categoryLabel: CATEGORY_LABEL.trade,
      summary: message || "A trade was closed.",
      what: message || "A position was closed and the result is now in the journal.",
      why: "Closed trades feed the post-trade learning loop and update P&L, win rate, and expectancy. Reviewing losses early catches strategy drift.",
      fixes: [
        "Open Trades to see entry/exit, R-multiple, and the close reason.",
        "Check the Journal for the auto-generated post-trade note and any learning the engine extracted.",
        "If the close reason looks wrong (e.g. premature stop), flag it on the trade — it feeds the next strategy review.",
      ],
      primaryAction: { label: "Open Trades", to: "/trades" },
      secondaryAction: { label: "Open Journal", to: "/journals" },
    };
  }

  // ---- Experiment needs review ----
  if (/experiment/.test(hay)) {
    return {
      category: "experiment",
      categoryLabel: CATEGORY_LABEL.experiment,
      summary: message || "An experiment finished and needs your call.",
      what:
        message ||
        "A backtest finished with a borderline result — not strong enough to auto-promote, not weak enough to auto-kill.",
      why: "Borderline experiments need human judgement. Promoting locks the change into your live doctrine; killing it preserves the current behaviour and stops further attempts for a cooldown window.",
      fixes: [
        "Open Copilot → Experiments to see the full backtest, expectancy delta, and win-rate change.",
        "Promote if the change is consistent across regimes, kill if it only worked in cherry-picked conditions.",
        "If unsure, leave it queued — you can re-run with different parameters later.",
      ],
      primaryAction: { label: "Open Copilot", to: "/copilot" },
    };
  }

  // ---- Fallback ----
  return {
    category: "system",
    categoryLabel: CATEGORY_LABEL.system,
    summary: message || "System notification.",
    what: message || "The system flagged an event that didn't match a known category.",
    why: "No automatic guidance is available for this alert type. Use the original message above for context.",
    fixes: [
      "Read the original message for specifics.",
      "If this happens repeatedly, mention it in chat and we'll add a category template for it.",
    ],
  };
}
