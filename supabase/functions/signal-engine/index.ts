// signal-engine — the AI's tick loop, multi-symbol edition.
// PERCEIVE → ANALYZE → GATE → DECIDE → PROPOSE → EXECUTE → LEARN
// Two modes:
//   1. Single user (JWT)        — UI "Run now" button
//   2. Cron fanout (vault token) — pg_cron every 5 min
//
// Phase 4: each tick processes BTC-USD, ETH-USD, SOL-USD in parallel per user.
// Each symbol gets its own regime read, its own AI call, its own signal row.
// Cross-symbol gates: only one open position OR pending signal across the whole
// account (we're not running a portfolio yet — one bet at a time, period).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;
type Symbol = (typeof SYMBOLS)[number];

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

// ─── Structured gate reasons ─────────────────────────────────────────────
// Frontend can switch on `code` for icon/tone; render `message` as the human line.
type GateSeverity = "halt" | "block" | "skip";
type GateCode =
  | "KILL_SWITCH"
  | "BOT_HALTED"
  | "GUARDRAIL_BLOCKED"
  | "OPEN_POSITION"
  | "PENDING_SIGNAL"
  | "NO_CANDLES"
  | "CHOP_REGIME"
  | "RANGE_REGIME"
  | "LOW_SETUP_SCORE"
  | "EXTREME_VOLATILITY"
  | "OUTSIDE_LIQUIDITY_WINDOW"
  | "AI_SKIP"
  | "AI_ERROR"
  | "INSERT_ERROR"
  | "NO_QUALIFYING_SETUP"
  | "NO_SYSTEM_STATE";

interface GateReason {
  code: GateCode;
  severity: GateSeverity;
  message: string;
  meta?: Record<string, unknown>;
}

function gate(code: GateCode, severity: GateSeverity, message: string, meta?: Record<string, unknown>): GateReason {
  return meta ? { code, severity, message, meta } : { code, severity, message };
}

// EMA helper for pullback detection.
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// RSI(14) — last value only.
function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

function computeRegime(candles: Candle[]) {
  if (candles.length < 25) {
    return {
      regime: "range",
      confidence: 0,
      volatility: "normal",
      setupScore: 0,
      todScore: 0.5,
      pctChange: 0,
      annualizedVolPct: 0,
      pullback: false,
      rsiNow: 50,
      rsiPrev: 50,
      emaFast: 0,
      emaSlow: 0,
      slowRising: false,
      noTradeReasons: ["Not enough data"],
    };
  }
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const first = closes[0];
  const pctChange = ((last - first) / first) * 100;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const stdev = Math.sqrt(variance);
  const annualizedVolPct = stdev * Math.sqrt(24 * 365) * 100;
  let volatility = "normal";
  if (annualizedVolPct < 30) volatility = "low";
  else if (annualizedVolPct > 80) volatility = "elevated";
  if (annualizedVolPct > 140) volatility = "extreme";
  const high = Math.max(...candles.map((c) => c.h));
  const low = Math.min(...candles.map((c) => c.l));
  const rangePct = ((high - low) / low) * 100;
  const driftRatio = Math.abs(pctChange) / Math.max(rangePct, 0.01);
  let regime = "range";
  if (driftRatio > 0.55) regime = pctChange > 0 ? "trending_up" : "trending_down";
  else if (rangePct < 0.8) regime = "chop";
  const prior20High = Math.max(...candles.slice(-21, -1).map((c) => c.h));
  if (last > prior20High * 1.001) regime = "breakout";
  const confidence = Math.min(1, Math.max(0.25, driftRatio * 1.2));
  const hour = new Date().getUTCHours();
  const todScore = hour >= 13 && hour < 21 ? 0.85 : hour >= 7 && hour < 23 ? 0.55 : 0.3;
  const trendBoost = regime === "trending_up" || regime === "breakout" ? 0.25 : regime === "trending_down" ? 0.1 : 0;
  const volBoost = volatility === "normal" ? 0.2 : volatility === "low" ? 0.05 : 0;

  // Pullback detection: in an uptrend, has price dipped to the fast EMA
  // while the slow EMA is still rising AND RSI is curling up off a dip?
  const emaFastArr = ema(closes, 9);
  const emaSlowArr = ema(closes, 21);
  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaSlow = emaSlowArr[emaSlowArr.length - 1];
  const emaSlowPrev = emaSlowArr[emaSlowArr.length - 6] ?? emaSlow;
  const slowRising = emaSlow > emaSlowPrev;
  const rsiNow = rsi(closes, 14);
  const rsiPrev = rsi(closes.slice(0, -1), 14);
  // Dip: low touched within 0.4% of fast EMA in last 3 bars
  const recent = candles.slice(-3);
  const touchedFastEma = recent.some((c) => c.l <= emaFast * 1.004);
  const inUptrend = (regime === "trending_up" || regime === "breakout") && slowRising;
  const rsiCurlingUp = rsiPrev < 45 && rsiNow > rsiPrev && rsiNow < 65;
  const pullback = inUptrend && touchedFastEma && rsiCurlingUp;

  // Boost setup score for confirmed pullbacks (the textbook buy-low setup)
  const pullbackBoost = pullback ? 0.2 : 0;
  const setupScore = Math.min(1, Math.max(0, confidence * 0.35 + todScore * 0.25 + trendBoost + volBoost + pullbackBoost));

  const noTradeReasons: string[] = [];
  if (setupScore < 0.65) noTradeReasons.push(`Setup score ${setupScore.toFixed(2)} below 0.65`);
  if (volatility === "extreme") noTradeReasons.push("Volatility extreme");
  // STRICT REGIME GATE: chop and pure range get nothing.
  if (regime === "chop" || regime === "range") noTradeReasons.push(`${regime} regime — no edge`);
  if (todScore < 0.4) noTradeReasons.push("Outside prime liquidity window");
  return { regime, confidence, volatility, setupScore, todScore, pctChange, annualizedVolPct, pullback, rsiNow, rsiPrev, emaFast, emaSlow, slowRising, noTradeReasons };
}

