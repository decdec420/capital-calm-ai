import { corsHeaders } from "../_shared/cors.ts";
// ============================================================
// post-trade-learn — automatic per-trade learning artifact
// ------------------------------------------------------------
// Triggered by the database AFTER a row in `trades` transitions
// from any non-closed status into `closed`. The trigger calls this
// function via pg_net with `{ trade_id: <uuid> }`.
//
// What this writes:
//   1. A `journal_entries` row of kind = 'post_trade' for the user.
//      Contains the structured outcome (win/loss/breakeven), what
//      worked, what didn't, and the calibration delta between the
//      AI's pre-trade confidence and the realized outcome.
//   2. A rolling per-strategy stats refresh on `strategies.metrics`:
//      last-20-trade win rate, expectancy, average calibration error.
//      (Read-only consumers — Strategy Lab — pick this up immediately.)
//
// Non-goals (explicitly):
//   - No auto-promotion. Humans / existing experiment flow decide.
//   - No LLM call here. We extract structured signal cheaply and let
//     a separate weekly-review function (future) do narrative analysis.
// ============================================================


// Trade Coach uses Sonnet — grades entries A-D and writes actionable lessons.
// Runs at most 2×/day (daily trade cap). Quality of feedback matters here.
const TRADE_COACH_MODEL = "anthropic/claude-sonnet-4-6";

interface TradeRow {
  id: string;
  user_id: string;
  symbol: string;
  side: "long" | "short";
  entry_price: number;
  exit_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  outcome: string | null;
  reason_tags: string[] | null;
  notes: string | null;
  opened_at: string;
  closed_at: string | null;
  strategy_id: string | null;
  strategy_version: string | null;
  horizon: string | null;
  tp1_filled: boolean | null;
  tp2_filled: boolean | null;
  tp3_filled: boolean | null;
  scale_ins: unknown[] | null;
}

interface SignalRow {
  confidence: number | null;
  setup_score: number | null;
  regime: string | null;
  ai_reasoning: string | null;
  ai_model: string | null;
  proposed_entry: number | null;
  proposed_stop: number | null;
  proposed_target: number | null;
}

function classifyOutcome(pnl: number | null): "win" | "loss" | "breakeven" {
  if (pnl == null) return "breakeven";
  if (pnl > 0.0001) return "win";
  if (pnl < -0.0001) return "loss";
  return "breakeven";
}

function inferWhatWorked(t: TradeRow, sig: SignalRow | null): string[] {
  const notes: string[] = [];
  if (t.tp1_filled) notes.push("TP1 reached — partial booked");
  if (t.tp2_filled) notes.push("TP2 reached — runner ran");
  if (t.tp3_filled) notes.push("TP3 reached — full target hit");
  if ((t.pnl ?? 0) > 0 && sig?.confidence && sig.confidence > 0.75) {
    notes.push(
      `High pre-trade confidence (${(sig.confidence * 100).toFixed(0)}%) was justified`,
    );
  }
  if ((t.scale_ins?.length ?? 0) > 0 && (t.pnl ?? 0) > 0) {
    notes.push(`Scale-in on dip improved blended entry`);
  }
  return notes;
}

function inferWhatDidnt(t: TradeRow, sig: SignalRow | null): string[] {
  const notes: string[] = [];
  if (t.outcome === "loss" && t.exit_price === t.stop_loss) {
    notes.push("Hit stop without ever reaching TP1");
  }
  if ((t.pnl ?? 0) < 0 && sig?.confidence && sig.confidence > 0.75) {
    notes.push(
      `High confidence (${(sig.confidence * 100).toFixed(0)}%) but loss — calibration miss`,
    );
  }
  if ((t.scale_ins?.length ?? 0) > 0 && (t.pnl ?? 0) < 0) {
    notes.push(
      `Scaled in on dip, then continued lower — averaging-down warning`,
    );
  }
  if (t.horizon === "position" && t.outcome === "loss") {
    notes.push("Position-horizon trade with wider stop — review setup quality");
  }
  return notes;
}

// Calibration delta: signed difference between predicted P(win) and
// realized outcome (1 = win, 0 = loss). Positive = overconfident, negative
// = underconfident. Aggregating this over time gives a calibration curve.
function calibrationDelta(
  outcome: "win" | "loss" | "breakeven",
  confidence: number | null,
): number | null {
  if (confidence == null) return null;
  if (outcome === "breakeven") return null;
  const realized = outcome === "win" ? 1 : 0;
  return Number((confidence - realized).toFixed(4));
}

