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
  SYMBOL_WHITELIST,
  getProfile,
  validateDoctrineInvariants,
  type TradingProfile,
} from "../_shared/doctrine.ts";
import {
  GATE_CODES,
  gate,
  type GateReason,
} from "../_shared/reasons.ts";
import {
  getActiveEventModeGateFromSystem,
} from "../_shared/event-mode.ts";
import {
  fetchCandles,
  fetchCandles4h,
  MarketHealthTracker,
  type Candle,
  type Symbol,
} from "../_shared/market.ts";
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
import { clampSize, notionalFromRiskPct } from "../_shared/sizing.ts";
import {
  resolveDoctrine,
  type DoctrineSettingsRow,
  type ResolvedDoctrine,
} from "../_shared/doctrine-resolver.ts";
import {
  appendTransition,
  transitionSignal,
  transitionTrade,
  type LifecycleTransition,
} from "../_shared/lifecycle.ts";
import { buildPatternMemory } from "../_shared/trade-stats.ts";
import {
  persistSnapshot,
  type PerSymbolSnapshot,
} from "../_shared/snapshot.ts";
import {
  getBrokerCredentials,
  placeMarketBuy,
} from "../_shared/broker.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";

// Fail loud on doctrine drift — if someone edits a constant wrong, this
// explodes at cold-start instead of silently mis-sizing a live order.
validateDoctrineInvariants();

// ── LLM Circuit Breaker ───────────────────────────────────────────
// Tracks consecutive AI gateway failures across warm invocations.
// Fail-safe: when open, the engine skips AI calls and locks the tick
// with AI_ERROR rather than firing signals without AI confirmation.
// Module-level state survives warm invocations; cold starts reset it,
// which is intentional (a cold start probes the gateway fresh).

const CB_STATE = {
  failures: 0,
  openedAt: 0 as number,
  state: "closed" as "closed" | "open" | "half-open",
};

const OPEN_THRESHOLD = 3;       // Trip after 3 consecutive failures
const RESET_AFTER_MS = 60_000;  // Stay open for 60s, then probe
const BRAIN_TRUST_REFRESH_DEBOUNCE_MS = 10 * 60_000; // 10m per user+symbol
const brainTrustRefreshAttempts = new Map<string, number>();

function cbAllow(): boolean {
  if (CB_STATE.state === "closed") return true;
  if (CB_STATE.state === "open") {
    if (Date.now() - CB_STATE.openedAt >= RESET_AFTER_MS) {
      CB_STATE.state = "half-open";
      console.log("[signal-engine] circuit breaker: half-open — probing AI");
      return true; // allow one probe
    }
    return false;
  }
  // half-open: allow the probe
  return true;
}

function cbSuccess(): void {
  if (CB_STATE.state !== "closed") {
    console.log("[signal-engine] circuit breaker: closed — AI gateway recovered");
  }
  CB_STATE.failures = 0;
  CB_STATE.state = "closed";
}

function cbFailure(): void {
  CB_STATE.failures += 1;
  if (CB_STATE.state === "half-open" || CB_STATE.failures >= OPEN_THRESHOLD) {
    CB_STATE.state = "open";
    CB_STATE.openedAt = Date.now();
    console.error(
      `[signal-engine] circuit breaker OPEN after ${CB_STATE.failures} failures — pausing ${RESET_AFTER_MS/1000}s`,
    );
  }
}

interface BrainTrustFreshnessResult {
  state:
    | "fresh"
    | "refreshed"
    | "refresh_failed"
    | "stale_after_refresh"
    | "refresh_debounced";
  momentum1h: string | null;
  momentum4h: string | null;
  momentumAgeMin: number | null;
  maxAgeMin: number;
  lastBrainTrustSuccessAt: string | null;
  lastRefreshAttemptAt: string | null;
  upstreamFetchErrorCode: string | null;
  refreshTriggerResult: "not_attempted" | "debounced" | "success" | "failed";
}

// deno-lint-ignore no-explicit-any
async function ensureFreshBrainTrustMomentum(admin: any, userId: string, symbol: string, isPaper: boolean): Promise<BrainTrustFreshnessResult> {
  const maxAgeMin = 120;
  const readRow = async () => {
    const { data } = await admin
      .from("market_intelligence")
      .select("recent_momentum_1h,recent_momentum_4h,recent_momentum_at,last_updated")
      .eq("user_id", userId)
      .eq("symbol", symbol)
      .maybeSingle();
    const momentumAt = data?.recent_momentum_at ? new Date(data.recent_momentum_at).getTime() : null;
    const momentumAgeMin = momentumAt ? (Date.now() - momentumAt) / 60_000 : null;
    return {
      momentum1h: data?.recent_momentum_1h ?? null,
      momentum4h: data?.recent_momentum_4h ?? null,
      momentumAgeMin,
      lastBrainTrustSuccessAt: data?.last_updated ?? null,
      fresh: !!data?.recent_momentum_1h && !!data?.recent_momentum_4h && !!momentumAt && momentumAgeMin !== null && momentumAgeMin <= maxAgeMin,
    };
  };

  const first = await readRow();
  if (first.fresh) {
    return { state: "fresh", momentum1h: first.momentum1h, momentum4h: first.momentum4h, momentumAgeMin: first.momentumAgeMin, maxAgeMin, lastBrainTrustSuccessAt: first.lastBrainTrustSuccessAt, lastRefreshAttemptAt: null, upstreamFetchErrorCode: null, refreshTriggerResult: "not_attempted" };
  }
  if (!isPaper) {
    return { state: "stale_after_refresh", momentum1h: first.momentum1h, momentum4h: first.momentum4h, momentumAgeMin: first.momentumAgeMin, maxAgeMin, lastBrainTrustSuccessAt: first.lastBrainTrustSuccessAt, lastRefreshAttemptAt: null, upstreamFetchErrorCode: null, refreshTriggerResult: "not_attempted" };
  }

  const key = `${userId}:${symbol}`;
  const lastAttempt = brainTrustRefreshAttempts.get(key) ?? 0;
  if (Date.now() - lastAttempt < BRAIN_TRUST_REFRESH_DEBOUNCE_MS) {
    return { state: "refresh_debounced", momentum1h: first.momentum1h, momentum4h: first.momentum4h, momentumAgeMin: first.momentumAgeMin, maxAgeMin, lastBrainTrustSuccessAt: first.lastBrainTrustSuccessAt, lastRefreshAttemptAt: new Date(lastAttempt).toISOString(), upstreamFetchErrorCode: null, refreshTriggerResult: "debounced" };
  }
  const attemptAtMs = Date.now();
  brainTrustRefreshAttempts.set(key, attemptAtMs);
  const attemptAtIso = new Date(attemptAtMs).toISOString();
  let upstreamFetchErrorCode: string | null = null;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const cronToken = (await admin.rpc("get_signal_engine_cron_token")).data as string | null;
    if (!cronToken) {
      return { state: "refresh_failed", momentum1h: first.momentum1h, momentum4h: first.momentum4h, momentumAgeMin: first.momentumAgeMin, maxAgeMin, lastBrainTrustSuccessAt: first.lastBrainTrustSuccessAt, lastRefreshAttemptAt: attemptAtIso, upstreamFetchErrorCode: "missing_cron_token", refreshTriggerResult: "failed" };
    }
    const resp = await fetch(`${supabaseUrl}/functions/v1/market-intelligence`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "signal_engine_stale_momentum_recovery", symbol }),
    });
    if (!resp.ok) {
      upstreamFetchErrorCode = `http_${resp.status}`;
      return { state: "refresh_failed", momentum1h: first.momentum1h, momentum4h: first.momentum4h, momentumAgeMin: first.momentumAgeMin, maxAgeMin, lastBrainTrustSuccessAt: first.lastBrainTrustSuccessAt, lastRefreshAttemptAt: attemptAtIso, upstreamFetchErrorCode, refreshTriggerResult: "failed" };
    }
  } catch {
    return { state: "refresh_failed", momentum1h: first.momentum1h, momentum4h: first.momentum4h, momentumAgeMin: first.momentumAgeMin, maxAgeMin, lastBrainTrustSuccessAt: first.lastBrainTrustSuccessAt, lastRefreshAttemptAt: attemptAtIso, upstreamFetchErrorCode: upstreamFetchErrorCode ?? "network_error", refreshTriggerResult: "failed" };
  }

  const second = await readRow();
  if (second.fresh) {
    return { state: "refreshed", momentum1h: second.momentum1h, momentum4h: second.momentum4h, momentumAgeMin: second.momentumAgeMin, maxAgeMin, lastBrainTrustSuccessAt: second.lastBrainTrustSuccessAt, lastRefreshAttemptAt: attemptAtIso, upstreamFetchErrorCode: null, refreshTriggerResult: "success" };
  }
  return { state: "stale_after_refresh", momentum1h: second.momentum1h, momentum4h: second.momentum4h, momentumAgeMin: second.momentumAgeMin, maxAgeMin, lastBrainTrustSuccessAt: second.lastBrainTrustSuccessAt, lastRefreshAttemptAt: attemptAtIso, upstreamFetchErrorCode: null, refreshTriggerResult: "success" };
}
// corsHeaders is imported from ../_shared/cors.ts (see import at top of file)

