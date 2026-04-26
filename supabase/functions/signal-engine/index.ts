// ============================================================
// signal-engine — the AI's tick loop (multi-symbol, doctrine-gated)
// ------------------------------------------------------------
// Diamond Tier refactor: all doctrine / risk / sizing / lifecycle /
// regime / market / pattern-memory logic lives in ../_shared/*.
// This file is now the orchestrator: fetch → per-symbol gate →
// pick winner → AI decision → clamp → FSM-insert.
//
// Two modes:
//   1. Single user (JWT)        — UI "Run now" button
//   2. Cron fanout (vault token) — pg_cron every 5 min
// ============================================================

import {
  CAPITAL_PRESERVATION_DOCTRINE,
  MAX_ORDER_USD,
  SYMBOL_WHITELIST,
  validateDoctrineInvariants,
} from "../_shared/doctrine.ts";
import {
  GATE_CODES,
  gate,
  type GateReason,
} from "../_shared/reasons.ts";
import { fetchCandles, type Candle, type Symbol } from "../_shared/market.ts";
import {
  computeRegime,
  TRADEABLE_REGIMES,
  type RegimeResult,
} from "../_shared/regime.ts";
import {
  anyRefusal,
  evaluateRiskGates,
  type RiskContext,
} from "../_shared/risk.ts";
import { clampSize } from "../_shared/sizing.ts";
import {
  appendTransition,
  transitionSignal,
  transitionTrade,
  type LifecycleTransition,
} from "../_shared/lifecycle.ts";
import { buildPatternMemory } from "../_shared/pattern-memory.ts";
import {
  persistSnapshot,
  type PerSymbolSnapshot,
} from "../_shared/snapshot.ts";

// Fail loud on doctrine drift — if someone edits a constant wrong, this
// explodes at cold-start instead of silently mis-sizing a live order.
validateDoctrineInvariants();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Symbols come from the doctrine whitelist — single source of truth.
const SYMBOLS = SYMBOL_WHITELIST;

// ─── Expired-pending sweep ─────────────────────────────────────
// Marks stale pending signals as expired and appends a lifecycle
// transition via the FSM helper.
// deno-lint-ignore no-explicit-any
async function expirePendingSignals(admin: any, userId: string): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: stale } = await admin
    .from("trade_signals")
    .select("id,symbol,side,proposed_entry,confidence,lifecycle_transitions,lifecycle_phase,status")
    .eq("user_id", userId)
    .eq("status", "pending")
    .lt("expires_at", nowIso);

  if (!stale || stale.length === 0) return 0;

  for (const s of stale) {
    const current = (s.lifecycle_phase ?? s.status ?? "proposed") as
      | "proposed"
      | "approved"
      | "rejected"
      | "expired"
      | "executed";
    const result = transitionSignal(current, "expired", {
      actor: "engine",
      reason: "TTL elapsed without decision",
    });
    if (!result.ok) {
      // Illegal transition — don't corrupt the row, just log and continue.
      console.warn(`signal ${s.id} cannot transition to expired: ${result.error}`);
      continue;
    }
    const next: LifecycleTransition[] = appendTransition(
      s.lifecycle_transitions,
      result.transition!,
    );
    await admin
      .from("trade_signals")
      .update({
        status: "expired",
        decided_by: "expired",
        decision_reason: "TTL elapsed without decision",
        decided_at: nowIso,
        lifecycle_phase: "expired",
        lifecycle_transitions: next,
      })
      .eq("id", s.id);

    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "skip",
      title: `Signal expired · ${s.side?.toUpperCase?.() ?? ""} ${s.symbol}`,
      summary: `Signal at $${Number(s.proposed_entry).toFixed(0)} (conf ${(Number(s.confidence) * 100).toFixed(0)}%) timed out before approval.`,
      tags: ["expired", "signal"],
    });
  }
  return stale.length;
}

// ─── AI decision for a single symbol ─────────────────────────────
async function decideForSymbol(opts: {
  symbol: Symbol;
  lastPrice: number;
  regime: RegimeResult;
  // deno-lint-ignore no-explicit-any
  contextPacket: any;
  LOVABLE_API_KEY: string;
  /** Live strategy parameters that shape the prompt. The AI is told the
   * stop band and TP-R multiple to use so changing the approved strategy
   * actually changes how live trades get sized — not just the backtest. */
  stratParams: {
    emaFast: number;
    emaSlow: number;
    rsiPeriod: number;
    stopAtrMult: number;
    tpRMult: number;
  };
}): Promise<
  | { decision: {
      decision: "propose_trade" | "skip";
      side?: "long" | "short";
      confidence?: number;
      size_pct?: number;
      proposed_entry?: number;
      proposed_stop?: number;
      proposed_tp1?: number;
      proposed_target?: number;
      reasoning?: string;
    };
    }
  | { error: string; status?: number }
