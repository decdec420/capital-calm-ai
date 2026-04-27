// ============================================================
// Risk Gate Stack (Authoritative)
// ------------------------------------------------------------
// Authoritative. Browser reads from this; never forks.
// Ported from decdec420/Trader → src/execution/RiskManager.ts
// and src/execution/PortfolioGuard.ts, expanded to match the
// Lovable multi-symbol + autonomy-level surface.
//
// Returns an array of GateReason[]. Caller treats a reason with
// severity: "halt" or "block" as a refusal. "skip" is an
// advisory skip for this tick; "info"/"warn" pass through.
// ============================================================

import {
  MAX_SPREAD_BPS,
  STALE_DATA_SECONDS,
  getProfile,
  isWhitelistedSymbol,
  type TradingProfile,
} from "./doctrine.ts";
import type { ResolvedDoctrine } from "./doctrine-resolver.ts";
import { GATE_CODES, gate, type GateReason } from "./reasons.ts";

export interface RiskContext {
  symbol: string;
  /** Account equity in USD (live) */
  equityUsd: number;
  /** Realized PnL for the current UTC day (USD, signed) */
  dailyRealizedPnlUsd: number;
  /** Number of trades opened in the current UTC day */
  dailyTradeCount: number;
  /** Kill-switch engaged flag from system_state */
  killSwitchEngaged: boolean;
  /** Bot status — "running" is required to trade */
  botStatus: string;
  /** Has an open position on the same symbol */
  hasOpenPosition: boolean;
  /** Has a pending signal on the same symbol */
  hasPendingSignal: boolean;
  /** Latest bid / ask for spread check (optional — only when available) */
  bid?: number;
  ask?: number;
  /** Timestamp of the latest candle we're basing the decision on */
  latestCandleEndedAt?: string;
  /** Current ISO time (for testability) */
  nowIso?: string;
  /** Optional guardrail rows (flattened) from the DB */
  guardrails?: Array<{ label: string; level: string; utilization: number }>;
  /** Active trading profile id (sentinel | active | aggressive). Sentinel default. */
  profile?: string | TradingProfile;
  /**
   * Per-user resolved doctrine (overrides profile hardcaps when present).
   * When supplied, this is the authoritative source for daily-trade cap,
   * daily-loss USD cap, and the kill-switch floor.
   */
  resolved?: ResolvedDoctrine;
}