// Symbols come from the doctrine whitelist — single source of truth.
const SYMBOLS = SYMBOL_WHITELIST;

// ─── AI Model Assignments ──────────────────────────────────────
// Technical Analyst stays on Flash — runs on every tick (288×/day).
const TECHNICAL_ANALYST_MODEL = "google/gemini-3-flash-preview";
// Risk Manager uses Sonnet — binary veto on trade proposals, low volume, high stakes.
const RISK_MANAGER_MODEL = "anthropic/claude-sonnet-4-6";

// ─── Coach: per-(symbol, side) historical loss penalty ─────────
// Looks at recent closed trades for this symbol+side. If win-rate is poor
// over a meaningful sample, returns:
//   - a confidence multiplier (≤1) applied before persisting the signal
//   - a one-line warning string to inject into the AI prompt
// Returns null when there's no actionable signal (sample too small or
// performance is fine).
export interface CoachVerdict {
  confidenceMultiplier: number;
  warning: string;
  sampleSize: number;
  winRate: number;
  netPnlUsd: number;
}

export function computeCoachVerdict(
  recentTrades: ReadonlyArray<{ pnl: number | null; outcome?: string | null }>,
): CoachVerdict | null {
  const sample = recentTrades.filter((t) => t.pnl != null).slice(0, 10);
  if (sample.length < 3) return null;
  const wins = sample.filter((t) => Number(t.pnl) > 0).length;
  const winRate = wins / sample.length;
  const netPnlUsd = sample.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  if (winRate >= 0.4 && netPnlUsd >= 0) return null;

  let confidenceMultiplier = 1;
  let tone = "";
  if (winRate < 0.25) {
    confidenceMultiplier = 0.7;
    tone = "STRONG WARNING";
  } else if (winRate < 0.4 || netPnlUsd < 0) {
    confidenceMultiplier = 0.85;
    tone = "Caution";
  } else {
    return null;
  }

  const warning =
    `${tone}: last ${sample.length} trades on this symbol/side ` +
    `won ${wins}/${sample.length} (${(winRate * 100).toFixed(0)}%), ` +
    `net ${netPnlUsd >= 0 ? "+" : ""}$${netPnlUsd.toFixed(2)}. ` +
    `Confidence will be penalized ×${confidenceMultiplier.toFixed(2)} unless edge is exceptional.`;

  return { confidenceMultiplier, warning, sampleSize: sample.length, winRate, netPnlUsd };
}

// ─── News flags: extract active + critical from intel.news_flags ──
// market_intelligence.news_flags is jsonb; we expect an array of
// { label: string, severity: "critical" | "warning" | "info", active?: boolean,
//   note?: string, until?: string }.
// We treat missing `active` as true and missing `severity` as "info".
export interface NewsFlagSummary {
  active: Array<{ label: string; severity: string; note?: string; until?: string }>;
  hasCritical: boolean;
}

export function summarizeNewsFlags(rawFlags: unknown): NewsFlagSummary {
  if (!Array.isArray(rawFlags)) return { active: [], hasCritical: false };
  const now = Date.now();
  const active: NewsFlagSummary["active"] = [];
  let hasCritical = false;
  for (const f of rawFlags) {
    if (!f || typeof f !== "object") continue;
    const flag = f as {
      label?: string;
      severity?: string;
      active?: boolean;
      note?: string;
      until?: string;
    };
    if (!flag.label) continue;
    if (flag.active === false) continue;
    if (flag.until) {
      const untilTs = Date.parse(flag.until);
      if (Number.isFinite(untilTs) && untilTs < now) continue;
    }
    const severity = (flag.severity ?? "info").toLowerCase();
    active.push({ label: flag.label, severity, note: flag.note, until: flag.until });
    if (severity === "critical") hasCritical = true;
  }
  return { active, hasCritical };
}


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
  // deno-lint-ignore no-explicit-any
  intel: any;
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
  /** Active trading profile — controls per-order cap shown in the prompt. */
  profile: TradingProfile;
  /** Per-user resolved per-order USD cap. Overrides profile when present. */
  maxOrderUsdOverride?: number;
  /** Paper mode flood gates: lower the confidence bar — a wrong paper trade
   * is a data point, not a real loss. Defaults to false (live thresholds). */
  isPaper?: boolean;
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
  const { symbol, lastPrice, contextPacket, intel, LOVABLE_API_KEY, stratParams, profile, maxOrderUsdOverride, isPaper } = opts;
  const MAX_ORDER_USD = maxOrderUsdOverride ?? profile.maxOrderUsdHardCap;

  // Circuit breaker: skip AI entirely if the gateway has been failing.
  // The caller treats { error } as AI_ERROR → lock gate (fail-safe).
  if (!cbAllow()) {
    log("warn", "gate_refused", { fn: "signal-engine", symbol, code: "CIRCUIT_OPEN" });
    return { error: "circuit_open" };
  }

  const liveStopAtrMult = stratParams.stopAtrMult;
  const liveTpMult = stratParams.tpRMult;

  const macroBiasStr = intel?.macro_bias ?? "unknown";
  const envRating = intel?.environment_rating ?? "unknown";

  const systemPrompt = `
You are the Technical Analyst on a professional multi-expert crypto trading desk.
You are the execution specialist — your job is to find HIGH QUALITY entries
when the conditions are right, and to sit on your hands when they're not.

You think like the best discretionary traders in the world:
- Mark Minervini: Only take A+ setups. Stage 2 breakouts with tight bases.
  "I am only interested in stocks or assets at the sweet spot of their moves."
- Linda Bradford Raschke: Momentum, price patterns, and discipline.
  "The key is not to find the best entry, it's to trade in the right direction."
- The principle of CONFLUENCE: A trade is high quality when multiple independent
  signals agree. One signal is noise. Three signals in agreement is edge.

DECISION HIERARCHY (work through all of these before deciding):

1. MACRO FILTER (from the Brain Trust — this is non-negotiable):
   Macro bias: ${macroBiasStr} | Environment: ${envRating}
   - If macro_bias is strong_long → ONLY consider long trades. Short setups need exceptional quality.
   - If macro_bias is lean_long → Prefer longs. Short trades require extra confirmation.
   - If macro_bias is neutral → Both directions acceptable. Raise the bar for all entries.
   - If macro_bias is lean_short → Prefer shorts. Long trades require extra confirmation.
   - If macro_bias is strong_short → ONLY consider short trades.
   Never fight a strong macro bias. The trend is set by forces bigger than a 1h candle.

2. ENVIRONMENT FILTER:
   - highly_favorable: Can trade at standard confidence thresholds
   - favorable: Standard thresholds apply
   - neutral: Raise confidence threshold by 0.1
   - unfavorable: Raise confidence threshold by 0.2. Reduce size.
   - highly_unfavorable: Do NOT trade unless the setup is exceptional (confidence > 0.85)

3. MULTI-TIMEFRAME CONFIRMATION (4h structure → 1h setup → 15m timing):
   You receive 15m, 1h, and 4h candle data. Use them like a senior trader:
   - 4h tells you the intermediate trend — the river you're swimming with or against.
   - 1h tells you the setup — pullback, breakout, key level reaction.
   - 15m tells you the TIMING — is the entry happening NOW, or are you early?
   Rules:
     • 4h trending up + 1h pullback entry = high quality long (trend alignment)
     • 4h trending down + 1h counter-trend long = low quality (fighting 4h trend)
     • 15m trend AGAINST your direction = wait. The micro tape disagrees with you;
       don't catch a falling knife on a long, don't sell into a bounce on a short.
     • 15m trend WITH your direction = green light. Entry timing confirmed.
     • 15m trend FLAT but 1h/4h aligned = acceptable; small extra patience helps
       but don't skip a quality setup just because the last 45 min was quiet.
   Only take trades where 4h structure, 1h setup, and 15m timing all cooperate.
   This single discipline eliminates the majority of false signals.

4. PULLBACK PREFERENCE:
   The BEST entries are pullbacks to the fast EMA in an established trend.
   Price rises, pulls back to the moving average, RSI cools off below 50,
   then curls back up. This is "buy low within an uptrend."
   - pullback == true: +0.2 to confidence. This is a high-quality entry.
   - Breakout entries (buying new highs): Only take if volume is expanding
     and the breakout is from a tight consolidation.
     Breakouts from wide, loose patterns fail most of the time.

5. KEY LEVEL QUALITY:
   From the Pattern Recognition Specialist:
   "${intel?.entry_quality_context ?? "No pattern context available — be conservative."}"
   Use this to assess entry quality. A long at key support = tight, defined risk.
   A long in open space = wide stops, undefined risk. Prefer the former strongly.

6. SKIP CRITERIA (these override everything — skip if ANY are true):
   - No clear trend on 4h timeframe
   - 4h and 1h trends are opposed (fighting the intermediate trend)
   - setupScore < ${isPaper ? "0.45" : "0.55"} (not enough quality signals aligning)
   - Volatility is extreme (crypto flash crashes happen fast)
   - Outside of prime liquidity: only trade 07:00-23:00 UTC

SIZING PHILOSOPHY:
- High confidence (>0.80) + pullback + key level support: 20-25% of equity (max $${MAX_ORDER_USD})
- Standard confidence (0.65-0.80): 15-20% of equity
- Lower confidence (0.55-0.65): 10-15% of equity
- Never exceed $${MAX_ORDER_USD} per order (doctrine hard cap)

STOPS AND TARGETS:
- Stop: ${liveStopAtrMult}× ATR from entry (current strategy parameter)
- TP1: 1R from entry. Close half the position. Move stop to breakeven.
- TP2: ${liveTpMult}R from entry. Exit the runner.
- If the natural stop placement puts you more than 2.5% from entry, the
  setup is too extended. Skip it.

${isPaper ? `
PAPER MODE — CALIBRATION PHASE:
You are running in paper mode. No real capital is at risk.
Your threshold is 0.55 confidence (vs 0.65 in live). This is intentionally
lower to generate more signal data — but you still require a real edge.
Accept B+ setups with clear regime alignment. Reject chop, broken structure,
and setups with no identifiable edge regardless of mode.
Your paper results directly calibrate the Trade Coach. Don't flood the system
with noise — that degrades future live performance. Quality > quantity.
` : `
A SKIP IS NOT FAILURE. Most ticks should be skips.
The edge is in the quality of trades taken, not the quantity.
"The money is made in the waiting." — Jesse Livermore
`}
You MUST call submit_decision. No plain text responses.
`.trim();

  const aiResp = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TECHNICAL_ANALYST_MODEL,
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
                      "2-4 sentences. Mention macro alignment, 4h/1h confluence, pullback quality. Witty but precise. No emojis.",
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
    cbFailure();
    return { error: "ai_error", status: aiResp.status };
  }

  const aiJson = await aiResp.json();
  const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) {
    cbFailure();
    return { error: "no_decision" };
  }
  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    cbSuccess();
    return { decision: parsed };
  } catch {
    cbFailure();
    return { error: "parse_error" };
  }
}