> {
  const { symbol, lastPrice, contextPacket, LOVABLE_API_KEY, stratParams } = opts;

  // Translate stop_atr_mult into an approximate price-percent band so the
  // AI has a concrete target. This is a heuristic — final stop is hard
  // computed in Stage 4 from `regime.atrPct * stopAtrMult` — but the
  // prompt needs *some* concrete number to anchor on.
  const stopAtrMult = stratParams.stopAtrMult;
  const tpRMult = stratParams.tpRMult;
  // Rough conversion: an ATR-multiple of 1.5 on hourly BTC ≈ 1.0–1.5%.
  const stopPctLow = Math.max(0.4, stopAtrMult * 0.7).toFixed(1);
  const stopPctHigh = Math.max(0.6, stopAtrMult * 1.1).toFixed(1);

  const systemPrompt = `You are the Trader OS Signal Engine for ${symbol}.
Disciplined, conservative, risk-first, compounding-focused. A SKIP is data, not failure.

ENTRY PHILOSOPHY: "Buy low within an uptrend, sell high in pieces."
PROPOSE_TRADE only when ALL are true:
- setupScore >= 0.65
- regime is trending_up, trending_down, or breakout (NEVER chop, NEVER pure range)
- volatility is not extreme
- no guardrail blocked or above 0.85 utilization
- For LONGS: strongly prefer pullback==true (RSI dipped <45 then curled up while slow EMA still rising). A clean pullback is the highest-quality buy.

STRATEGY PARAMETERS (from the live approved strategy):
- EMA fast: ${stratParams.emaFast} · EMA slow: ${stratParams.emaSlow} · RSI period: ${stratParams.rsiPeriod}
- stop_atr_mult: ${stopAtrMult} → place proposed_stop ~${stopPctLow}–${stopPctHigh}% from entry
- tp_r_mult: ${tpRMult} → proposed_target should be ${tpRMult}R from entry (TP1 = 1R)
These are the live knobs. If the strategy widens stops, your proposed_stop must reflect that.

PATTERN MEMORY: review patternMemory in context. If a symbol or regime has been losing recently, raise your bar. If it has been winning, you may be slightly more aggressive on size (still capped by doctrine at $${MAX_ORDER_USD}/order).

SIZING (compounding-friendly, survival-first):
- size_pct: 0.10–0.25 of equity, scaled by confidence and pullback quality
- proposed_stop: ~${stopPctLow}–${stopPctHigh}% from entry (per stop_atr_mult above)
- proposed_tp1: 1R from entry — half closes here, stop moves to breakeven
- proposed_target (TP2): ${tpRMult}R from entry — runner exits here

Your numbers will be hard-clamped by the doctrine ($${MAX_ORDER_USD} max notional per order). Propose honestly.

You MUST call submit_decision. No plain text.`;

  const aiResp = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Tick at ${new Date().toISOString()} for ${symbol} @ $${lastPrice.toFixed(2)}.\nContext:\n${JSON.stringify(contextPacket, null, 2)}\n\nDecide.`,
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "submit_decision",
              description:
                "Submit a trading decision: propose a trade or skip with reasoning.",
              parameters: {
                type: "object",
                properties: {
                  decision: {
                    type: "string",
                    enum: ["propose_trade", "skip"],
                  },
                  side: { type: "string", enum: ["long", "short"] },
                  confidence: { type: "number", description: "0..1" },
                  size_pct: {
                    type: "number",
                    description: "0.10-0.25",
                  },
                  proposed_entry: { type: "number" },
                  proposed_stop: {
                    type: "number",
                    description: "~1.2-1.8% away",
                  },
                  proposed_tp1: {
                    type: "number",
                    description: "1R from entry — half closes, stop→BE",
                  },
                  proposed_target: {
                    type: "number",
                    description: "2R from entry — runner exits",
                  },
                  reasoning: {
                    type: "string",
                    description:
                      "2-4 sentences. Mention pullback quality + pattern memory if relevant. Witty but precise. No emojis.",
                  },
                },
                required: ["decision", "confidence", "reasoning"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "submit_decision" },
        },
      }),
    },
  );

  if (!aiResp.ok) {
    const t = await aiResp.text().catch(() => "");
    console.error(`AI gateway error ${symbol}`, aiResp.status, t);
    return { error: "ai_error", status: aiResp.status };
  }

  const aiJson = await aiResp.json();
  const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return { error: "no_decision" };
  try {
    return { decision: JSON.parse(toolCall.function.arguments) };
  } catch {
    return { error: "parse_error" };
  }
}

// ─── Per-user tick ────────────────────────────────────────────────
async function runTickForUser(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  candlesBySymbol: Record<Symbol, Candle[]>,
  LOVABLE_API_KEY: string,
) {
  const expiredCount = await expirePendingSignals(admin, userId);

  const [
    { data: sys },
    { data: acct },
    { data: rails },
    { data: openTrades },
    { data: pendingSignals },
    { data: recentSignals },
    patternMemory,
  ] = await Promise.all([
    admin.from("system_state").select("*").eq("user_id", userId).maybeSingle(),
    admin.from("account_state").select("*").eq("user_id", userId).maybeSingle(),
    admin
      .from("guardrails")
      .select("label,level,utilization,current_value,limit_value")
      .eq("user_id", userId),
    admin
      .from("trades")
      .select("id,symbol,side")
      .eq("user_id", userId)
      .eq("status", "open"),
    admin
      .from("trade_signals")
      .select("id,symbol")
      .eq("user_id", userId)
      .eq("status", "pending")
      .gte("expires_at", new Date().toISOString()),
    admin
      .from("trade_signals")
      .select(
        "symbol,side,status,confidence,decision_reason,decided_by,created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(15),
    buildPatternMemory(admin, userId),
  ]);

  if (!sys) {
    return {
      userId,
      tick: "no_system_state",
      gateReasons: [
        gate(
          GATE_CODES.NO_SYSTEM_STATE,
          "halt",
          "User has no system_state row.",
        ),
      ],
      expiredCount,
      perSymbol: [],
    };
  }

  // Persisted approved strategy (if any) so signals & trades carry identity.
  // CRITICAL: we now load `params` too so the live engine actually uses
  // ema_fast / ema_slow / rsi_period / stop_atr_mult / tp_r_mult from the
  // approved strategy. Previously the engine only loaded id/version, which
  // meant the entire learning loop was tuning a backtest model that had
  // zero effect on real trades.
  const { data: approvedStrategy } = await admin
    .from("strategies")
    .select("id,version,params")
    .eq("user_id", userId)
    .eq("status", "approved")
    .order("updated_at", { ascending: false })
    .maybeSingle();
  const strategyId: string | null = approvedStrategy?.id ?? null;
  const strategyVersion: string =
    approvedStrategy?.version ?? "signal-engine v2 (ladder)";

  // Pull the live-tunable knobs out of the strategy params.
  type StratParam = { key: string; value: number | string | boolean };
  const stratParams: StratParam[] = Array.isArray(approvedStrategy?.params)
    ? (approvedStrategy!.params as StratParam[])
    : [];
  const paramNum = (key: string, fallback: number): number => {
    const p = stratParams.find((p) => p.key === key);
    if (!p) return fallback;
    const n = typeof p.value === "number" ? p.value : Number(p.value);
    return Number.isFinite(n) ? n : fallback;
  };
  const stratEmaFast = paramNum("ema_fast", 9);
  const stratEmaSlow = paramNum("ema_slow", 21);
  const stratRsiPeriod = paramNum("rsi_period", 14);
  const stratStopAtrMult = paramNum("stop_atr_mult", 1.5);
  const stratTpRMult = paramNum("tp_r_mult", 2);
  const liveParams = {
    emaFast: stratEmaFast,
    emaSlow: stratEmaSlow,
    rsiPeriod: stratRsiPeriod,
    stopAtrMult: stratStopAtrMult,
    tpRMult: stratTpRMult,
  };

  // Equity & daily counters for the risk gate.
  const equity = acct ? Number(acct.equity) : 0;
  // Daily realized PnL is computed on read via a SQL function — there is no
  // realized_pnl_today column on account_state. Falling back to 0 here would
  // silently disable the daily loss cap.
  const { data: pnlToday, error: pnlErr } = await admin.rpc(
    "realized_pnl_today",
    { p_user_id: userId },
  );
  if (pnlErr) {
    console.warn("signal-engine: realized_pnl_today RPC failed", pnlErr);
  }
  const dailyRealizedPnlUsd = Number(pnlToday ?? 0);

  // Daily trade count (UTC day)
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { count: dailyTradeCount } = await admin
    .from("trades")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", dayStart.toISOString());

  // Per-symbol lock sets
  const symbolsWithOpen = new Set(
    (openTrades ?? []).map((t: { symbol: string }) => t.symbol),
  );
  const symbolsWithPending = new Set(
    (pendingSignals ?? []).map((s: { symbol: string }) => s.symbol),
  );

  // ── Stage 1: regime for each symbol ────────────────────────────
  const candidates: Array<{
    symbol: Symbol;
    lastPrice: number;
    regime: RegimeResult;
    lockGate?: GateReason;
    riskGates: GateReason[];
  }> = [];

  for (const symbol of SYMBOLS) {
    const candles = candlesBySymbol[symbol];
    const lastPrice = candles && candles.length > 0
      ? candles[candles.length - 1].c
      : 0;

    // Compute regime even if candles missing — computeRegime returns a
    // fallback "no_trade" with noTradeReasons, which we surface below.
    // Pass the approved strategy's EMA / RSI knobs so changing the
    // strategy actually changes regime detection in the live engine.
    const regimeOpts = {
      emaFast: stratEmaFast,
      emaSlow: stratEmaSlow,
      rsiPeriod: stratRsiPeriod,
    };
    const regime: RegimeResult = candles && candles.length > 0
      ? computeRegime(candles, regimeOpts)
      : computeRegime([], regimeOpts);

    // Full risk-gate evaluation per symbol.
    const riskCtx: RiskContext = {
      symbol,
      equityUsd: equity,
      dailyRealizedPnlUsd,
      dailyTradeCount: dailyTradeCount ?? 0,
      killSwitchEngaged: !!sys.kill_switch_engaged,
      botStatus: sys.bot ?? "paused",
      hasOpenPosition: symbolsWithOpen.has(symbol),
      hasPendingSignal: symbolsWithPending.has(symbol),
      latestCandleEndedAt: candles && candles.length > 0
        ? new Date(candles[candles.length - 1].t * 1000).toISOString()
        : undefined,
      guardrails: (rails ?? []).map((g: {
        label: string;
        level: string;
        utilization: number;
      }) => ({
        label: g.label,
        level: g.level,
        utilization: Number(g.utilization ?? 0),
      })),
    };
    const riskGates = evaluateRiskGates(riskCtx);

    // The first refusal is the "lock" reason we show per-row.
    const lockGate = riskGates.find(
      (r) => r.severity === "halt" || r.severity === "block",
    );

    // No-candles gate is additive (surfaced regardless of risk gates)
    if (!candles || candles.length === 0) {
      candidates.push({
        symbol,
        lastPrice,
        regime,
        lockGate: gate(
          GATE_CODES.NO_CANDLES,
          "skip",
          `${symbol}: candle feed unavailable.`,
          { symbol },
        ),
        riskGates,
      });
      continue;
    }

    candidates.push({ symbol, lastPrice, regime, lockGate, riskGates });
  }

  // ── Account-level halts bubble up from any symbol's risk gates ──
  const accountHalt = candidates
    .flatMap((c) => c.riskGates)
    .find((r) => r.severity === "halt");
  if (accountHalt) {
    const perSymbolSnap: PerSymbolSnapshot[] = candidates.map((c) => ({
      symbol: c.symbol,
      lastPrice: c.lastPrice,
      regime: c.regime.regime,
      confidence: c.regime.confidence,
      setupScore: c.regime.setupScore,
      volatility: c.regime.volatility,
      todScore: c.regime.todScore,
      pullback: c.regime.pullback,
      lockGate: c.lockGate ?? null,
      chosen: false,
    }));
    await persistSnapshot(admin, userId, {
      gateReasons: [accountHalt],
      perSymbol: perSymbolSnap,
      chosenSymbol: null,
    });
    return {
      userId,
      tick: "halted",
      gateReasons: [accountHalt],
      reasons: [accountHalt.message],
      expiredCount,
      perSymbol: perSymbolSnap,
    };
  }

  // ── Stage 2: pick the best tradable candidate ──────────────────
  const tradable = candidates.filter(
    (c) =>
      !c.lockGate &&
      TRADEABLE_REGIMES.has(c.regime.regime) &&
      c.regime.setupScore >= 0.55,
  );
  tradable.sort((a, b) => {
    const pbA = a.regime.pullback ? 1 : 0;
    const pbB = b.regime.pullback ? 1 : 0;
    if (pbA !== pbB) return pbB - pbA;
    return b.regime.setupScore - a.regime.setupScore;
  });
  const winner = tradable[0];

  const perSymbol: PerSymbolSnapshot[] = candidates.map((c) => ({
    symbol: c.symbol,
    lastPrice: c.lastPrice,
    regime: c.regime.regime,
    confidence: c.regime.confidence,
    setupScore: c.regime.setupScore,
    volatility: c.regime.volatility,
    todScore: c.regime.todScore,
    pullback: c.regime.pullback,
    lockGate: c.lockGate ?? null,
    chosen: winner?.symbol === c.symbol,
  }));

  if (!winner) {
    const gateReasons: GateReason[] = candidates.flatMap((c) => {
      if (c.lockGate) return [c.lockGate];
      if (c.regime.regime === "chop") {
        return [
          gate(
            GATE_CODES.CHOP_REGIME,
            "skip",
            `${c.symbol}: chop — no edge.`,
            { symbol: c.symbol },
          ),
        ];
      }
      if (c.regime.regime === "range") {
        return [
          gate(
            GATE_CODES.RANGE_REGIME,
            "skip",
            `${c.symbol}: pure range — sitting out.`,
            { symbol: c.symbol },
          ),
        ];
      }
      if (c.regime.setupScore < 0.55) {
        return [
          gate(
            GATE_CODES.LOW_SETUP_SCORE,
            "skip",
            `${c.symbol}: setup ${c.regime.setupScore.toFixed(2)} below 0.55.`,
            { symbol: c.symbol, setupScore: c.regime.setupScore },
          ),
        ];
      }
      return [];
    });

    await persistSnapshot(admin, userId, {
      gateReasons,
      perSymbol,
      chosenSymbol: null,
    });

    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "skip",
      title: `Engine tick · all ${SYMBOLS.length} symbols skipped`,
      summary: gateReasons.map((g) => g.message).join(" · "),
      tags: ["multi-symbol", "skip"],
    });
    return {
      userId,
      tick: "skipped",
      reason: "no qualifying setup",
      gateReasons,
      expiredCount,
      perSymbol,
    };
  }

  // ── Stage 3: context packet + AI call ──────────────────────────
  const contextPacket = {
    doctrine: {
      maxOrderUsd: CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxOrderUsdHardCap,
      maxTradesPerDay:
        CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxDailyTradesHardCap,
      maxDailyLossUsd:
        CAPITAL_PRESERVATION_DOCTRINE.hardRules.maxDailyLossUsdHardCap,
      killSwitchFloorUsd:
        CAPITAL_PRESERVATION_DOCTRINE.hardRules.minBalanceUsdKillSwitch,
    },
    market: {
      symbol: winner.symbol,
      lastPrice: winner.lastPrice,
      ...winner.regime,
    },
    otherSymbols: candidates
      .filter((c) => c.symbol !== winner.symbol)
      .map((c) => ({
        symbol: c.symbol,
        regime: c.regime.regime,
        setupScore: c.regime.setupScore,
        locked: c.lockGate?.message ?? null,
      })),
    account: acct
      ? { equity, floor: Number(acct.balance_floor) }
      : null,
    guardrails: (rails ?? []).map(
      (g: {
        label: string;
        level: string;
        utilization: number;
        current_value: number | null;
        limit_value: number | null;
      }) => ({
        label: g.label,
        level: g.level,
        util: Number(g.utilization),
        current: g.current_value,
        limit: g.limit_value,
      }),
    ),
    recentDecisions: (recentSignals ?? []).map(
      (s: {
        symbol: string;
        side: string;
        status: string;
        confidence: number;
        decided_by: string;
        decision_reason: string;
      }) => ({
        symbol: s.symbol,
        side: s.side,
        status: s.status,
        confidence: Number(s.confidence),
        decidedBy: s.decided_by,
        reason: s.decision_reason,
      }),
    ),
    patternMemory,
  };

  const aiResult = await decideForSymbol({
    symbol: winner.symbol,
    lastPrice: winner.lastPrice,
    regime: winner.regime,
    contextPacket,
    LOVABLE_API_KEY,
    stratParams: liveParams,
  });

  if ("error" in aiResult) {
    const aiErr = gate(
      GATE_CODES.AI_ERROR,
      "skip",
      `${winner.symbol}: AI gateway error (${aiResult.error}).`,
      { symbol: winner.symbol },
    );
    await persistSnapshot(admin, userId, {
      gateReasons: [aiErr],
      perSymbol,
      chosenSymbol: winner.symbol,
    });
    return {
      userId,
      tick: "ai_error",
      symbol: winner.symbol,
      gateReasons: [aiErr],
      expiredCount,
      perSymbol,
      error: aiResult.error,
    };
  }
  const decision = aiResult.decision;

  if (decision.decision === "skip") {
    const skipGate = gate(
      GATE_CODES.AI_SKIP,
      "skip",
      `${winner.symbol}: AI declined to enter.`,
      {
        symbol: winner.symbol,
        reasoning: decision.reasoning ?? "",
      },
    );
    await persistSnapshot(admin, userId, {
      gateReasons: [skipGate],
      perSymbol,
      chosenSymbol: winner.symbol,
    });
    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "skip",
      title: `Engine skipped ${winner.symbol} @ $${winner.lastPrice.toFixed(0)} · ${winner.regime.regime}`,
      summary: decision.reasoning ?? "AI chose to skip.",
      tags: [winner.symbol, winner.regime.regime, winner.regime.volatility],
    });
    return {
      userId,
      tick: "skipped",
      symbol: winner.symbol,
      reasoning: decision.reasoning,
      gateReasons: [skipGate],
      expiredCount,
      perSymbol,
    };
  }

  // ── Stage 4: clamp size through the doctrine ──────────────────
  const side = decision.side ?? "long";
  const entry = Number(decision.proposed_entry ?? winner.lastPrice);
  const sizePct = Math.max(
    0.05,
    Math.min(0.25, Number(decision.size_pct ?? 0.15)),
  );
  const aiProposedUsd = equity * sizePct;

  const clamp = clampSize({
    proposedQuoteUsd: aiProposedUsd,
    equityUsd: equity,
    symbolPrice: entry,
    symbol: winner.symbol,
  });

  if (clamp.blocked) {
    const refusal = clamp.clampedBy.find(
      (r) => r.severity === "halt" || r.severity === "block",
    ) ??
      gate(
        GATE_CODES.DOCTRINE_INVALID_SIZE,
        "block",
        "Doctrine clamp rejected the proposed size.",
      );
    await persistSnapshot(admin, userId, {
      gateReasons: [refusal, ...clamp.clampedBy.filter((r) => r !== refusal)],
      perSymbol,
      chosenSymbol: winner.symbol,
    });
    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "skip",
      title: `Doctrine refused ${winner.symbol} @ $${entry.toFixed(2)}`,
      summary: refusal.message,
      tags: [winner.symbol, "doctrine", refusal.code],
    });
    return {
      userId,
      tick: "doctrine_refused",
      symbol: winner.symbol,
      gateReasons: [refusal, ...clamp.clampedBy.filter((r) => r !== refusal)],
      expiredCount,
      perSymbol,
    };
  }

  const sizeUsd = clamp.sizeUsd;
  const fullSize = clamp.qty;

  const stop = Number(
    decision.proposed_stop ??
      (side === "long" ? entry * 0.985 : entry * 1.015),
  );
  const target = Number(
    decision.proposed_target ??
      (side === "long" ? entry * 1.03 : entry * 0.97),
  );
  const riskPerUnit = Math.abs(entry - stop);
  const tp1 = Number(
    decision.proposed_tp1 ??
      (side === "long" ? entry + riskPerUnit : entry - riskPerUnit),
  );
  const conf = Math.max(0, Math.min(1, Number(decision.confidence ?? 0.5)));

  // ── Stage 5: INSERT signal row (FSM-traced) ──────────────────
  const proposedResult = transitionSignal("proposed", "proposed", {
    actor: "engine",
    reason: "AI proposed entry (synthetic origin)",
  });
  // The FSM table doesn't list proposed→proposed as legal, so we build
  // the first transition record manually (lifecycle is always seeded
  // at "proposed"; later transitions go through transitionSignal()).
  const proposedTransition: LifecycleTransition = proposedResult.ok
    ? proposedResult.transition!
    : {
      phase: "proposed",
      at: new Date().toISOString(),
      by: "engine",
      reason: "AI proposed entry",
    };

  const { data: signalRow, error: insertErr } = await admin
    .from("trade_signals")
    .insert({
      user_id: userId,
      symbol: winner.symbol,
      side,
      confidence: conf,
      setup_score: winner.regime.setupScore,
      regime: winner.regime.regime,
      proposed_entry: entry,
      proposed_stop: stop,
      proposed_target: target,
      size_usd: sizeUsd,
      size_pct: sizePct,
      ai_reasoning: decision.reasoning ?? "",
      ai_model: "google/gemini-3-flash-preview",
      strategy_id: strategyId,
      strategy_version: strategyVersion,
      lifecycle_phase: "proposed",
      lifecycle_transitions: [proposedTransition],
      context_snapshot: {
        regime: winner.regime,
        lastPrice: winner.lastPrice,
        perSymbol,
        tp1,
        pullback: winner.regime.pullback,
        doctrineClampedBy: clamp.clampedBy,
      },
      status: "pending",
    })
    .select()
    .single();

  if (insertErr) {
    console.error("signal insert failed", insertErr);
    const insGate = gate(
      GATE_CODES.INSERT_ERROR,
      "halt",
      `Signal insert failed: ${insertErr.message}`,
    );
    await persistSnapshot(admin, userId, {
      gateReasons: [insGate],
      perSymbol,
      chosenSymbol: winner.symbol,
    });
    return {
      userId,
      tick: "insert_error",
      error: insertErr.message,
      gateReasons: [insGate],
      expiredCount,
      perSymbol,
    };
  }

  // ── Stage 6: auto-execute if autonomy allows ─────────────────
  const autonomy = sys.autonomy_level ?? "manual";
  const liveEnabled = !!sys.live_trading_enabled;
  const liveAck = sys.live_money_acknowledged_at;

  // Defense-in-depth: never auto-execute when live mode is on but the
  // operator has not signed the live-money acknowledgment. The DB
  // BEFORE UPDATE trigger blocks the toggle from flipping in the UI,
  // but a stale row from before the migration could still slip
  // through. We check here too so a misconfigured account can't
  // place a real order via the autonomous path.
  const liveBlockedByAck = liveEnabled && !liveAck;

  // P1-A: daily dollar cap on auto-executed trades. Defaults to $2.00
  // (max trades/day × MAX_ORDER_USD) and is configurable per account
  // via account_state.daily_auto_execute_cap_usd. The notional of the
  // proposed trade plus everything already auto-executed today must
  // fit under the cap.
  const dailyAutoCapUsd = Number(acct?.daily_auto_execute_cap_usd ?? 2.0);
  const proposedNotionalUsd = Number(fullSize) * Number(entry);
  let executedTodayUsd = 0;
  try {
    const { data: notionalData } = await admin.rpc(
      "auto_executed_notional_today",
      { p_user_id: userId },
    );
    executedTodayUsd = Number(notionalData ?? 0);
  } catch (e) {
    // If we can't read the notional, fail-closed: block auto-execute.
    console.error("auto_executed_notional_today rpc failed:", e);
    executedTodayUsd = Number.POSITIVE_INFINITY;
  }
  const totalAfter = executedTodayUsd + proposedNotionalUsd;
  const dailyCapBlocked = totalAfter > dailyAutoCapUsd + 1e-9;

  const autoApprove =
    !liveBlockedByAck &&
    !dailyCapBlocked &&
    (autonomy === "autonomous" || (autonomy === "assisted" && conf >= 0.85));

  if (dailyCapBlocked) {
    console.warn(
      `auto-execute blocked: daily $ cap. ` +
        `today=$${executedTodayUsd.toFixed(4)} + proposed=$${proposedNotionalUsd.toFixed(4)} > cap=$${dailyAutoCapUsd.toFixed(2)}`,
    );
  }

  if (autoApprove) {
    const tags = ["ai-signal", "auto", winner.regime.regime, winner.symbol];
    if (winner.regime.pullback) tags.push("pullback");

    // Trade lifecycle: initial phase always "entered"
    const tradeEnteredResult = transitionTrade("entered", "entered", {
      actor: "auto",
      reason: `Auto-approved (${autonomy}, conf ${(conf * 100).toFixed(0)}%)`,
    });
    const tradeEnteredTransition: LifecycleTransition =
      tradeEnteredResult.ok
        ? tradeEnteredResult.transition!
        : {
          phase: "entered",
          at: new Date().toISOString(),
          by: "auto",
          reason: `Auto-approved (${autonomy})`,
        };

    const { data: tradeRow } = await admin
      .from("trades")
      .insert({
        user_id: userId,
        symbol: winner.symbol,
        side,
        size: fullSize,
        original_size: fullSize,
        entry_price: entry,
        stop_loss: stop,
        take_profit: target,
        tp1_price: tp1,
        tp1_filled: false,
        strategy_id: strategyId,
        strategy_version: strategyVersion,
        lifecycle_phase: "entered",
        lifecycle_transitions: [tradeEnteredTransition],
        reason_tags: tags,
        notes: `Auto-approved (${autonomy}) @ confidence ${(conf * 100).toFixed(0)}%${winner.regime.pullback ? " · pullback entry" : ""}`,
        status: "open",
        outcome: "open",
      })
      .select()
      .single();

    // Signal: proposed → executed
    const sigExecuted = transitionSignal("proposed", "approved", {
      actor: "auto",
      reason: `Auto-approved (${autonomy})`,
    });
    const sigApprovedExec = transitionSignal("approved", "executed", {
      actor: "auto",
      reason: `Auto-approved (${autonomy})`,
      meta: { tradeId: tradeRow?.id ?? null },
    });
    const newTransitions: LifecycleTransition[] = [
      proposedTransition,
      ...(sigExecuted.ok ? [sigExecuted.transition!] : []),
      ...(sigApprovedExec.ok ? [sigApprovedExec.transition!] : []),
    ];

    await admin
      .from("trade_signals")
      .update({
        status: "executed",
        decided_by: "auto",
        decision_reason: `Auto-approved (${autonomy}, conf ${(conf * 100).toFixed(0)}%)`,
        decided_at: new Date().toISOString(),
        executed_trade_id: tradeRow?.id ?? null,
        lifecycle_phase: "executed",
        lifecycle_transitions: newTransitions,
      })
      .eq("id", signalRow.id);

    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "trade",
      title: `Auto-opened ${side.toUpperCase()} ${winner.symbol} @ $${entry.toFixed(2)}`,
      summary: `Autonomy ${autonomy}. Confidence ${(conf * 100).toFixed(0)}%. ${decision.reasoning ?? ""}`,
      tags: [
        "auto-execute",
        autonomy,
        winner.regime.regime,
        winner.symbol,
      ],
    });

    // ─── P1-B: immediate Telegram ping on every auto-execute ────
    //
    // The operator must not learn about an autonomous order from a
    // weekly digest. notify_telegram is a SECURITY DEFINER RPC that
    // routes via the user's configured bot; if it isn't configured
    // the RPC is a no-op. We swallow errors so a Telegram outage
    // can't fail the trade insert that already succeeded.
    try {
      const liveSuffix = liveEnabled ? " · LIVE" : " · paper";
      await admin.rpc("notify_telegram", {
        p_user_id: userId,
        p_event_type: "auto_execute",
        p_severity: liveEnabled ? "high" : "info",
        p_title: `Auto-executed ${side.toUpperCase()} ${winner.symbol}${liveSuffix}`,
        p_message:
          `${(conf * 100).toFixed(0)}% confidence · ${autonomy}\n` +
          `entry $${entry.toFixed(2)} · stop $${stop.toFixed(2)}\n` +
          `TP1 $${tp1.toFixed(2)} · TP2 $${target.toFixed(2)}\n` +
          `size ${fullSize.toFixed(8)} ${winner.symbol.split("-")[0]}`,
      });
    } catch (e) {
      // Don't crash the engine on a notify failure.
      console.error("notify_telegram failed (non-fatal):", e);
    }
  }

  // Clean snapshot — winner chosen. The only "soft" gate that may
  // surface here is the daily-dollar cap: it blocked auto-execute,
  // but the signal still landed for the operator to approve manually.
  // Surfacing the reason lets the UI show "auto-execute capped" so
  // the operator isn't confused by a bot that proposed but didn't fire.
  const softGates: GateReason[] = dailyCapBlocked
    ? [
      {
        code: GATE_CODES.DAILY_DOLLAR_CAP,
        severity: "block",
        message:
          `Auto-execute capped — $${executedTodayUsd.toFixed(2)} already auto-executed today, ` +
          `cap $${dailyAutoCapUsd.toFixed(2)}. Signal proposed for manual approval.`,
        meta: {
          executedTodayUsd,
          proposedNotionalUsd,
          dailyAutoCapUsd,
        },
      },
    ]
    : [];

  await persistSnapshot(admin, userId, {
    gateReasons: softGates,
    perSymbol,
    chosenSymbol: winner.symbol,
  });

  return {
    userId,
    tick: autoApprove ? "executed" : "proposed",
    symbol: winner.symbol,
    signalId: signalRow.id,
    autonomy,
    confidence: conf,
    sizeUsd,
    clampedBy: clamp.clampedBy,
    gateReasons: softGates,
    expiredCount,
    perSymbol,
  };
}

// ─── HTTP entry point ────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.45.0"
    );
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Detect mode: cron fanout sends { cronAll: true, cronToken: <vault-token> }
    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const authHeader = req.headers.get("Authorization") ?? "";

    let isCronFanout = false;
    if (body?.cronAll === true && typeof body?.cronToken === "string") {
      const { data: tok } = await admin.rpc("get_signal_engine_cron_token");
      if (tok && tok === body.cronToken) isCronFanout = true;
    }

    // Fetch ALL symbols' candles in parallel — shared across users this tick.
    const candleResults = await Promise.allSettled(
      SYMBOLS.map((s) => fetchCandles(s)),
    );
    const candlesBySymbol = {} as Record<Symbol, Candle[]>;
    SYMBOLS.forEach((s, i) => {
      const r = candleResults[i];
      if (r.status === "fulfilled") candlesBySymbol[s] = r.value;
      else {
        console.error(`Failed to fetch ${s}:`, r.reason);
        candlesBySymbol[s] = [];
      }
    });

    if (isCronFanout) {
      const { data: activeUsers } = await admin
        .from("system_state")
        .select("user_id")
        .eq("bot", "running")
        .eq("kill_switch_engaged", false);

      // deno-lint-ignore no-explicit-any
      const results: any[] = [];
      for (const u of activeUsers ?? []) {
        try {
          const r = await runTickForUser(
            admin,
            u.user_id,
            candlesBySymbol,
            LOVABLE_API_KEY,
          );
          results.push(r);
        } catch (e) {
          console.error("user tick failed", u.user_id, e);
          results.push({
            userId: u.user_id,
            tick: "error",
            error: String(e),
          });
        }
      }
      return new Response(
        JSON.stringify({
          mode: "cron_fanout",
          users: results.length,
          symbols: SYMBOLS,
          results,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Single-user mode: validate JWT
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const result = await runTickForUser(
      admin,
      userData.user.id,
      candlesBySymbol,
      LOVABLE_API_KEY,
    );
    const status = result.tick === "ai_error" ? 500 : 200;
    return new Response(JSON.stringify(result), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("signal-engine error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

// Silence unused import warning when anyRefusal isn't used above;
// it's re-exported for downstream edge functions that need it.
export { anyRefusal };