export function evaluateRiskGates(ctx: RiskContext): GateReason[] {
  const profile: TradingProfile =
    typeof ctx.profile === "object" && ctx.profile
      ? ctx.profile
      : getProfile(typeof ctx.profile === "string" ? ctx.profile : undefined);
  const MAX_TRADES_PER_DAY = ctx.resolved?.maxTradesPerDay ?? profile.maxDailyTradesHardCap;
  const MAX_DAILY_LOSS_USD = ctx.resolved?.dailyLossUsd ?? profile.maxDailyLossUsdHardCap;
  const KILL_SWITCH_FLOOR = ctx.resolved?.killSwitchFloorUsd ?? 8;
  const reasons: GateReason[] = [];
  const now = ctx.nowIso ? new Date(ctx.nowIso) : new Date();

  if (!isWhitelistedSymbol(ctx.symbol)) {
    reasons.push(
      gate(
        GATE_CODES.DOCTRINE_SYMBOL_NOT_ALLOWED,
        "block",
        `Symbol ${ctx.symbol} is not on the doctrine whitelist.`,
        { symbol: ctx.symbol },
      ),
    );
    // No point checking the rest.
    return reasons;
  }

  // Account halts — highest priority.
  if (ctx.killSwitchEngaged) {
    reasons.push(
      gate(
        GATE_CODES.KILL_SWITCH,
        "halt",
        "Kill-switch is engaged. No new signals or orders.",
      ),
    );
  }
  if (ctx.botStatus === "halted") {
    reasons.push(gate(GATE_CODES.BOT_HALTED, "halt", "Bot is halted."));
  }
  if (ctx.botStatus === "paused") {
    reasons.push(gate(GATE_CODES.BOT_PAUSED, "halt", "Bot is paused."));
  }

  // Kill-switch floor (hard) — uses per-user resolved floor when present.
  if (ctx.equityUsd < KILL_SWITCH_FLOOR) {
    reasons.push(
      gate(
        GATE_CODES.BALANCE_FLOOR,
        "halt",
        `Equity $${ctx.equityUsd.toFixed(2)} below kill-switch floor $${KILL_SWITCH_FLOOR.toFixed(2)}.`,
        { equityUsd: ctx.equityUsd, floor: KILL_SWITCH_FLOOR },
      ),
    );
  }

  // Daily caps
  if (ctx.dailyTradeCount >= MAX_TRADES_PER_DAY) {
    reasons.push(
      gate(
        GATE_CODES.TRADE_COUNT_CAP,
        "halt",
        `Daily trade cap (${MAX_TRADES_PER_DAY}) reached.`,
        { dailyTradeCount: ctx.dailyTradeCount, cap: MAX_TRADES_PER_DAY },
      ),
    );
  }
  if (
    ctx.dailyRealizedPnlUsd < 0 &&
    Math.abs(ctx.dailyRealizedPnlUsd) >= MAX_DAILY_LOSS_USD
  ) {
    reasons.push(
      gate(
        GATE_CODES.DAILY_LOSS_CAP,
        "halt",
        `Daily loss cap $${MAX_DAILY_LOSS_USD} reached (realized $${ctx.dailyRealizedPnlUsd.toFixed(2)}).`,
        {
          dailyRealizedPnlUsd: ctx.dailyRealizedPnlUsd,
          cap: MAX_DAILY_LOSS_USD,
        },
      ),
    );
  }

  // Position / portfolio conflicts (symbol-specific block, not an account halt)
  if (ctx.hasOpenPosition) {
    reasons.push(
      gate(
        GATE_CODES.OPEN_POSITION,
        "block",
        `${ctx.symbol}: position already open.`,
        { symbol: ctx.symbol },
      ),
    );
  }
  if (ctx.hasPendingSignal) {
    reasons.push(
      gate(
        GATE_CODES.PENDING_SIGNAL,
        "block",
        `${ctx.symbol}: signal pending operator decision.`,
        { symbol: ctx.symbol },
      ),
    );
  }

  // Guardrail wall (any row at level=blocked)
  const blocked = (ctx.guardrails ?? []).find((g) => g.level === "blocked");
  if (blocked) {
    reasons.push(
      gate(
        GATE_CODES.GUARDRAIL_BLOCKED,
        "halt",
        `Guardrail blocked: ${blocked.label}.`,
        { guardrailLabel: blocked.label },
      ),
    );
  }

  // Spread
  if (
    typeof ctx.bid === "number" &&
    typeof ctx.ask === "number" &&
    ctx.bid > 0 &&
    ctx.ask > 0
  ) {
    const mid = (ctx.bid + ctx.ask) / 2;
    const spreadBps = ((ctx.ask - ctx.bid) / mid) * 10_000;
    if (spreadBps > MAX_SPREAD_BPS) {
      reasons.push(
        gate(
          GATE_CODES.SPREAD_TOO_WIDE,
          "skip",
          `${ctx.symbol}: spread ${spreadBps.toFixed(1)} bps > ${MAX_SPREAD_BPS} bps.`,
          { symbol: ctx.symbol, spreadBps, cap: MAX_SPREAD_BPS },
        ),
      );
    }
  }

  // Stale data
  if (ctx.latestCandleEndedAt) {
    const seconds = (now.getTime() - new Date(ctx.latestCandleEndedAt).getTime()) / 1000;
    if (seconds > STALE_DATA_SECONDS) {
      reasons.push(
        gate(
          GATE_CODES.STALE_DATA,
          "skip",
          `${ctx.symbol}: candle ${Math.round(seconds)}s old > ${STALE_DATA_SECONDS}s.`,
          { symbol: ctx.symbol, ageSeconds: seconds, cap: STALE_DATA_SECONDS },
        ),
      );
    }
  }

  return reasons;
}

/** A reason with severity "halt" or "block" is a refusal. */
export function isRefusal(r: GateReason): boolean {
  return r.severity === "halt" || r.severity === "block";
}

/** Returns true if any reason in the list is a refusal. */
export function anyRefusal(reasons: GateReason[]): boolean {
  return reasons.some(isRefusal);
}