// Pattern memory: per-symbol+regime win/loss stats from closed trades.
async function buildPatternMemory(admin: any, userId: string) {
  const { data: closed } = await admin
    .from("trades")
    .select("symbol, side, outcome, pnl, reason_tags")
    .eq("user_id", userId)
    .eq("status", "closed")
    .order("closed_at", { ascending: false })
    .limit(50);
  if (!closed || closed.length === 0) return { totalClosed: 0, bySymbol: {}, byRegime: {} };
  const bySymbol: Record<string, { wins: number; losses: number; netPnl: number }> = {};
  const byRegime: Record<string, { wins: number; losses: number; netPnl: number }> = {};
  for (const t of closed) {
    const pnl = Number(t.pnl ?? 0);
    const win = t.outcome === "win";
    bySymbol[t.symbol] ??= { wins: 0, losses: 0, netPnl: 0 };
    bySymbol[t.symbol].wins += win ? 1 : 0;
    bySymbol[t.symbol].losses += win ? 0 : 1;
    bySymbol[t.symbol].netPnl += pnl;
    const regimeTag = (t.reason_tags ?? []).find((tag: string) =>
      ["trending_up", "trending_down", "breakout", "range", "chop"].includes(tag),
    );
    if (regimeTag) {
      byRegime[regimeTag] ??= { wins: 0, losses: 0, netPnl: 0 };
      byRegime[regimeTag].wins += win ? 1 : 0;
      byRegime[regimeTag].losses += win ? 0 : 1;
      byRegime[regimeTag].netPnl += pnl;
    }
  }
  return { totalClosed: closed.length, bySymbol, byRegime };
}

// Sweep stale pending signals → mark expired + log a journal skip.
async function expirePendingSignals(admin: any, userId: string) {
  const nowIso = new Date().toISOString();
  const { data: stale } = await admin
    .from("trade_signals")
    .select("id,symbol,side,proposed_entry,confidence")
    .eq("user_id", userId)
    .eq("status", "pending")
    .lt("expires_at", nowIso);
  if (!stale || stale.length === 0) return 0;
  await admin
    .from("trade_signals")
    .update({
      status: "expired",
      decided_by: "expired",
      decision_reason: "TTL elapsed without decision",
      decided_at: nowIso,
    })
    .in("id", stale.map((s: any) => s.id));
  for (const s of stale) {
    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "skip",
      title: `Signal expired · ${s.side?.toUpperCase()} ${s.symbol}`,
      summary: `Signal at $${Number(s.proposed_entry).toFixed(0)} (conf ${(Number(s.confidence) * 100).toFixed(0)}%) timed out before approval.`,
      tags: ["expired", "signal"],
    });
  }
  return stale.length;
}

