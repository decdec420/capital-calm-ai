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
  // No primary/secondary nav actions: AlertCard renders a live Bobby
  // triage block + inline actions (Resume bot, Disarm kill-switch, Run
  // Bobby now) for this category. Nav would be a dead end.
  if (/heartbeat|cron may be down|never recorded a decision/.test(hay)) {
    return {
      category: "cron_health",
      categoryLabel: CATEGORY_LABEL.cron_health,
      summary: message || "Bobby hasn't checked in recently.",
      what:
        message ||
        "Bobby — the autonomous decision agent that runs every minute — hasn't reported a tick within the expected window.",
      why: "While Bobby is silent, no new signals are generated and automated lifecycle steps (approvals, exits, learning) pause. Open positions are still tracked but won't be re-evaluated until ticks resume.",
      fixes: [
        "Check the live status block above. If the bot is paused or the kill-switch is engaged, this is expected — start the bot and the alert clears within a minute.",
        "Otherwise, click Run Bobby now to kick a tick. If it succeeds, the heartbeat resets immediately.",
        "If Run Bobby now fails, the edge function itself is down — open Copilot to check agent logs or contact support.",
      ],
    };
  }

  // ---- Anti-tilt (consecutive losses) ----
  if (/anti.?tilt|consecutive loss|cooldown.*loss|loss.*hard.?stop/.test(hay)) {
    const hardStop = /hard.?stop|locked/.test(hay);
    return {
      category: "system",
      categoryLabel: CATEGORY_LABEL.system,
      summary:
        message ||
        (hardStop
          ? "Anti-tilt hard stop engaged after consecutive losses."
          : "Anti-tilt safety triggered after consecutive losses."),
      what:
        message ||
        "The engine tracks consecutive losing trades. After 2 it warns (caution), after 3 it cools off, and after 4 it hard-stops new entries until you reset.",
      why: hardStop
        ? "Hard stop prevents tilt-driven revenge trading. No new entries fire until the loss streak is acknowledged or the daily window resets."
        : "Cooldown is a forced pause to break the streak. Existing positions still run; the engine simply won't open new ones for the cooldown window.",
      fixes: [
        "Open Risk Center to see the live streak count and configured limit.",
        "Review the recent losses in Trades — was it bad luck, a regime shift, or a strategy issue?",
        hardStop
          ? "Adjust the consecutive_loss_limit or daily caps in Settings if 4 is too tight, then reset to resume."
          : "Wait out the cooldown, or pause manually if you want a longer break.",
      ],
      primaryAction: { label: "Open Risk Center", to: "/risk" },
    };
  }

  // ---- Brain Trust momentum stale ----
  if (/brain trust|momentum.*stale|stale.*momentum|short.?horizon/.test(hay)) {
    return {
      category: "system",
      categoryLabel: CATEGORY_LABEL.system,
      summary: message || "Brain Trust short-horizon momentum is stale.",
      what:
        "The signal engine refused to propose a trade because the latest 1h/4h momentum read from the Brain Trust (Wags & Taylor) is missing or older than 2 hours.",
      why: "Without a fresh short-horizon read, Bobby and Wags can't confirm direction safely. The engine fails closed rather than guess.",
      fixes: [
        "Open Copilot and trigger a Brain Trust refresh (market intelligence run) to repopulate momentum reads.",
        "Confirm the market-intelligence cron is running — if it's silent, that's the underlying issue.",
        "Once a fresh read lands the next engine tick will resume normal proposals.",
      ],
      primaryAction: { label: "Open Copilot", to: "/copilot" },
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
