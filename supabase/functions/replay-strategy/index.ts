// ============================================================
// replay-strategy — walk-forward replay over closed trades.
// ------------------------------------------------------------
// Phase 3 honesty tool. Given a strategy_id and a window:
//   1. Pulls all closed trades for that strategy in the window
//   2. Splits chronologically into N folds (default 5)
//   3. For each fold-boundary, computes in-sample vs out-of-sample
//      expectancy, win-rate, Sharpe, max-drawdown
//   4. Also returns a rolling-window curve (default 30-trade window
//      stepped by 5 trades) so the UI can plot edge-stability.
//
// This isn't "replay against historical candles" — we don't store
// raw OHLC. It's the honest replay of REALIZED behavior, which is
// what actually matters: does the edge persist as we move the
// evaluation window forward in time, or does it depend on a single
// hot streak?
//
// Auth: user JWT only. No cron. Read-only — never mutates trades or
// strategies. Rate-limited (5 req/min).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { makeCorsHeaders } from "../_shared/cors.ts";

type Trade = {
  id: string;
  closed_at: string;
  pnl: number | null;
  pnl_pct: number | null;
  outcome: string | null;
};

type Stats = {
  n: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_pnl: number | null;
  avg_pnl_lo: number | null;
  avg_pnl_hi: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  total_pnl: number;
};

function statsFor(trades: Trade[]): Stats {
  const pnls = trades.map((t) => Number(t.pnl ?? 0));
  const n = pnls.length;
  if (n === 0) {
    return {
      n: 0, wins: 0, losses: 0, win_rate: null, avg_pnl: null,
      avg_pnl_lo: null, avg_pnl_hi: null, sharpe: null,
      max_drawdown: null, total_pnl: 0,
    };
  }
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const total = pnls.reduce((a, b) => a + b, 0);
  const mean = total / n;
  const variance = n > 1
    ? pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
    : 0;
  const sd = Math.sqrt(variance);
  const se = n >= 2 ? sd / Math.sqrt(n) : null;

  // Equity curve and max drawdown
  let peak = 0, equity = 0, maxDd = 0;
  for (const p of pnls) {
    equity += p;
    if (equity > peak) peak = equity;
    const dd = equity - peak; // negative
    if (dd < maxDd) maxDd = dd;
  }

  return {
    n,
    wins,
    losses,
    win_rate: wins / n,
    avg_pnl: mean,
    avg_pnl_lo: se != null ? mean - 1.96 * se : null,
    avg_pnl_hi: se != null ? mean + 1.96 * se : null,
    sharpe: sd > 0 ? mean / sd : null,
    max_drawdown: maxDd,
    total_pnl: total,
  };
}