// ─── Risk Manager — second AI call, only when a trade is proposed ──
async function runRiskManager(opts: {
  symbol: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  sizeUsd: number;
  confidence: number;
  equity: number;
  // deno-lint-ignore no-explicit-any
  openTrades: any[];
  // deno-lint-ignore no-explicit-any
  intel: any;
  LOVABLE_API_KEY: string;
}): Promise<{ verdict: "approve" | "reduce_size" | "veto"; sizeMultiplier?: number; reason: string }> {
  const { symbol, side, entry, stop, target, sizeUsd, confidence, equity, openTrades, intel, LOVABLE_API_KEY } = opts;
  const riskR = Math.abs(entry - stop);
  const rewardR = Math.abs(target - entry);
  const rrRatio = riskR > 0 ? rewardR / riskR : 0;
  const riskPct = equity > 0 ? (sizeUsd / equity) * 100 : 0;

  const systemPrompt = `
You are the Risk Manager on a professional trading desk.
A trade has been proposed. Your ONLY job is to evaluate risk.
You are not here to be enthusiastic. You are here to be right.

The greatest risk managers think like this:
- Ray Dalio: "The biggest mistake investors make is to believe that what happened
  in the recent past is likely to persist."
- Paul Tudor Jones: "I'm always thinking about losing money rather than making money."
  Don't focus on the upside. Obsess over the downside.
- Ed Seykota: "The elements of good trading are: cutting losses, cutting losses,
  and cutting losses." Your job is to make sure the bot cuts when it should.

YOUR EVALUATION FRAMEWORK:

1. RISK/REWARD MATH (non-negotiable):
   The proposed trade must offer at least 1.5:1 reward to risk.
   At 2:1, a 35% win rate breaks even. Below 1.5:1, the math doesn't support trading.
   Current R/R: ${rrRatio.toFixed(2)}:1
   - If R/R < 1.5: VETO. No exceptions.
   - If R/R 1.5-2.0: APPROVE but note the thin edge.
   - If R/R > 2.0: Solid foundation.

2. MACRO ALIGNMENT:
   Macro bias: ${intel?.macro_bias ?? "unknown"}
   - Trading WITH a strong macro bias: approve as proposed.
   - Trading AGAINST a strong macro bias: VETO unless confidence > 0.85.
   - Neutral macro: apply standard criteria.

3. ENVIRONMENT SUITABILITY:
   Environment: ${intel?.environment_rating ?? "unknown"}
   Funding signal: ${intel?.funding_rate_signal ?? "unknown"}
   - highly_unfavorable + crowded_long + proposing long: VETO.
     You're buying into a crowded trade with no new buyers left.
   - highly_favorable + crowded_short + proposing long: APPROVE with confidence.
     You have sentiment as a tailwind.

4. PORTFOLIO HEAT:
   Open positions: ${openTrades.length} / ${MAX_CORRELATED_POSITIONS} max allowed
   Current proposed size: $${sizeUsd.toFixed(2)} (${riskPct.toFixed(1)}% of equity)
   - 0 open positions: Standard sizing acceptable.
   - 1 open position, different symbol: Slightly reduce size (correlation risk).
   - 1 open position, same direction: Significant correlation. REDUCE_SIZE by 50%.
   - 2 open positions, all different symbols: Reduce size by 25-50% (heat is elevated).
   - At max positions (${MAX_CORRELATED_POSITIONS}): VETO — hard cap enforced upstream, should not reach here.

5. STOP PLACEMENT SANITY:
   Entry: $${entry.toFixed(2)} | Stop: $${stop.toFixed(2)} | Distance: ${((Math.abs(entry - stop) / entry) * 100).toFixed(2)}%
   - If stop is more than 3% from entry: VETO.
     This is too wide for $1 orders — the R is too large vs the actual dollar risk.
   - If stop is less than 0.5% from entry: VETO.
     This is too tight. Noise will stop you out constantly.
   - 0.8-2.0%: Ideal stop placement for crypto on 1h chart.

OUTPUT: approve (trade is good as proposed) / reduce_size with multiplier 0.25-0.75 /
veto with specific reason. Be decisive. No maybes.
`.trim();

  const userMsg = `
Proposed trade:
- Symbol: ${symbol}
- Direction: ${side.toUpperCase()}
- Entry: $${entry.toFixed(2)}
- Stop: $${stop.toFixed(2)} (${((Math.abs(entry - stop) / entry) * 100).toFixed(2)}% away)
- Target: $${target.toFixed(2)}
- Size: $${sizeUsd.toFixed(2)}
- Risk/Reward: ${rrRatio.toFixed(2)}:1
- Confidence: ${(confidence * 100).toFixed(0)}%
- Current equity: $${equity.toFixed(2)}
- Open positions: ${openTrades.length} (${openTrades.map((t: { side: string; symbol: string }) => `${t.side} ${t.symbol}`).join(", ") || "none"})

What is your verdict?
`.trim();

  try {
    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: RISK_MANAGER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMsg },
        ],
        tools: [{
          type: "function",
          function: {
            name: "submit_risk_verdict",
            parameters: {
              type: "object",
              required: ["verdict", "reason"],
              additionalProperties: false,
              properties: {
                verdict: { type: "string", enum: ["approve", "reduce_size", "veto"] },
                size_multiplier: {
                  type: "number",
                  description: "Only if verdict is reduce_size. 0.25-0.75 multiplier on the proposed size.",
                },
                reason: {
                  type: "string",
                  description: "1-2 sentences. Specific reason for this verdict. Reference the actual numbers.",
                },
              },
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "submit_risk_verdict" } },
      }),
    });

    if (!resp.ok) {
      console.error(
        `Risk Manager AI call failed — check model availability (model=${RISK_MANAGER_MODEL}, status=${resp.status})`,
        await resp.text().catch(() => ""),
      );
      cbFailure();
      return { verdict: "veto", reason: "Risk manager unavailable — failing safe. Retry next tick." };
    }
    const d = await resp.json();
    const args = d.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) {
      cbFailure();
      return { verdict: "veto", reason: "Risk manager parse error — failing safe. Retry next tick." };
    }
    const parsed = JSON.parse(args);
    cbSuccess();
    return {
      verdict: parsed.verdict,
      sizeMultiplier: parsed.size_multiplier,
      reason: parsed.reason,
    };
  } catch (e) {
    console.error(
      `Risk Manager AI call failed — check model availability (model=${RISK_MANAGER_MODEL})`,
      e,
    );
    cbFailure();
    return { verdict: "veto", reason: "Risk manager exception — failing safe. Retry next tick." };
  }
}

