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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

    // Trigger-only entrypoint. Validate via vault-stored token, with the
    // service role key as a fallback for manual testing.
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    let tokenOk = false;
    if (bearer && bearer === SERVICE_KEY) {
      tokenOk = true;
    } else {
      try {
        const { data: tok } = await admin.rpc("get_post_trade_learn_token");
        if (tok && tok === bearer) tokenOk = true;
      } catch {
        // RPC missing — only service-role fallback works.
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