async function refreshStrategyMetrics(
  // deno-lint-ignore no-explicit-any
  admin: any,
  strategyId: string,
  userId: string,
) {
  // Pull last 20 closed trades for this strategy.
  const { data: trades, error } = await admin
    .from("trades")
    .select("pnl, pnl_pct, outcome, closed_at")
    .eq("user_id", userId)
    .eq("strategy_id", strategyId)
    .eq("status", "closed")
    .order("closed_at", { ascending: false })
    .limit(20);
  if (error || !trades || trades.length === 0) return;

  const wins = trades.filter((t: { outcome: string | null }) => t.outcome === "win").length;
  const losses = trades.filter((t: { outcome: string | null }) => t.outcome === "loss").length;
  const total = trades.length;
  const winRate = total > 0 ? wins / total : 0;

  const winPnls = trades
    .filter((t: { pnl: number | null }) => (t.pnl ?? 0) > 0)
    .map((t: { pnl: number | null }) => Number(t.pnl ?? 0));
  const lossPnls = trades
    .filter((t: { pnl: number | null }) => (t.pnl ?? 0) < 0)
    .map((t: { pnl: number | null }) => Math.abs(Number(t.pnl ?? 0)));

  const avgWin = winPnls.length
    ? winPnls.reduce((a: number, b: number) => a + b, 0) / winPnls.length
    : 0;
  const avgLoss = lossPnls.length
    ? lossPnls.reduce((a: number, b: number) => a + b, 0) / lossPnls.length
    : 0;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  // Read existing strategy.metrics so we preserve other keys.
  const { data: strat } = await admin
    .from("strategies")
    .select("metrics")
    .eq("id", strategyId)
    .maybeSingle();
  const existing = (strat?.metrics ?? {}) as Record<string, unknown>;

  await admin
    .from("strategies")
    .update({
      metrics: {
        ...existing,
        rollingWindow: total,
        rollingWinRate: Number(winRate.toFixed(4)),
        rollingExpectancy: Number(expectancy.toFixed(4)),
        rollingAvgWin: Number(avgWin.toFixed(4)),
        rollingAvgLoss: Number(avgLoss.toFixed(4)),
        rollingWins: wins,
        rollingLosses: losses,
        rollingUpdatedAt: new Date().toISOString(),
      },
    })
    .eq("id", strategyId);
}

// ============================================================
// Wendy Rhoades — Performance Coach. The fourth expert on the desk.
// Reviews each closed trade with the full Brain Trust context
// active at entry, grades process (not outcome), produces a
// 1-2 sentence lesson, and optionally queues an experiment.
//
// Wendy doesn't trade. Wendy watches HOW the desk trades and
// optimizes the decision-making process behind every entry.
// ============================================================
const TRADE_COACH_SYSTEM = `
You are Wendy Rhoades — performance coach at Axe Capital.

Your job: after every trade closes, review it with the full context
of WHY it was entered, HOW it behaved, and WHAT it reveals about the
decision-making process. You are not a quant. You are not a strategist.
You read behavior — and behavior is what determines long-run edge.

You are not a cheerleader. A winning trade can be a bad trade (lucky execution, flawed process).
A losing trade can be a good trade (right process, bad outcome — it happens).
You evaluate PROCESS and DECISION QUALITY, not P&L.

You think like the greatest performance coaches and trading mentors:
- Ed Seykota: discipline of the system matters more than any single trade.
- Mark Douglas: evaluate whether entry criteria were met, not whether we won.
- Van Tharp: what belief generated this trade? Was the belief correct?
- Linda Raschke: a well-managed loss taken cleanly is a victory for the system.
- Wendy Rhoades: performance is a function of clarity, not courage. Identify the pattern.

YOUR FRAMEWORK:
1. ENTRY QUALITY: macro alignment, environment rating, key-level vs open space,
   pullback vs breakout, R/R ratio at entry. Was the setup there?
2. TRADE BEHAVIOR: immediate move vs chop, wick stops, exit timing. How did price act?
3. REGIME/CONTEXT ACCURACY: did regime + macro bias prove correct? What was the miss?
4. BEHAVIORAL PATTERN: does this trade reveal a recurring tendency? (e.g. entering too early
   in distribution, holding past R/R, adding to losing positions)
5. SYSTEM HYPOTHESIS: one testable hypothesis this single trade generates (data point,
   not conclusion).
6. LESSON: 1-2 sentences, plain English, specific to THIS trade. Wendy is direct.

Be specific about prices, percentages, and timeframes.
Do not write generic advice. Write analysis of THIS specific trade and what it reveals
about the system's decision-making process.
`.trim();