// ─── Per-user tick ────────────────────────────────────────────────
async function runTickForUser(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  candlesBySymbol: Record<Symbol, Candle[]>,
  candlesBySymbol4h: Record<Symbol, Candle[]>,
  candlesBySymbol15m: Record<Symbol, Candle[]>,
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
    { data: intelligenceBriefs },
    { data: doctrineRow },
    { data: recentClosedTrades },
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
      .select("id,symbol,side,entry_price,size")
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
    admin
      .from("market_intelligence")
      .select("*")
      .eq("user_id", userId),
    admin
      .from("doctrine_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
    admin
      .from("trades")
      .select("symbol,pnl,closed_at")
      .eq("user_id", userId)
      .eq("status", "closed")
      .order("closed_at", { ascending: false })
      .limit(10),
    buildPatternMemory(admin, userId),
  ]);

  // Index Brain Trust briefs by symbol; flag stale entries (>6h old).
  // deno-lint-ignore no-explicit-any
  const intelligenceBySymbol: Record<string, any> = {};
  for (const brief of (intelligenceBriefs ?? []) as Array<{
    symbol: string;
    generated_at: string;
    // deno-lint-ignore no-explicit-any
    [k: string]: any;
  }>) {
    const ageHours =
      (Date.now() - new Date(brief.generated_at).getTime()) / 3_600_000;
    intelligenceBySymbol[brief.symbol] = { ...brief, _stale: ageHours > 6 };
  }


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

  // Resolve the user's active trading profile. Defaults to Sentinel for
  // any user that hasn't picked a tier yet, so behaviour is unchanged
  // until they explicitly opt in to Active or Aggressive.
  const activeProfile: TradingProfile = getProfile(
    typeof sys.active_profile === "string" ? sys.active_profile : null,
  );
  // Per-user resolved doctrine — overrides profile presets when settings exist.
  // Equity comes a bit later, so resolve once below where we have it.
  const settingsRow = (doctrineRow ?? null) as DoctrineSettingsRow | null;
  const MAX_CORRELATED_POSITIONS =
    settingsRow?.max_correlated_positions ?? activeProfile.maxCorrelatedPositions;
  const RISK_PER_TRADE_PCT =
    settingsRow?.risk_per_trade_pct ?? activeProfile.riskPerTradePct;

  // Paper mode flood gates: in paper mode lower setup_score and confidence bars
  // so Taylor proposes more setups and the system builds pattern data faster.
  // Live mode keeps full bars. Default to paper when mode is not explicitly "live".
  const isPaper = ((sys as { mode?: string } | null)?.mode ?? "paper") !== "live";
  const MIN_SETUP_SCORE = isPaper ? 0.45 : 0.55;   // paper: 0.45, live: 0.55
  const MIN_CONFIDENCE = isPaper ? 0.55 : 0.65;     // paper: 0.55, live: 0.65

  // Event mode / manual pause check — halts all symbols this tick.
  const pausedGate = getActiveEventModeGateFromSystem({
    trading_paused_until: sys.trading_paused_until,
    pause_reason: sys.pause_reason ?? null,
  });
  if (pausedGate) {
    await persistSnapshot(admin, userId, {
      gateReasons: [pausedGate],
      perSymbol: [],
      chosenSymbol: null,
    });
    return {
      userId,
      tick: "event_mode",
      gateReasons: [pausedGate],
      expiredCount,
      perSymbol: [],
    };
  }

  // Correlation cap — count open trades across all whitelisted symbols.
  const totalOpenTrades = (openTrades ?? []).length;
  if (totalOpenTrades >= MAX_CORRELATED_POSITIONS) {
    const corrGate = gate(
      GATE_CODES.DOCTRINE_CORRELATION_BLOCK,
      "halt",
      `Max ${MAX_CORRELATED_POSITIONS} correlated position(s) already open across BTC/ETH/SOL (${activeProfile.label} profile).`,
      { openTrades: totalOpenTrades, cap: MAX_CORRELATED_POSITIONS, profile: activeProfile.id },
    );
    await persistSnapshot(admin, userId, {
      gateReasons: [corrGate],
      perSymbol: [],
      chosenSymbol: null,
    });
    return {
      userId,
      tick: "correlation_cap",
      gateReasons: [corrGate],
      expiredCount,
      perSymbol: [],
    };
  }

  // Book-exposure cap — total notional of open positions must not exceed
  // MAX_BOOK_EXPOSURE_PCT of equity. Prevents oversizing across symbols.
  const MAX_BOOK_EXPOSURE_PCT = 0.40; // 40% of equity max
  if (equity > 0) {
    const bookNotional = (openTrades ?? []).reduce((sum: number, t: { entry_price?: number; size?: number }) => {
      const notional = (Number(t.entry_price ?? 0)) * (Number(t.size ?? 0));
      return sum + (isFinite(notional) ? notional : 0);
    }, 0);
    const bookExposurePct = bookNotional / equity;
    if (bookExposurePct >= MAX_BOOK_EXPOSURE_PCT) {
      const exposureGate = gate(
        GATE_CODES.DOCTRINE_CORRELATION_BLOCK,
        "halt",
        `Book exposure ${(bookExposurePct * 100).toFixed(1)}% of equity exceeds ${(MAX_BOOK_EXPOSURE_PCT * 100).toFixed(0)}% cap ($${bookNotional.toFixed(2)} open vs $${equity.toFixed(2)} equity).`,
        { bookExposurePct, cap: MAX_BOOK_EXPOSURE_PCT, bookNotional, equity },
      );
      await persistSnapshot(admin, userId, {
        gateReasons: [exposureGate],
        perSymbol: [],
        chosenSymbol: null,
      });
      return {
        userId,
        tick: "book_exposure_cap",
        gateReasons: [exposureGate],
        expiredCount,
        perSymbol: [],
      };
    }
  }

  // ── Re-entry cooldown + stepped anti-tilt ─────────────────────
  // Pulls operator-tunable knobs from doctrine_settings (with safe
  // fallbacks if the row is missing). The hard-stop default is 4
  // (matches the new doctrine default); 2 = caution, 3 = cooldown.
  const reentryCooldownMin = Number(doctrineRow?.loss_cooldown_minutes ?? 30);
  const consecutiveLossLimit = Number(doctrineRow?.consecutive_loss_limit ?? 4);
  const closedTrades = (recentClosedTrades ?? []) as Array<{
    symbol: string;
    pnl: number | null;
    closed_at: string | null;
  }>;

  // Anti-tilt: count consecutive losses from most-recent backwards until a
  // winner (or no more rows). Streak naturally breaks when a winner closes.
  let consecutiveLosses = 0;
  let lastLossClosedAt: string | null = null;
  for (const t of closedTrades) {
    if (t.pnl != null && Number(t.pnl) < 0) {
      consecutiveLosses += 1;
      if (lastLossClosedAt === null) lastLossClosedAt = t.closed_at;
    } else break;
  }

  // Stepped levels:
  //   ≥ limit (default 4) → CONSECUTIVE_LOSS_HARD_STOP (halt all trading)
  //   == limit-1 (default 3) → ANTI_TILT_COOLDOWN (pause new trades 30-60m)
  //   == limit-2 (default 2) → ANTI_TILT_CAUTION (size reduced + stronger
  //                            confirmation required, but trades can still fire)
  const cooldownThreshold = Math.max(1, consecutiveLossLimit - 1);
  const cautionThreshold = Math.max(1, consecutiveLossLimit - 2);
  const antiTiltLevel: "none" | "caution" | "cooldown" | "hard_stop" =
    consecutiveLosses >= consecutiveLossLimit
      ? "hard_stop"
      : consecutiveLosses >= cooldownThreshold
        ? "cooldown"
        : consecutiveLosses >= cautionThreshold && cautionThreshold < cooldownThreshold
          ? "caution"
          : "none";

  if (antiTiltLevel === "hard_stop") {
    const tiltGate = gate(
      GATE_CODES.CONSECUTIVE_LOSS_HARD_STOP,
      "halt",
      `Hard Stop: ${consecutiveLosses} consecutive losses. Manual review required before new trades.`,
      { consecutiveLosses, limit: consecutiveLossLimit, level: "hard_stop" },
    );
    await persistSnapshot(admin, userId, {
      gateReasons: [tiltGate],
      perSymbol: [],
      chosenSymbol: null,
    });
    return {
      userId,
      tick: "anti_tilt_hard_stop",
      gateReasons: [tiltGate],
      expiredCount,
      perSymbol: [],
    };
  }

  if (antiTiltLevel === "cooldown") {
    // Pause new trades for max(loss_cooldown_minutes, 30) since the last loss.
    const cooldownMin = Math.max(30, reentryCooldownMin);
    const sinceLossMin = lastLossClosedAt
      ? (Date.now() - new Date(lastLossClosedAt).getTime()) / 60_000
      : Number.POSITIVE_INFINITY;
    if (sinceLossMin < cooldownMin) {
      const remainMin = Math.max(1, Math.round(cooldownMin - sinceLossMin));
      const tiltGate = gate(
        GATE_CODES.ANTI_TILT_COOLDOWN,
        "halt",
        `Cooldown Mode: ${consecutiveLosses} consecutive losses. New trades paused for ~${remainMin}m while the desk reassesses.`,
        {
          consecutiveLosses,
          limit: consecutiveLossLimit,
          level: "cooldown",
          cooldownMinutes: cooldownMin,
          remainingMinutes: remainMin,
        },
      );
      await persistSnapshot(admin, userId, {
        gateReasons: [tiltGate],
        perSymbol: [],
        chosenSymbol: null,
      });
      return {
        userId,
        tick: "anti_tilt_cooldown",
        gateReasons: [tiltGate],
        expiredCount,
        perSymbol: [],
      };
    }
  }

  // Caution mode is NOT a halt — it's surfaced as a soft gate that
  // sticks with the snapshot so the UI shows a Caution badge, and it
  // tightens confidence + size at sizing time below.
  const cautionGate = antiTiltLevel === "caution"
    ? gate(
        GATE_CODES.ANTI_TILT_CAUTION,
        "warn",
        `Caution Mode: ${consecutiveLosses} consecutive losses. Size reduced and stronger confirmation required.`,
        { consecutiveLosses, limit: consecutiveLossLimit, level: "caution" },
      )
    : null;

  // Per-symbol re-entry cooldown: if the most recent CLOSED trade for a
  // given symbol was a loss within the cooldown window, that symbol is
  // locked this tick. Wins clear the lock instantly. This prevents the
  // bot from "revenge re-entering" the same coin after a stop-out.
  const reentryLockedSymbols = new Map<string, { closedAt: string; minutesAgo: number }>();
  if (reentryCooldownMin > 0) {
    const seen = new Set<string>();
    for (const t of closedTrades) {
      if (!t.closed_at || seen.has(t.symbol)) continue;
      seen.add(t.symbol);
      const minutesAgo =
        (Date.now() - new Date(t.closed_at).getTime()) / 60_000;
      if (
        minutesAgo <= reentryCooldownMin &&
        t.pnl != null &&
        Number(t.pnl) < 0
      ) {
        reentryLockedSymbols.set(t.symbol, {
          closedAt: t.closed_at,
          minutesAgo,
        });
      }
    }
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
  // Resolve per-user effective doctrine caps from settings + live equity.
  // Authoritative source for max-order USD, daily-loss USD, kill-switch floor.
  const resolvedDoctrine: ResolvedDoctrine = resolveDoctrine(settingsRow, equity);
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
      profile: activeProfile,
      resolved: resolvedDoctrine,
    };
    const riskGates = evaluateRiskGates(riskCtx);

    // The first refusal is the "lock" reason we show per-row. Order of
    // precedence (most-actionable first):
    //   1. Critical news flag on this symbol (FOMC/CPI/etc. in window)
    //   2. Re-entry cooldown after a recent loss
    //   3. First halt/block from the standard risk gate
    const symbolIntel = intelligenceBySymbol[symbol] ?? null;
    const newsSummary = summarizeNewsFlags(symbolIntel?.news_flags);
    const reentryHit = reentryLockedSymbols.get(symbol);

    // Brain Trust momentum freshness gate. Required before any proposal.
    // In paper mode, attempt a safe refresh before hard-blocking.
    const freshness = await ensureFreshBrainTrustMomentum(admin, userId, symbol, isPaper);
    const momentum1h = freshness.momentum1h;
    const momentum4h = freshness.momentum4h;
    const momentumAgeMin = freshness.momentumAgeMin ?? Number.POSITIVE_INFINITY;
    const momentumStale = !momentum1h || !momentum4h || !Number.isFinite(momentumAgeMin) || momentumAgeMin > freshness.maxAgeMin;
    const momentumGate = momentumStale
      ? gate(
          freshness.state === "refresh_failed"
            ? GATE_CODES.BRAIN_TRUST_REFRESH_FAILED
            : freshness.state === "stale_after_refresh" || freshness.state === "refresh_debounced"
            ? GATE_CODES.BRAIN_TRUST_MOMENTUM_STALE
            : GATE_CODES.MISSING_MARKET_INTELLIGENCE,
          "block",
          freshness.state === "refresh_failed"
            ? `${symbol}: Trade blocked — Brain Trust refresh failed before momentum could be validated.`
            : `${symbol}: Trade blocked — Brain Trust stale or missing short-horizon momentum read.`,
          {
            symbol,
            momentum1h,
            momentum4h,
            momentumAgeMinutes: Number.isFinite(momentumAgeMin)
              ? Math.round(momentumAgeMin)
              : null,
            maxAgeMinutes: freshness.maxAgeMin,
            refreshState: freshness.state,
            mode: isPaper ? "paper" : "live",
            last_brain_trust_success_at: freshness.lastBrainTrustSuccessAt,
            last_refresh_attempt_at: freshness.lastRefreshAttemptAt,
            upstream_fetch_error_code: freshness.upstreamFetchErrorCode,
            refresh_trigger_result: freshness.refreshTriggerResult,
            actionable_chain_text: freshness.state === "refresh_failed"
              ? `Check market-intelligence health and retry (${freshness.upstreamFetchErrorCode ?? "unknown_error"}).`
              : freshness.state === "refresh_debounced"
              ? "Refresh recently attempted; wait for debounce window, then retry."
              : freshness.state === "stale_after_refresh"
              ? "Refresh completed but momentum is still stale; inspect upstream momentum source."
              : null,
          },
        )
      : null;

    const lockGate = newsSummary.hasCritical
      ? gate(
          GATE_CODES.NEWS_FLAG_CRITICAL,
          "block",
          `${symbol}: critical news flag active — ${
            newsSummary.active
              .filter((f) => f.severity === "critical")
              .map((f) => f.label)
              .join(", ")
          }.`,
          { symbol, activeNewsFlags: newsSummary.active },
        )
      : momentumGate
      ? momentumGate
      : reentryHit
      ? gate(
          GATE_CODES.REENTRY_COOLDOWN,
          "block",
          `${symbol}: re-entry cooldown — last loss ${Math.round(reentryHit.minutesAgo)}m ago, ${reentryCooldownMin}m window.`,
          { symbol, ...reentryHit, cooldownMinutes: reentryCooldownMin },
        )
      : riskGates.find(
          (r) => r.severity === "halt" || r.severity === "block",
        );

    // No-candles gate is additive (surfaced regardless of risk gates)
    if (!candles || candles.length === 0) {
      // P6-I: this was a silent skip. Surface it in logs and agent_health
      // so Jessica + the Risk Center know the candle feed dropped.
      const ranAt = new Date().toISOString();
      console.error("[signal-engine] empty candle feed", {
        symbol,
        userId,
        ranAt,
        note: "Coinbase candle endpoint returned no data for this tick.",
      });
      // Fire-and-forget — never let a health write block the rest of the tick.
      admin
        .from("agent_health")
        .upsert(
          {
            user_id: userId,
            agent_name: "signal_engine",
            status: "degraded",
            last_failure: ranAt,
            failure_count: 1,
            last_error: `Candle feed empty for ${symbol} at ${ranAt}.`,
            checked_at: ranAt,
          },
          { onConflict: "user_id,agent_name" },
        )
        .then(({ error }) => {
          if (error) {
            console.error("[signal-engine] agent_health upsert failed", error);
          }
        });

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
      c.regime.setupScore >= MIN_SETUP_SCORE,
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
      if (c.regime.setupScore < MIN_SETUP_SCORE) {
        return [
          gate(
            GATE_CODES.LOW_SETUP_SCORE,
            "skip",
            `${c.symbol}: setup ${c.regime.setupScore.toFixed(2)} below ${MIN_SETUP_SCORE.toFixed(2)}.`,
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
  const intel = intelligenceBySymbol[winner.symbol] ?? null;
  const candles1h = candlesBySymbol[winner.symbol] ?? [];
  const candles4h = candlesBySymbol4h[winner.symbol] ?? [];
  const candles15m = candlesBySymbol15m[winner.symbol] ?? [];

  const trend1h = (() => {
    if (candles1h.length < 20) return "insufficient_data";
    const recent = candles1h.slice(-20).map((c) => c.c);
    const firstHalf = recent.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const secondHalf = recent.slice(10).reduce((a, b) => a + b, 0) / 10;
    return secondHalf > firstHalf * 1.005
      ? "up"
      : secondHalf < firstHalf * 0.995
      ? "down"
      : "flat";
  })();
  const trend4h = (() => {
    if (candles4h.length < 10) return "insufficient_data";
    const recent = candles4h.slice(-10).map((c) => c.c);
    const firstHalf = recent.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const secondHalf = recent.slice(5).reduce((a, b) => a + b, 0) / 5;
    return secondHalf > firstHalf * 1.01
      ? "up"
      : secondHalf < firstHalf * 0.99
      ? "down"
      : "flat";
  })();
  // 15m momentum: are the last few bars going WITH the proposed direction?
  // Used for entry timing — gives the AI a "right now / wait" signal.
  const momentum15m = (() => {
    if (candles15m.length < 8) {
      return { trend: "insufficient_data", lastBarPct: 0, last3BarsPct: 0 };
    }
    const recent = candles15m.slice(-8).map((c) => c.c);
    const last = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    const threeAgo = recent[recent.length - 4];
    const lastBarPct = ((last - prev) / prev) * 100;
    const last3BarsPct = ((last - threeAgo) / threeAgo) * 100;
    const trend =
      last3BarsPct > 0.15 ? "up" : last3BarsPct < -0.15 ? "down" : "flat";
    return {
      trend,
      lastBarPct: Number(lastBarPct.toFixed(3)),
      last3BarsPct: Number(last3BarsPct.toFixed(3)),
    };
  })();

  const contextPacket = {
    profile: {
      id: activeProfile.id,
      label: activeProfile.label,
      maxOrderUsd: activeProfile.maxOrderUsdHardCap,
      maxTradesPerDay: activeProfile.maxDailyTradesHardCap,
      maxDailyLossUsd: activeProfile.maxDailyLossUsdHardCap,
      maxCorrelatedPositions: activeProfile.maxCorrelatedPositions,
      riskPerTradePct: activeProfile.riskPerTradePct,
      scanIntervalSeconds: activeProfile.scanIntervalSeconds,
    },
    doctrine: {
      maxOrderUsd: activeProfile.maxOrderUsdHardCap,
      maxTradesPerDay: activeProfile.maxDailyTradesHardCap,
      maxDailyLossUsd: activeProfile.maxDailyLossUsdHardCap,
      killSwitchFloorUsd:
        CAPITAL_PRESERVATION_DOCTRINE.globalRules.minBalanceUsdKillSwitch,
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
    strategyParams: liveParams,
    brainTrust: intel
      ? {
        // Macro Strategist
        macroBias: intel.macro_bias,
        macroConfidence: intel.macro_confidence,
        marketPhase: intel.market_phase,
        trendStructure: intel.trend_structure,
        nearestSupport: intel.nearest_support,
        nearestResistance: intel.nearest_resistance,
        keyLevelNotes: intel.key_level_notes,
        macroSummary: intel.macro_summary,
        // Crypto Intelligence
        fundingRateSignal: intel.funding_rate_signal,
        fundingRatePct: intel.funding_rate_pct,
        fearGreedScore: intel.fear_greed_score,
        fearGreedLabel: intel.fear_greed_label,
        environmentRating: intel.environment_rating,
        sentimentSummary: intel.sentiment_summary,
        // Pattern Recognition
        patternContext: intel.pattern_context,
        entryQualityContext: intel.entry_quality_context,
        // Meta
        briefAge: intel.generated_at
          ? `${Math.round((Date.now() - new Date(intel.generated_at).getTime()) / 60000)}min ago`
          : "not available",
        isStale: intel._stale ?? false,
        // Active news/event flags (critical ones already hard-gated upstream;
        // this surfaces the warnings/info ones to the AI so it can be cautious).
        activeNewsFlags: summarizeNewsFlags(intel.news_flags).active,
      }
      : {
        error:
          "No intelligence brief available — Brain Trust hasn't run yet. Be conservative.",
      },
    timeframes: {
      "15m": {
        lastPrice: candles15m[candles15m.length - 1]?.c ?? 0,
        trend: momentum15m.trend,
        lastBarPct: momentum15m.lastBarPct,
        last3BarsPct: momentum15m.last3BarsPct,
        candleCount: candles15m.length,
      },
      "1h": {
        lastPrice: candles1h[candles1h.length - 1]?.c ?? 0,
        trend: trend1h,
        candleCount: candles1h.length,
      },
      "4h": {
        lastPrice: candles4h[candles4h.length - 1]?.c ?? 0,
        trend: trend4h,
        candleCount: candles4h.length,
        recentCandles: candles4h.slice(-8).map((c) => ({
          t: new Date(c.t * 1000).toISOString().slice(0, 13) + ":00",
          o: c.o.toFixed(2),
          h: c.h.toFixed(2),
          l: c.l.toFixed(2),
          c: c.c.toFixed(2),
        })),
      },
    },
  };

  const aiResult = await decideForSymbol({
    symbol: winner.symbol,
    lastPrice: winner.lastPrice,
    regime: winner.regime,
    contextPacket,
    intel,
    LOVABLE_API_KEY,
    stratParams: liveParams,
    profile: activeProfile,
    maxOrderUsdOverride: resolvedDoctrine.maxOrderUsd,
    isPaper,
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

  // ── Stage 4: derive entry/stop, then size by % risk ──────────
  // Direction transparency: distinguish an active engine choice from a
  // silent default. If the AI omitted `side`, we used to default to
  // "long" — now we mark that as a fallback and refuse to propose the
  // trade so users never see a silent default-long entry. The signal
  // is dropped with a gate reason the operator can inspect.
  const aiSide = decision.side === "long" || decision.side === "short" ? decision.side : null;
  const side: "long" | "short" = aiSide ?? "long";
  const directionBasis: "engine_chose_long" | "engine_chose_short" | "default_long_fallback" =
    aiSide === "long"
      ? "engine_chose_long"
      : aiSide === "short"
        ? "engine_chose_short"
        : "default_long_fallback";

  if (decision.decision === "propose_trade" && directionBasis === "default_long_fallback") {
    const fallbackGate = gate(
      GATE_CODES.DEFAULT_LONG_FALLBACK_BLOCKED,
      "block",
      `${winner.symbol}: AI proposed a trade without picking a side — refusing to default to long.`,
      { symbol: winner.symbol },
    );
    await persistSnapshot(admin, userId, {
      gateReasons: [fallbackGate],
      perSymbol,
      chosenSymbol: winner.symbol,
    });
    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "skip",
      title: `Engine refused ${winner.symbol} — no explicit side`,
      summary:
        "The AI proposed a trade but did not specify long or short. Silent default-long is disabled; the trade was dropped.",
      tags: [winner.symbol, "default-long-fallback", "blocked"],
    });
    return {
      userId,
      tick: "default_long_fallback_blocked",
      symbol: winner.symbol,
      gateReasons: [fallbackGate],
      expiredCount,
      perSymbol,
    };
  }

  const entry = Number(decision.proposed_entry ?? winner.lastPrice);

  // ── Coach: penalize confidence if recent (symbol, side) has bled ──
  // Looks at the last 10 closed trades for this exact pair. If win-rate
  // is poor over a meaningful sample, we shrink the confidence score
  // (which feeds size + auto-execute threshold) and prepend a warning
  // so the operator sees why a high-conviction setup landed at lower
  // confidence in the UI.
  const sameSidedRecent = (recentClosedTrades ?? []).filter(
    (t: { symbol: string; side?: string | null; pnl: number | null }) =>
      t.symbol === winner.symbol && (t.side ?? null) === side,
  );
  const coachVerdict = computeCoachVerdict(sameSidedRecent);

  // Stop fallback uses the strategy's stop_atr_mult so the param actually
  // changes live trades, not just backtests. We approximate ATR as 1% of
  // price (decent rough constant for hourly BTC/ETH/SOL); the regime block
  // already exposes annualizedVolPct if a future revision wants tighter.
  const fallbackStopPct = Math.max(0.004, Math.min(0.04, stratStopAtrMult * 0.01));
  const stop = Number(
    decision.proposed_stop ??
      (side === "long" ? entry * (1 - fallbackStopPct) : entry * (1 + fallbackStopPct)),
  );

  // % risk-based sizing — the professional way:
  //   notional = (equity × riskPct) / stopDistancePct
  // The AI's size_pct hint is used only as a *confidence* nudge that can
  // shrink the trade, never grow it past the doctrine cap or the risk floor.
  const aiSizeHint = Math.max(
    0.05,
    Math.min(0.25, Number(decision.size_pct ?? 0.15)),
  );
  const rawConf = Math.max(0, Math.min(1, Number(decision.confidence ?? 0.5)));
  const conf = coachVerdict
    ? Math.max(0, Math.min(1, rawConf * coachVerdict.confidenceMultiplier))
    : rawConf;
  if (coachVerdict) {
    decision.reasoning = `[Coach] ${coachVerdict.warning} ${decision.reasoning ?? ""}`.trim();
    console.log(
      `coach: ${winner.symbol}/${side} conf ${rawConf.toFixed(2)} → ${conf.toFixed(2)} (${coachVerdict.warning})`,
    );
  }
  // Re-check MIN_CONFIDENCE after coach penalty — the multiplier may have
  // pushed a borderline signal below the threshold. Drop it here rather than
  // persisting a sub-threshold signal that the operator would reject anyway.
  if (conf < MIN_CONFIDENCE) {
    return {
      symbol: winner.symbol,
      outcome: "skipped",
      reason: `coach_penalty: conf ${rawConf.toFixed(2)} × ${coachVerdict?.confidenceMultiplier.toFixed(2)} = ${conf.toFixed(2)} < MIN_CONFIDENCE(${MIN_CONFIDENCE})`,
    };
  }
  const riskBasedUsd = notionalFromRiskPct(equity, entry, stop, RISK_PER_TRADE_PCT);
  // Confidence multiplier: 0.55 → 0.5×, 1.0 → 1.0× (linear).
  const confMult = Math.max(0.5, Math.min(1.0, (conf - 0.55) / 0.45 + 0.5));
  // Allow the AI to *shrink* via size_pct vs the 0.25 maximum slot.
  const aiShrinkMult = Math.max(0.4, Math.min(1.0, aiSizeHint / 0.25));
  const sizingMult = Math.min(confMult, aiShrinkMult);
  // If risk-based math produces zero (degenerate stop), fall back to the
  // legacy equity × hint behaviour so we never insert a 0-USD signal.
  const aiProposedUsd = riskBasedUsd > 0
    ? riskBasedUsd * sizingMult
    : equity * aiSizeHint;

  const sizePct = equity > 0 ? aiProposedUsd / equity : aiSizeHint;

  const clamp = clampSize({
    proposedQuoteUsd: aiProposedUsd,
    equityUsd: equity,
    symbolPrice: entry,
    symbol: winner.symbol,
    profile: activeProfile,
    resolved: resolvedDoctrine,
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

  let sizeUsd = clamp.sizeUsd;
  let fullSize = clamp.qty;

  const riskPerUnit = Math.abs(entry - stop);
  // Target fallback honors the strategy's tp_r_mult.
  const target = Number(
    decision.proposed_target ??
      (side === "long"
        ? entry + riskPerUnit * stratTpRMult
        : entry - riskPerUnit * stratTpRMult),
  );
  const tp1 = Number(
    decision.proposed_tp1 ??
      (side === "long" ? entry + riskPerUnit : entry - riskPerUnit),
  );

  // ── Stage 4.5: Risk Manager (second AI call) ─────────────────
  // Only fires when a trade is actually proposed — keeps cost low since
  // most ticks are skips. Veto = bail out completely. reduce_size = trim
  // the order before persisting. approve = no-op.
  let riskVerdict: {
    verdict: "approve" | "reduce_size" | "veto";
    sizeMultiplier?: number;
    reason: string;
  } | null = null;
  if (decision.decision === "propose_trade") {
    riskVerdict = await runRiskManager({
      symbol: winner.symbol,
      side: side as "long" | "short",
      entry,
      stop,
      target,
      sizeUsd,
      confidence: conf,
      equity,
      openTrades: openTrades ?? [],
      intel,
      LOVABLE_API_KEY,
    });

    if (riskVerdict.verdict === "veto") {
      await admin.from("journal_entries").insert({
        user_id: userId,
        kind: "skip",
        title: `Risk Manager vetoed ${winner.symbol} ${side.toUpperCase()} @ $${entry.toFixed(2)}`,
        summary: `Risk Manager: ${riskVerdict.reason}`,
        tags: [winner.symbol, "risk-veto", winner.regime.regime],
      });
      const vetoGate = gate(
        GATE_CODES.AI_SKIP,
        "skip",
        `${winner.symbol}: Risk Manager veto — ${riskVerdict.reason}`,
        { symbol: winner.symbol, riskManagerVerdict: riskVerdict },
      );
      await persistSnapshot(admin, userId, {
        gateReasons: [vetoGate],
        perSymbol,
        chosenSymbol: winner.symbol,
      });
      return {
        userId,
        tick: "risk_vetoed",
        symbol: winner.symbol,
        reason: riskVerdict.reason,
        gateReasons: [vetoGate],
        expiredCount,
        perSymbol,
      };
    }

    if (riskVerdict.verdict === "reduce_size") {
      const originalSizeUsd = sizeUsd;
      const mult = Math.max(0.25, Math.min(0.75, riskVerdict.sizeMultiplier ?? 0.5));
      sizeUsd = Math.max(0.25, sizeUsd * mult);
      fullSize = entry > 0 ? sizeUsd / entry : fullSize;
      console.log(
        `Risk Manager reduced size $${originalSizeUsd.toFixed(2)} → $${sizeUsd.toFixed(2)} (×${mult}): ${riskVerdict.reason}`,
      );
      decision.reasoning = `${decision.reasoning ?? ""} [Risk Manager: ${riskVerdict.reason}]`;
    }
  }


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
      direction_basis: directionBasis,
      lifecycle_phase: "proposed",
      lifecycle_transitions: [proposedTransition],
      paper_grade: isPaper,
      context_snapshot: {
        regime: winner.regime,
        lastPrice: winner.lastPrice,
        perSymbol,
        tp1,
        pullback: winner.regime.pullback,
        doctrineClampedBy: clamp.clampedBy,
        riskManagerVerdict: riskVerdict ?? null,
        coachVerdict: coachVerdict ?? null,
        rawConfidence: rawConf,
        activeNewsFlags: summarizeNewsFlags(intel?.news_flags).active,
        // Brain Trust snapshot at signal-creation time — used by post-trade-learn
        // to evaluate the trade in the context that was CURRENT when the signal
        // was generated (not the potentially-hours-stale live market_intelligence).
        brainTrustSnapshot: intel
          ? {
            symbol: intel.symbol,
            generated_at: intel.generated_at,
            macro_bias: intel.macro_bias,
            environment: intel.environment,
            pattern_context: intel.pattern_context,
            news_flags: intel.news_flags,
            running_narrative: intel.running_narrative,
          }
          : null,
      },
      status: "pending",
      // TTL: signal is valid for 30 minutes. Bobby's pending-signal query
      // filters expires_at > NOW(), so stale signals from before a pause
      // window are automatically invisible on resume.
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
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

    // ── Two-phase write — ghost-trade & idempotency fix ────────────────
    //
    // CRIT-1 (ghost trade): the old pattern called placeMarketBuy() first,
    // then inserted the DB row. If the INSERT failed after a successful fill
    // we had a real Coinbase position with no DB record — undetectable and
    // unrecoverable without manual reconciliation.
    //
    // CRIT-2 (idempotency): crypto.randomUUID() was called at invocation
    // time. A Deno cold-start mid-execution would fire a second BUY with a
    // brand-new clientOrderId, doubling the position size.
    //
    // Fix: derive clientOrderId deterministically from signalRow.id so every
    // retry uses the same Coinbase idempotency key.  Pre-insert a
    // 'broker_pending' trade row BEFORE touching the broker.  On success,
    // UPDATE to 'open' with actual fill data.  On failure, UPDATE to
    // 'broker_failed' so the operator can reconcile.  Either way there is
    // always a DB row — ghost trades are impossible.
    const clientOrderId = signalRow.id; // deterministic: same UUID on retry

    // Trade lifecycle seed — built before the broker call so the pending row
    // carries a complete audit trail from the moment of intent.
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

    // ── PHASE 1: pre-insert 'broker_pending' row BEFORE broker call ──────
    const { data: pendingTradeRow, error: pendingInsertErr } = await admin
      .from("trades")
      .insert({
        user_id: userId,
        symbol: winner.symbol,
        side,
        size: fullSize,           // estimated; updated to fill qty after broker
        original_size: fullSize,
        entry_price: entry,       // estimated; updated to fill price after broker
        stop_loss: stop,
        take_profit: target,
        tp1_price: tp1,
        tp1_filled: false,
        strategy_id: strategyId,
        strategy_version: strategyVersion,
        direction_basis: directionBasis,
        lifecycle_phase: "entered",
        lifecycle_transitions: [tradeEnteredTransition],
        reason_tags: tags,
        notes: `${liveEnabled ? "LIVE " : ""}Auto-approved (${autonomy}) @ confidence ${(conf * 100).toFixed(0)}%${winner.regime.pullback ? " · pullback entry" : ""} · awaiting broker confirmation`,
        broker_order_id: clientOrderId, // pre-set for reconciliation; replaced with fill orderId on success
        status: "broker_pending",
        outcome: "open",
      })
      .select()
      .single();

    if (pendingInsertErr || !pendingTradeRow) {
      console.error(
        "[signal-engine] PHASE-1 pre-insert failed — aborting auto-execute:",
        pendingInsertErr,
      );
      // Signal stays proposed; operator can approve manually.
      await persistSnapshot(admin, userId, {
        gateReasons: [{
          code: GATE_CODES.INSERT_ERROR,
          severity: "block" as const,
          message: `Auto-execute pre-insert failed: ${pendingInsertErr?.message ?? "unknown"}`,
          meta: { signalId: signalRow.id },
        }],
        perSymbol,
        chosenSymbol: winner.symbol,
      });
      return {
        userId,
        tick: "proposed",
        symbol: winner.symbol,
        signalId: signalRow.id,
        autonomy,
        confidence: conf,
        sizeUsd,
        clampedBy: clamp.clampedBy,
        gateReasons: [],
        expiredCount,
        perSymbol,
      };
    }

    // ── PHASE 2: call broker (live) or promote directly (paper) ──────────
    let liveEntry = entry;
    let liveSize = fullSize;
    let brokerOrderId: string | null = null;

    if (liveEnabled && !liveBlockedByAck) {
      try {
        const creds = await getBrokerCredentials(admin);
        const fill = await placeMarketBuy(
          creds,
          winner.symbol,
          sizeUsd.toFixed(2),
          clientOrderId, // deterministic — safe to retry; Coinbase rejects duplicates
        );
        liveEntry = fill.fillPrice;
        liveSize = fill.filledBaseSize;
        brokerOrderId = fill.orderId;
        console.log(
          `[signal-engine] LIVE BUY auto-executed ${winner.symbol} ` +
            `@ $${liveEntry} size=${liveSize} orderId=${brokerOrderId}`,
        );
        // Promote pending → open with actual fill data
        await admin
          .from("trades")
          .update({
            status: "open",
            entry_price: liveEntry,
            size: liveSize,
            original_size: liveSize,
            broker_order_id: brokerOrderId,
            notes: `LIVE Auto-approved (${autonomy}) @ confidence ${(conf * 100).toFixed(0)}%${winner.regime.pullback ? " · pullback entry" : ""} · Coinbase orderId: ${brokerOrderId}`,
          })
          .eq("id", pendingTradeRow.id);
      } catch (brokerErr) {
        console.error(
          `[signal-engine] LIVE auto-execute broker failed for ${winner.symbol} — ` +
            `trade ${pendingTradeRow.id} marked broker_failed for manual reconciliation:`,
          brokerErr,
        );
        // Mark pre-inserted row as failed so operator can reconcile against Coinbase.
        await admin
          .from("trades")
          .update({
            status: "broker_failed",
            notes: `Broker call failed: ${String(brokerErr)}`,
          })
          .eq("id", pendingTradeRow.id);
        return {
          userId,
          tick: "proposed",
          symbol: winner.symbol,
          signalId: signalRow.id,
          autonomy,
          confidence: conf,
          sizeUsd,
          clampedBy: clamp.clampedBy,
          gateReasons: [{
            code: GATE_CODES.BROKER_ORDER_FAILED,
            severity: "block" as const,
            message: `Live auto-execute blocked: broker BUY failed for ${winner.symbol}.`,
            meta: { error: String(brokerErr), tradeId: pendingTradeRow.id },
          }],
          expiredCount,
          perSymbol,
        };
      }
    } else {
      // Paper mode: no broker call — promote pending → open immediately.
      await admin
        .from("trades")
        .update({
          status: "open",
          notes: `Auto-approved (${autonomy}) @ confidence ${(conf * 100).toFixed(0)}%${winner.regime.pullback ? " · pullback entry" : ""}`,
        })
        .eq("id", pendingTradeRow.id);
    }

    // Alias used by downstream signal-update + journal code.
    const tradeRow = pendingTradeRow;

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
      title: `${liveEnabled ? "LIVE " : ""}Auto-opened ${side.toUpperCase()} ${winner.symbol} @ $${liveEntry.toFixed(2)}`,
      summary: [
        `Autonomy ${autonomy}. Confidence ${(conf * 100).toFixed(0)}%.`,
        decision.reasoning ?? "",
        intel
          ? `Macro: ${intel.macro_bias} (${(Number(intel.macro_confidence ?? 0) * 100).toFixed(0)}% confidence)`
          : "",
        intel ? `Environment: ${intel.environment_rating}` : "",
        intel?.pattern_context
          ? `Pattern: ${String(intel.pattern_context).slice(0, 100)}...`
          : "",
      ].filter(Boolean).join(" | "),
      tags: [
        "auto-execute",
        autonomy,
        winner.regime.regime,
        winner.symbol,
        intel?.macro_bias ?? "no-intel",
        intel?.environment_rating ?? "no-intel",
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

    // Fetch 1h, 4h AND 15m candles for ALL symbols in parallel — shared
    // across users this tick. The 4h provides intermediate-trend context;
    // the 15m provides entry-timing momentum so the Technical Analyst can
    // tell the difference between "right setup, right time" and "right
    // setup, too early."
    //
    // 4h: Coinbase has no native 4h granularity — fetchCandles4h() pulls
    // 1h candles and aggregates locally into UTC-aligned 4h buckets.
    //
    // Failures are accumulated into a single MarketHealthTracker and
    // flushed per-user to agent_health.signal_engine after each user's
    // tick. A success for one (symbol, timeframe) does NOT clear a
    // failure for a different (symbol, timeframe) — see MarketHealthTracker.
    const tracker = new MarketHealthTracker();
    const fetchCtx = { tracker };
    const [candleResults1h, candleResults4h, candleResults15m] = await Promise.all([
      Promise.allSettled(SYMBOLS.map((s) => fetchCandles(s, 3600, fetchCtx))),
      Promise.allSettled(SYMBOLS.map((s) => fetchCandles4h(s, fetchCtx))),
      Promise.allSettled(SYMBOLS.map((s) => fetchCandles(s, 900, fetchCtx))),
    ]);
    const candlesBySymbol = {} as Record<Symbol, Candle[]>;
    const candlesBySymbol4h = {} as Record<Symbol, Candle[]>;
    const candlesBySymbol15m = {} as Record<Symbol, Candle[]>;
    SYMBOLS.forEach((s, i) => {
      const r1h = candleResults1h[i];
      const r4h = candleResults4h[i];
      const r15 = candleResults15m[i];
      if (r1h.status === "fulfilled") candlesBySymbol[s] = r1h.value;
      else {
        console.error(`Failed to fetch ${s} 1h:`, r1h.reason);
        candlesBySymbol[s] = [];
      }
      if (r4h.status === "fulfilled") candlesBySymbol4h[s] = r4h.value;
      else {
        console.error(`Failed to fetch ${s} 4h:`, r4h.reason);
        candlesBySymbol4h[s] = [];
      }
      if (r15.status === "fulfilled") candlesBySymbol15m[s] = r15.value;
      else {
        console.error(`Failed to fetch ${s} 15m:`, r15.reason);
        candlesBySymbol15m[s] = [];
      }
    });

    if (isCronFanout) {
      // Each cron tier targets one profile. The default 5-min cron has
      // no tier hint and is treated as "sentinel". This way each user
      // is scanned at exactly their profile's cadence — no double-firing.
      const profileTier =
        body?.profileTier === "active" || body?.profileTier === "aggressive"
          ? body.profileTier
          : "sentinel";

      const { data: activeUsers } = await admin
        .from("system_state")
        .select("user_id, active_profile")
        .eq("bot", "running")
        .eq("kill_switch_engaged", false);

      // deno-lint-ignore no-explicit-any
      const results: any[] = [];
      for (const u of activeUsers ?? []) {
        const userTier =
          u.active_profile === "active" || u.active_profile === "aggressive"
            ? u.active_profile
            : "sentinel";
        if (userTier !== profileTier) continue; // wrong cron for this user
        try {
          const r = await runTickForUser(
            admin,
            u.user_id,
            candlesBySymbol,
            candlesBySymbol4h,
            candlesBySymbol15m,
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
        // Flush per-user market-data health regardless of tick outcome.
        // Tracker is shared across users this tick — the same candle
        // failures apply to everyone.
        await tracker.flushHealth(admin, u.user_id);
      }
      return new Response(
        JSON.stringify({
          mode: "cron_fanout",
          profileTier,
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
      candlesBySymbol4h,
      candlesBySymbol15m,
      LOVABLE_API_KEY,
    );
    await tracker.flushHealth(admin, userData.user.id);
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