Deno.serve(async (req: Request) => {
  const cors = makeCorsHeaders(req);
  const json = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!bearer) return json({ error: "Unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(bearer);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const rl = await checkRateLimit(admin, userId, "replay-strategy", 5);
    if (!rl.allowed) return rateLimitResponse(rl, cors);

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* allow empty */ }

    const strategyId = typeof body.strategy_id === "string" ? body.strategy_id : null;
    if (!strategyId) return json({ error: "strategy_id required" }, 400);

    const folds = Math.max(2, Math.min(10, Number(body.folds ?? 5)));
    const windowSize = Math.max(10, Math.min(200, Number(body.window_size ?? 30)));
    const windowStep = Math.max(1, Math.min(50, Number(body.window_step ?? 5)));
    const sinceIso = typeof body.since === "string" ? body.since : null;
    const untilIso = typeof body.until === "string" ? body.until : null;

    // Verify strategy belongs to user
    const { data: strat } = await admin
      .from("strategies")
      .select("id, user_id, name, version, status")
      .eq("id", strategyId)
      .maybeSingle();
    if (!strat || (strat as { user_id: string }).user_id !== userId) {
      return json({ error: "Strategy not found" }, 404);
    }

    let q = admin
      .from("trades")
      .select("id, closed_at, pnl, pnl_pct, outcome")
      .eq("user_id", userId)
      .eq("strategy_id", strategyId)
      .eq("status", "closed")
      .order("closed_at", { ascending: true })
      .limit(2000);
    if (sinceIso) q = q.gte("closed_at", sinceIso);
    if (untilIso) q = q.lte("closed_at", untilIso);

    const { data: tradeRows, error: tradeErr } = await q;
    if (tradeErr) return json({ error: tradeErr.message }, 500);

    const trades = ((tradeRows ?? []) as Trade[]).filter((t) => t.closed_at);
    const overall = statsFor(trades);

    if (trades.length < windowSize) {
      return json({
        ok: true,
        strategy: strat,
        overall,
        folds: [],
        rolling: [],
        notice: `Need at least ${windowSize} closed trades for replay; have ${trades.length}.`,
      }, 200);
    }

    // ---- Walk-forward folds ----
    // For each split point i in 1..folds-1, use the first i/folds of the
    // ordered trade stream as in-sample, and the remaining as out-of-sample.
    // Honest edges should look comparable in both halves.
    const foldResults: Array<{
      split_at: string;
      in_sample: Stats;
      out_of_sample: Stats;
      degradation: { avg_pnl: number | null; win_rate: number | null; sharpe: number | null };
    }> = [];

    for (let i = 1; i < folds; i++) {
      const cut = Math.floor((trades.length * i) / folds);
      if (cut < 5 || trades.length - cut < 5) continue;
      const inSample = trades.slice(0, cut);
      const oos = trades.slice(cut);
      const isStats = statsFor(inSample);
      const oosStats = statsFor(oos);
      foldResults.push({
        split_at: trades[cut].closed_at,
        in_sample: isStats,
        out_of_sample: oosStats,
        degradation: {
          avg_pnl: isStats.avg_pnl != null && oosStats.avg_pnl != null
            ? oosStats.avg_pnl - isStats.avg_pnl
            : null,
          win_rate: isStats.win_rate != null && oosStats.win_rate != null
            ? oosStats.win_rate - isStats.win_rate
            : null,
          sharpe: isStats.sharpe != null && oosStats.sharpe != null
            ? oosStats.sharpe - isStats.sharpe
            : null,
        },
      });
    }

    // ---- Rolling window curve ----
    const rolling: Array<{
      window_end: string;
      n: number;
      avg_pnl: number | null;
      win_rate: number | null;
      sharpe: number | null;
      cum_pnl: number;
    }> = [];
    let cum = 0;
    for (let start = 0; start + windowSize <= trades.length; start += windowStep) {
      const slice = trades.slice(start, start + windowSize);
      const s = statsFor(slice);
      cum = trades.slice(0, start + windowSize).reduce((a, t) => a + Number(t.pnl ?? 0), 0);
      rolling.push({
        window_end: slice[slice.length - 1].closed_at,
        n: s.n,
        avg_pnl: s.avg_pnl,
        win_rate: s.win_rate,
        sharpe: s.sharpe,
        cum_pnl: cum,
      });
    }

    // Stability score: fraction of folds where OOS expectancy is within
    // one in-sample standard error of in-sample. Crude but useful.
    let stable = 0, total = 0;
    for (const f of foldResults) {
      if (f.in_sample.avg_pnl == null || f.out_of_sample.avg_pnl == null) continue;
      total++;
      const isSe = (f.in_sample.avg_pnl_hi != null && f.in_sample.avg_pnl_lo != null)
        ? (f.in_sample.avg_pnl_hi - f.in_sample.avg_pnl_lo) / (2 * 1.96)
        : 0;
      if (Math.abs(f.out_of_sample.avg_pnl - f.in_sample.avg_pnl) <= Math.max(isSe, 0.0001)) {
        stable++;
      }
    }
    const stabilityScore = total > 0 ? stable / total : null;

    return json({
      ok: true,
      strategy: strat,
      params: { folds, window_size: windowSize, window_step: windowStep },
      overall,
      folds: foldResults,
      rolling,
      stability_score: stabilityScore,
      verdict: stabilityScore == null
        ? "insufficient_data"
        : stabilityScore >= 0.75
        ? "stable_edge"
        : stabilityScore >= 0.5
        ? "moderate_drift"
        : "unstable_or_overfit",
    }, 200);
  } catch (e) {
    console.error("replay-strategy error", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