// deno-lint-ignore no-explicit-any
async function runTradeCoach(
  // deno-lint-ignore no-explicit-any
  admin: any,
  t: TradeRow,
  sig: SignalRow | null,
  outcome: "win" | "loss" | "breakeven",
  apiKey: string,
): Promise<void> {
  // Idempotency — only one coach entry per trade.
  const { data: existingCoach } = await admin
    .from("journal_entries")
    .select("id")
    .eq("user_id", t.user_id)
    .eq("kind", "learning")
    .filter("raw->>tradeId", "eq", t.id)
    .filter("raw->>source", "eq", "trade-coach")
    .maybeSingle();
  if (existingCoach) return;

  // Brain Trust brief at signal-creation time.
  // Prefer the snapshot baked into context_snapshot.brainTrustSnapshot (written
  // by signal-engine at the moment the signal was proposed). Fall back to the
  // current live market_intelligence row only when the snapshot is absent
  // (legacy signals created before this fix was deployed).
  // deno-lint-ignore no-explicit-any
  const ctxBrainTrust = (sig as any)?.context_snapshot?.brainTrustSnapshot ?? null;
  // deno-lint-ignore no-explicit-any
  let intel: any = ctxBrainTrust;
  if (!intel) {
    const { data: liveIntel } = await admin
      .from("market_intelligence")
      .select("*")
      .eq("user_id", t.user_id)
      .eq("symbol", t.symbol)
      .maybeSingle();
    intel = liveIntel; // fallback for legacy trades
  }

  const entryPrice = Number(t.entry_price);
  const exitPrice = Number(t.exit_price ?? 0);
  const stopLoss = Number(t.stop_loss ?? 0);
  const takeProfit = Number(t.take_profit ?? 0);
  const pnlPct = Number(t.pnl_pct ?? 0);
  const entryTime = new Date(t.opened_at);
  const exitTime = new Date(t.closed_at ?? new Date());
  const durationHours = (exitTime.getTime() - entryTime.getTime()) / 3_600_000;
  const riskPct = entryPrice > 0 && stopLoss > 0
    ? (Math.abs(entryPrice - stopLoss) / entryPrice) * 100
    : 0;
  const rewardPct = entryPrice > 0 && takeProfit > 0
    ? (Math.abs(takeProfit - entryPrice) / entryPrice) * 100
    : 0;
  const rrAtEntry = riskPct > 0 ? rewardPct / riskPct : 0;

  // deno-lint-ignore no-explicit-any
  const ctxSnapshot = (sig as any)?.context_snapshot ?? null;
  const riskVerdict = ctxSnapshot?.riskManagerVerdict
    ? JSON.stringify(ctxSnapshot.riskManagerVerdict)
    : "not available";

  const tradeContext = `
TRADE SUMMARY:
- Symbol: ${t.symbol}
- Direction: ${t.side?.toUpperCase()}
- Entry: $${entryPrice.toFixed(2)} at ${entryTime.toISOString()}
- Exit: $${exitPrice.toFixed(2)} at ${exitTime.toISOString()}
- Duration: ${durationHours.toFixed(1)} hours
- Stop loss: $${stopLoss.toFixed(2)} (${riskPct.toFixed(2)}% from entry)
- Take profit: $${takeProfit.toFixed(2)} (${rewardPct.toFixed(2)}% from entry)
- R/R at entry: ${rrAtEntry.toFixed(2)}:1
- Outcome: ${outcome.toUpperCase()} | PnL: ${pnlPct.toFixed(2)}%
- How it exited: ${t.notes ?? "unknown"}
- Tags: ${(t.reason_tags ?? []).join(", ")}

ENTRY CONTEXT (signal engine):
- AI confidence: ${((Number(sig?.confidence ?? 0)) * 100).toFixed(0)}%
- Setup score: ${sig?.setup_score?.toFixed?.(2) ?? "unknown"}
- Regime at entry: ${sig?.regime ?? "unknown"}
- AI reasoning: "${sig?.ai_reasoning ?? "not available"}"
- Risk manager verdict: ${riskVerdict}

BRAIN TRUST CONTEXT (snapshotted at signal creation — entry-time market conditions):
- Macro bias: ${intel?.macro_bias ?? "unknown"} (confidence: ${((Number(intel?.macro_confidence ?? 0)) * 100).toFixed(0)}%)
- Market phase: ${intel?.market_phase ?? "unknown"}
- Trend structure: ${intel?.trend_structure ?? "unknown"}
- Environment rating: ${intel?.environment_rating ?? "unknown"}
- Funding rate signal: ${intel?.funding_rate_signal ?? "unknown"}
- Fear/Greed: ${intel?.fear_greed_score ?? "unknown"} (${intel?.fear_greed_label ?? "unknown"})
- Pattern context: "${intel?.pattern_context ?? "not available"}"
- Entry quality context: "${intel?.entry_quality_context ?? "not available"}"
- Macro summary: "${intel?.macro_summary ?? "not available"}"
`.trim();

  const aiResp = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TRADE_COACH_MODEL,
        messages: [
          { role: "system", content: TRADE_COACH_SYSTEM },
          {
            role: "user",
            content: `Analyze this closed trade and extract lessons:\n\n${tradeContext}`,
          },
        ],
        tools: [{
          type: "function",
          function: {
            name: "submit_trade_analysis",
            parameters: {
              type: "object",
              required: [
                "entry_quality_grade",
                "process_verdict",
                "lesson",
                "experiment_hypothesis",
              ],
              additionalProperties: false,
              properties: {
                entry_quality_grade: {
                  type: "string",
                  enum: ["A", "B", "C", "D"],
                  description:
                    "Grade entry quality on PROCESS not outcome. A=textbook, D=should not have entered.",
                },
                process_verdict: {
                  type: "string",
                  enum: [
                    "good_process_good_outcome",
                    "good_process_bad_outcome",
                    "bad_process_good_outcome",
                    "bad_process_bad_outcome",
                  ],
                },
                macro_alignment: {
                  type: "string",
                  enum: ["well_aligned", "neutral", "fighting_macro"],
                },
                environment_fit: {
                  type: "string",
                  enum: ["excellent", "good", "poor"],
                },
                lesson: {
                  type: "string",
                  description:
                    "1-2 sentences. Specific actionable lesson from THIS trade. Not generic.",
                },
                experiment_hypothesis: {
                  type: "string",
                  description:
                    "Parameter/rule change to test, or 'null' if none.",
                },
                experiment_parameter: {
                  type: "string",
                  description:
                    "One of: ema_fast, ema_slow, rsi_period, stop_atr_mult, tp_r_mult, max_order_pct. Or 'null'.",
                },
              },
            },
          },
        }],
        tool_choice: {
          type: "function",
          function: { name: "submit_trade_analysis" },
        },
      }),
    },
  );

  if (!aiResp.ok) {
    console.error("trade coach AI error", aiResp.status, await aiResp.text());
    return;
  }
  const aiJson = await aiResp.json();
  const args =
    aiJson.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return;
  // deno-lint-ignore no-explicit-any
  let analysis: any;
  try {
    analysis = JSON.parse(args);
  } catch {
    return;
  }

  const grade = String(analysis.entry_quality_grade ?? "C");
  const verdict = String(analysis.process_verdict ?? "");
  const macroAlign = String(analysis.macro_alignment ?? "neutral");
  const lesson = String(analysis.lesson ?? "").trim();
  const hyp = String(analysis.experiment_hypothesis ?? "").trim();
  const param = String(analysis.experiment_parameter ?? "").trim();
  const hasHypothesis = hyp && hyp.toLowerCase() !== "null" && param &&
    param.toLowerCase() !== "null";

  // Maybe queue an experiment from the lesson — close the loop.
  let queuedExperimentId: string | null = null;
  if (hasHypothesis) {
    const { data: strategy } = await admin
      .from("strategies")
      .select("id,params")
      .eq("user_id", t.user_id)
      .eq("status", "approved")
      .maybeSingle();
    if (strategy) {
      const params = (strategy.params ?? []) as Array<
        { key: string; value: unknown }
      >;
      const currentParam = params.find((p) => p.key === param);
      if (currentParam && typeof currentParam.value === "number") {
        const lower = hyp.toLowerCase();
        const direction =
          lower.includes("wider") || lower.includes("larger") ||
            lower.includes("increase") || lower.includes("raise")
            ? 1
            : -1;
        const proposedValue = Number(
          (Number(currentParam.value) * (1 + direction * 0.2)).toFixed(3),
        );
        const { data: exp } = await admin.from("experiments").insert({
          user_id: t.user_id,
          title:
            `Coach suggestion: adjust ${param} after ${t.symbol} trade`,
          parameter: param,
          before_value: String(currentParam.value),
          after_value: String(proposedValue),
          delta: `${
            ((proposedValue - Number(currentParam.value)) /
              Number(currentParam.value) *
              100).toFixed(0)
          }%`,
          hypothesis: hyp,
          symbol: t.symbol,
          status: "queued",
          proposed_by: "coach",
          strategy_id: strategy.id,
        }).select("id").maybeSingle();
        queuedExperimentId = exp?.id ?? null;
      }
    }
  }

  const tags = Array.from(
    new Set([
      "trade-coach",
      t.symbol,
      outcome,
      `grade_${grade.toLowerCase()}`,
      verdict,
      macroAlign,
      ...(queuedExperimentId ? ["experiment-queued"] : []),
    ].filter(Boolean) as string[]),
  );

  await admin.from("journal_entries").insert({
    user_id: t.user_id,
    kind: "learning",
    title:
      `🎓 Coach: ${t.symbol} ${t.side.toUpperCase()} — grade ${grade}, ${
        verdict.replace(/_/g, " ")
      }`,
    summary: lesson,
    tags,
    source: "trade-coach",
    raw: {
      tradeId: t.id,
      source: "trade-coach",
      aiModel: TRADE_COACH_MODEL,
      grade,
      processVerdict: verdict,
      macroAlignment: macroAlign,
      environmentFit: analysis.environment_fit ?? null,
      lesson,
      experimentHypothesis: hasHypothesis ? hyp : null,
      experimentParameter: hasHypothesis ? param : null,
      experimentId: queuedExperimentId,
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.45.0"
    );
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const tradeId = body?.trade_id as string | undefined;
    if (!tradeId) {
      return new Response(
        JSON.stringify({ error: "Missing trade_id" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Trigger-only entrypoint. Requires vault-stored internal token.
    // The service role key must NEVER be accepted as an HTTP bearer — leaking
    // one token would give full DB admin rights. Use INTERNAL_FUNCTION_SECRET
    // or the get_post_trade_learn_token vault RPC for internal calls.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    let tokenOk = false;
    // Check internal function secret first (env-var based internal calls)
    const internalSecret = Deno.env.get("INTERNAL_FUNCTION_SECRET");
    if (internalSecret && bearer === internalSecret) {
      tokenOk = true;
    } else {
      try {
        const { data: tok } = await admin.rpc("get_post_trade_learn_token");
        if (tok && bearer && tok === bearer) tokenOk = true;
      } catch {
        // RPC missing — deny access (fail closed).
      }
    }
    if (!tokenOk) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: trade, error: tradeErr } = await admin
      .from("trades")
      .select("*")
      .eq("id", tradeId)
      .maybeSingle();
    if (tradeErr || !trade) {
      return new Response(
        JSON.stringify({ error: "Trade not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const t = trade as TradeRow;

    // Find the originating signal (if any).
    const { data: sigRow } = await admin
      .from("trade_signals")
      .select(
        "confidence, setup_score, regime, ai_reasoning, ai_model, proposed_entry, proposed_stop, proposed_target",
      )
      .eq("executed_trade_id", t.id)
      .maybeSingle();
    const sig = (sigRow ?? null) as SignalRow | null;

    const outcome = classifyOutcome(t.pnl);
    const whatWorked = inferWhatWorked(t, sig);
    const whatDidnt = inferWhatDidnt(t, sig);
    const calDelta = calibrationDelta(outcome, sig?.confidence ?? null);

    const pnlText = t.pnl == null
      ? "0.00"
      : t.pnl >= 0
        ? `+$${t.pnl.toFixed(4)}`
        : `-$${Math.abs(t.pnl).toFixed(4)}`;

    const summaryLines: string[] = [];
    summaryLines.push(
      `${t.side.toUpperCase()} ${t.symbol} closed ${outcome} ${pnlText}` +
        (t.pnl_pct != null ? ` (${t.pnl_pct.toFixed(2)}%)` : ""),
    );
    if (sig) {
      summaryLines.push(
        `Pre-trade: regime=${sig.regime ?? "?"}, setup=${sig.setup_score ?? "?"}, conf=${sig.confidence != null ? (sig.confidence * 100).toFixed(0) + "%" : "?"}.`,
      );
    }
    if (whatWorked.length > 0) {
      summaryLines.push("What worked: " + whatWorked.join("; "));
    }
    if (whatDidnt.length > 0) {
      summaryLines.push("What didn't: " + whatDidnt.join("; "));
    }
    if (calDelta != null) {
      summaryLines.push(
        `Calibration: ${calDelta > 0 ? "overconfident" : "underconfident"} by ${Math.abs(calDelta).toFixed(2)}.`,
      );
    }

    const tags = Array.from(
      new Set(
        [
          "post_trade",
          outcome,
          t.symbol,
          t.horizon ?? "swing",
          ...(t.reason_tags ?? []),
        ].filter(Boolean) as string[],
      ),
    );

    const raw = {
      tradeId: t.id,
      symbol: t.symbol,
      side: t.side,
      entry: t.entry_price,
      exit: t.exit_price,
      stop: t.stop_loss,
      target: t.take_profit,
      pnl: t.pnl,
      pnlPct: t.pnl_pct,
      outcome,
      strategyId: t.strategy_id,
      strategyVersion: t.strategy_version,
      horizon: t.horizon,
      openedAt: t.opened_at,
      closedAt: t.closed_at,
      preTrade: sig
        ? {
          confidence: sig.confidence,
          setupScore: sig.setup_score,
          regime: sig.regime,
          aiModel: sig.ai_model,
          aiReasoning: sig.ai_reasoning,
        }
        : null,
      whatWorked,
      whatDidnt,
      calibrationDelta: calDelta,
    };

    // Idempotency: if we already journaled this trade, skip.
    const { data: existing } = await admin
      .from("journal_entries")
      .select("id")
      .eq("user_id", t.user_id)
      .eq("kind", "post_trade")
      .filter("raw->>tradeId", "eq", t.id)
      .maybeSingle();
    if (existing) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "already journaled", entry: existing.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: entry, error: insErr } = await admin
      .from("journal_entries")
      .insert({
        user_id: t.user_id,
        kind: "post_trade",
        title: `${t.symbol} ${outcome} · ${pnlText}`,
        summary: summaryLines.join(" "),
        tags,
        source: "post-trade-learn",
        raw,
      })
      .select("id")
      .single();

    if (insErr) {
      console.error("journal insert failed", insErr);
      return new Response(
        JSON.stringify({ error: "Journal insert failed", detail: insErr.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Refresh rolling metrics on the strategy if we know which one.
    if (t.strategy_id) {
      try {
        await refreshStrategyMetrics(admin, t.strategy_id, t.user_id);
      } catch (e) {
        console.error("rolling metric refresh failed", e);
      }
    }

    // Trade Coach — additive AI-powered post-trade lesson + experiment hypothesis.
    // Best-effort: never block the journal write or fail the function on coach errors.
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (LOVABLE_API_KEY) {
      try {
        await runTradeCoach(admin, t, sig, outcome, LOVABLE_API_KEY);
      } catch (e) {
        console.error("trade coach failed (non-fatal):", e);
      }
    }

    // Trade-milestone trigger for Katrina (strategy review agent).
    // Every 10th closed trade for this user fires Katrina for that user only.
    // Fire-and-forget — never block the post-trade response.
    try {
      const { count } = await admin
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", t.user_id)
        .eq("status", "closed");
      if (count && count > 0 && count % 10 === 0) {
        console.log(`[post-trade-learn] milestone ${count} closed trades — triggering katrina for user ${t.user_id}`);
        const internalSecret = Deno.env.get("INTERNAL_FUNCTION_SECRET") ?? "";
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
          Deno.env.get("SERVICE_KEY") ??
          "";
        if (!internalSecret) {
          console.warn("[post-trade-learn] INTERNAL_FUNCTION_SECRET missing; skipping Katrina milestone trigger");
        } else if (!serviceRoleKey) {
          console.warn(
            "[post-trade-learn] SUPABASE_SERVICE_ROLE_KEY/SERVICE_KEY missing; skipping Katrina milestone trigger",
          );
        } else {
          fetch(`${SUPABASE_URL}/functions/v1/katrina`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              // Supabase function gateway expects a JWT unless verify_jwt = false.
              // Use service-role JWT for gateway auth and pass the internal shared
              // secret separately for Katrina's internal dispatch path.
              Authorization: `Bearer ${serviceRoleKey}`,
              "x-internal-function-secret": internalSecret,
            },
            body: JSON.stringify({ trigger: "trade_milestone", user_id: t.user_id }),
          }).catch((err) => console.error("[post-trade-learn] katrina dispatch failed (non-fatal):", err));
        }
      }
    } catch (e) {
      console.error("[post-trade-learn] milestone check failed (non-fatal):", e);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        tradeId: t.id,
        entryId: entry.id,
        outcome,
        calibrationDelta: calDelta,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("post-trade-learn error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