// Fetch candles for a single symbol from Coinbase.
async function fetchCandles(symbol: Symbol): Promise<Candle[]> {
  const cbResp = await fetch(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=3600`);
  if (!cbResp.ok) throw new Error(`Coinbase ${symbol} ${cbResp.status}`);
  const raw = (await cbResp.json()) as number[][];
  const sorted = [...raw].sort((a, b) => a[0] - b[0]);
  return sorted.map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
}

// Ask the AI to decide on ONE symbol given full account context.
async function decideForSymbol(opts: {
  symbol: Symbol;
  lastPrice: number;
  regime: ReturnType<typeof computeRegime>;
  contextPacket: any;
  LOVABLE_API_KEY: string;
}) {
  const { symbol, lastPrice, contextPacket, LOVABLE_API_KEY } = opts;

  const systemPrompt = `You are the Trader OS Signal Engine for ${symbol}.
Disciplined, conservative, risk-first, compounding-focused. A SKIP is data, not failure.

ENTRY PHILOSOPHY: "Buy low within an uptrend, sell high in pieces."
PROPOSE_TRADE only when ALL are true:
- setupScore >= 0.65
- regime is trending_up, trending_down, or breakout (NEVER chop, NEVER pure range)
- volatility is not extreme
- no guardrail blocked or above 0.85 utilization
- For LONGS: strongly prefer pullback==true (RSI dipped <45 then curled up while slow EMA still rising). A clean pullback is the highest-quality buy.

PATTERN MEMORY: review patternMemory in context. If a symbol or regime has been losing recently, raise your bar. If it has been winning, you may be slightly more aggressive on size (still capped 0.25).

SIZING (compounding-friendly, survival-first):
- size_pct: 0.10–0.25 of equity, scaled by confidence and pullback quality
- proposed_stop: ~1.2–1.8% from entry
- proposed_tp1: 1R from entry — half closes here, stop moves to breakeven
- proposed_target (TP2): 2R from entry — runner exits here

You MUST call submit_decision. No plain text.`;

  const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
            description: "Submit a trading decision: propose a trade or skip with reasoning.",
            parameters: {
              type: "object",
              properties: {
                decision: { type: "string", enum: ["propose_trade", "skip"] },
                side: { type: "string", enum: ["long", "short"] },
                confidence: { type: "number", description: "0..1" },
                size_pct: { type: "number", description: "0.10-0.25" },
                proposed_entry: { type: "number" },
                proposed_stop: { type: "number", description: "~1.2-1.8% away" },
                proposed_tp1: { type: "number", description: "1R from entry — half closes, stop→BE" },
                proposed_target: { type: "number", description: "2R from entry — runner exits" },
                reasoning: { type: "string", description: "2-4 sentences. Mention pullback quality + pattern memory if relevant. Witty but precise. No emojis." },
              },
              required: ["decision", "confidence", "reasoning"],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "submit_decision" } },
    }),
  });

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

// Run one full tick for a single user across ALL symbols.
async function runTickForUser(
  admin: any,
  userId: string,
  candlesBySymbol: Record<Symbol, Candle[]>,
  LOVABLE_API_KEY: string,
) {
  // Sweep expired across all symbols first
  const expiredCount = await expirePendingSignals(admin, userId);

  const [{ data: sys }, { data: acct }, { data: rails }, { data: openTrades }, { data: pendingSignals }, { data: recentSignals }, patternMemory] =
    await Promise.all([
      admin.from("system_state").select("*").eq("user_id", userId).maybeSingle(),
      admin.from("account_state").select("*").eq("user_id", userId).maybeSingle(),
      admin.from("guardrails").select("label,level,utilization,current_value,limit_value").eq("user_id", userId),
      admin.from("trades").select("id,symbol,side").eq("user_id", userId).eq("status", "open"),
      admin
        .from("trade_signals")
        .select("id,symbol")
        .eq("user_id", userId)
        .eq("status", "pending")
        .gte("expires_at", new Date().toISOString()),
      admin
        .from("trade_signals")
        .select("symbol,side,status,confidence,decision_reason,decided_by,created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(15),
      buildPatternMemory(admin, userId),
    ]);

  if (!sys) {
    return {
      userId,
      tick: "no_system_state",
      gateReasons: [gate("NO_SYSTEM_STATE", "halt", "User has no system_state row.")],
      expiredCount,
      perSymbol: [],
    };
  }

  // Pick the persisted approved strategy (if any) so signals & trades carry identity.
  const { data: approvedStrategy } = await admin
    .from("strategies")
    .select("id,version")
    .eq("user_id", userId)
    .eq("status", "approved")
    .order("updated_at", { ascending: false })
    .maybeSingle();
  const strategyId: string | null = approvedStrategy?.id ?? null;
  const strategyVersion: string = approvedStrategy?.version ?? "signal-engine v2 (ladder)";

  // Account-level halts (apply to ALL symbols) — emit structured gate reasons.
  const accountGates: GateReason[] = [];
  if (sys.kill_switch_engaged) {
    accountGates.push(gate("KILL_SWITCH", "halt", "Kill-switch is engaged. No new signals or orders."));
  }
  if (sys.bot === "halted") {
    accountGates.push(gate("BOT_HALTED", "halt", "Bot is halted. Resume from the status footer to trade."));
  }
  const blockedRail = (rails ?? []).find((g: any) => g.level === "blocked");
  if (blockedRail) {
    accountGates.push(
      gate("GUARDRAIL_BLOCKED", "halt", `Guardrail blocked: ${blockedRail.label}.`, {
        guardrailLabel: blockedRail.label,
        current: blockedRail.current_value,
        limit: blockedRail.limit_value,
      }),
    );
  }

  if (accountGates.length > 0) {
    await persistSnapshot(admin, userId, { gateReasons: accountGates, perSymbol: [], chosenSymbol: null });
    return { userId, tick: "halted", gateReasons: accountGates, reasons: accountGates.map((g) => g.message), expiredCount, perSymbol: [] };
  }

  // Per-symbol gates: skip a symbol if it already has an open trade or pending signal.
  const symbolsWithOpen = new Set((openTrades ?? []).map((t: any) => t.symbol));
  const symbolsWithPending = new Set((pendingSignals ?? []).map((s: any) => s.symbol));

  const equity = acct ? Number(acct.equity) : 10000;

  // Stage 1: compute regime for each symbol that's not already locked up.
  const candidates: Array<{
    symbol: Symbol;
    lastPrice: number;
    regime: ReturnType<typeof computeRegime>;
    lockGate?: GateReason;
  }> = [];

  for (const symbol of SYMBOLS) {
    const candles = candlesBySymbol[symbol];
    if (!candles || candles.length === 0) {
      candidates.push({
        symbol,
        lastPrice: 0,
        regime: { regime: "range", confidence: 0, volatility: "normal", setupScore: 0, todScore: 0, pctChange: 0, annualizedVolPct: 0, noTradeReasons: ["No candles"] } as any,
        lockGate: gate("NO_CANDLES", "skip", `${symbol}: candle feed unavailable.`, { symbol }),
      });
      continue;
    }
    const lastPrice = candles[candles.length - 1].c;
    const r = computeRegime(candles);
    let lockGate: GateReason | undefined;
    if (symbolsWithOpen.has(symbol)) {
      lockGate = gate("OPEN_POSITION", "block", `${symbol}: position already open.`, { symbol });
    } else if (symbolsWithPending.has(symbol)) {
      lockGate = gate("PENDING_SIGNAL", "block", `${symbol}: signal pending operator decision.`, { symbol });
    }
    candidates.push({ symbol, lastPrice, regime: r, lockGate });
  }

  // Pick the best free candidate by setupScore. If none qualifies, every symbol
  // gets a "skipped" record but no AI calls are made (saves credits).
  const TRADEABLE_REGIMES = new Set(["trending_up", "trending_down", "breakout"]);
  const tradable = candidates.filter(
    (c) => !c.lockGate && TRADEABLE_REGIMES.has(c.regime.regime) && c.regime.setupScore >= 0.55,
  );
  tradable.sort((a, b) => {
    const pbA = a.regime.pullback ? 1 : 0;
    const pbB = b.regime.pullback ? 1 : 0;
    if (pbA !== pbB) return pbB - pbA;
    return b.regime.setupScore - a.regime.setupScore;
  });
  const winner = tradable[0];

  // Build per-symbol snapshot rows AND collect per-symbol gate reasons.
  const perSymbol: any[] = candidates.map((c) => ({
    symbol: c.symbol,
    lastPrice: c.lastPrice,
    regime: c.regime.regime,
    confidence: c.regime.confidence,
    setupScore: c.regime.setupScore,
    volatility: c.regime.volatility,
    todScore: c.regime.todScore,
    pullback: (c.regime as any).pullback ?? false,
    lockGate: c.lockGate ?? null,
    chosen: winner?.symbol === c.symbol,
  }));

  if (!winner) {
    // Build structured per-symbol gate reasons for the operator.
    const gateReasons: GateReason[] = candidates.flatMap((c) => {
      if (c.lockGate) return [c.lockGate];
      if (c.regime.regime === "chop") return [gate("CHOP_REGIME", "skip", `${c.symbol}: chop — no edge.`, { symbol: c.symbol })];
      if (c.regime.regime === "range") return [gate("RANGE_REGIME", "skip", `${c.symbol}: pure range — sitting out.`, { symbol: c.symbol })];
      if (c.regime.setupScore < 0.55) {
        return [gate("LOW_SETUP_SCORE", "skip", `${c.symbol}: setup ${c.regime.setupScore.toFixed(2)} below 0.55.`, { symbol: c.symbol, setupScore: c.regime.setupScore })];
      }
      return [];
    });

    await persistSnapshot(admin, userId, { gateReasons, perSymbol, chosenSymbol: null });

    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "skip",
      title: `Engine tick · all ${SYMBOLS.length} symbols skipped`,
      summary: gateReasons.map((g) => g.message).join(" · "),
      tags: ["multi-symbol", "skip"],
    });
    return { userId, tick: "skipped", reason: "no qualifying setup", gateReasons, expiredCount, perSymbol };
  }


  // Build the context packet for the chosen symbol's AI call
  const contextPacket = {
    market: { symbol: winner.symbol, lastPrice: winner.lastPrice, ...winner.regime },
    otherSymbols: candidates
      .filter((c) => c.symbol !== winner.symbol)
      .map((c) => ({ symbol: c.symbol, regime: c.regime.regime, setupScore: c.regime.setupScore, locked: c.locked ?? null })),
    account: acct ? { equity, floor: Number(acct.balance_floor) } : null,
    guardrails: (rails ?? []).map((g: any) => ({
      label: g.label,
      level: g.level,
      util: Number(g.utilization),
      current: g.current_value,
      limit: g.limit_value,
    })),
    recentDecisions: (recentSignals ?? []).map((s: any) => ({
      symbol: s.symbol,
      side: s.side,
      status: s.status,
      confidence: Number(s.confidence),
      decidedBy: s.decided_by,
      reason: s.decision_reason,
    })),
    patternMemory,
  };

  const aiResult = await decideForSymbol({
    symbol: winner.symbol,
    lastPrice: winner.lastPrice,
    regime: winner.regime,
    contextPacket,
    LOVABLE_API_KEY,
  });

  if ("error" in aiResult) {
    return { userId, tick: "ai_error", symbol: winner.symbol, expiredCount, perSymbol, error: aiResult.error };
  }
  const decision = aiResult.decision;

  if (decision.decision === "skip") {
    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "skip",
      title: `Engine skipped ${winner.symbol} @ $${winner.lastPrice.toFixed(0)} · ${winner.regime.regime}`,
      summary: decision.reasoning ?? "AI chose to skip.",
      tags: [winner.symbol, winner.regime.regime, winner.regime.volatility],
    });
    return { userId, tick: "skipped", symbol: winner.symbol, reasoning: decision.reasoning, expiredCount, perSymbol };
  }

  const sizePct = Math.max(0.05, Math.min(0.25, Number(decision.size_pct ?? 0.15)));
  const sizeUsd = equity * sizePct;
  const entry = Number(decision.proposed_entry ?? winner.lastPrice);
  const side = decision.side ?? "long";
  const stop = Number(decision.proposed_stop ?? (side === "long" ? entry * 0.985 : entry * 1.015));
  const target = Number(decision.proposed_target ?? (side === "long" ? entry * 1.03 : entry * 0.97));
  // TP1 = 1R from entry. If AI didn't supply, derive: midpoint of entry→target.
  const riskPerUnit = Math.abs(entry - stop);
  const tp1 = Number(
    decision.proposed_tp1 ?? (side === "long" ? entry + riskPerUnit : entry - riskPerUnit),
  );
  const conf = Math.max(0, Math.min(1, Number(decision.confidence ?? 0.5)));
  const fullSize = sizeUsd / entry;

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
      context_snapshot: {
        regime: winner.regime,
        lastPrice: winner.lastPrice,
        perSymbol,
        tp1,
        pullback: winner.regime.pullback,
      },
      status: "pending",
    })
    .select()
    .single();

  if (insertErr) {
    console.error("signal insert failed", insertErr);
    return { userId, tick: "insert_error", error: insertErr.message, expiredCount, perSymbol };
  }

  // STAGE 6 — EXECUTE (autonomy-gated)
  const autonomy = sys.autonomy_level ?? "manual";
  const autoApprove = autonomy === "autonomous" || (autonomy === "assisted" && conf >= 0.85);

  if (autoApprove) {
    const tags = ["ai-signal", "auto", winner.regime.regime, winner.symbol];
    if (winner.regime.pullback) tags.push("pullback");
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
        strategy_version: "signal-engine v2 (ladder)",
        reason_tags: tags,
        notes: `Auto-approved (${autonomy}) @ confidence ${(conf * 100).toFixed(0)}%${winner.regime.pullback ? " · pullback entry" : ""}`,
        status: "open",
        outcome: "open",
      })
      .select()
      .single();

    await admin
      .from("trade_signals")
      .update({
        status: "executed",
        decided_by: "auto",
        decision_reason: `Auto-approved (${autonomy}, conf ${(conf * 100).toFixed(0)}%)`,
        decided_at: new Date().toISOString(),
        executed_trade_id: tradeRow?.id ?? null,
      })
      .eq("id", signalRow.id);

    await admin.from("journal_entries").insert({
      user_id: userId,
      kind: "trade",
      title: `Auto-opened ${side.toUpperCase()} ${winner.symbol} @ $${entry.toFixed(2)}`,
      summary: `Autonomy ${autonomy}. Confidence ${(conf * 100).toFixed(0)}%. ${decision.reasoning ?? ""}`,
      tags: ["auto-execute", autonomy, winner.regime.regime, winner.symbol],
    });
  }

  return {
    userId,
    tick: autoApprove ? "executed" : "proposed",
    symbol: winner.symbol,
    signalId: signalRow.id,
    autonomy,
    confidence: conf,
    expiredCount,
    perSymbol,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Detect mode: cron fanout sends { cronAll: true, cronToken: <vault-stored-token> }
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

    // Fetch ALL symbols' candles in parallel — shared across all users this tick.
    const candleResults = await Promise.allSettled(SYMBOLS.map((s) => fetchCandles(s)));
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

      const results: any[] = [];
      for (const u of activeUsers ?? []) {
        try {
          const r = await runTickForUser(admin, u.user_id, candlesBySymbol, LOVABLE_API_KEY);
          results.push(r);
        } catch (e) {
          console.error("user tick failed", u.user_id, e);
          results.push({ userId: u.user_id, tick: "error", error: String(e) });
        }
      }
      return new Response(
        JSON.stringify({ mode: "cron_fanout", users: results.length, symbols: SYMBOLS, results }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
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

    const result = await runTickForUser(admin, userData.user.id, candlesBySymbol, LOVABLE_API_KEY);
    const status = result.tick === "ai_error" ? 500 : 200;
    return new Response(JSON.stringify(result), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("signal-engine error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
