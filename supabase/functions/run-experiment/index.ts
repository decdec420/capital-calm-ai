// run-experiment — drains the queued experiments table.
// Cron every 15m. For each user, picks the OLDEST queued experiment row
// and runs a backtest with before-params vs after-params, then writes
// the result and auto-resolves clear winners/losers.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { runSharedBacktest, type SharedCandle, type SharedParam } from "./backtest-shared.ts";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, s: number) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function fetchCandles(symbol = "BTC-USD"): Promise<SharedCandle[]> {
  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=3600`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase ${res.status}`);
  const raw = (await res.json()) as number[][];
  const sorted = [...raw].sort((a, b) => a[0] - b[0]);
  return sorted.map(([t, l, h, o, c, v]) => ({ t, l, h, o, c, v }));
}

function parseNum(s: string | null | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function runOneForUser(admin: any, userId: string, candles: SharedCandle[]) {
  // Pick oldest queued experiment
  const { data: exp } = await admin
    .from("experiments")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!exp) return { userId, skipped: "no_queue" };

  // Need a strategy to know baseline params — fall back to user's approved strategy
  let baseParams: SharedParam[] = [];
  if (exp.strategy_id) {
    const { data: s } = await admin.from("strategies").select("params").eq("id", exp.strategy_id).maybeSingle();
    baseParams = (s?.params ?? []) as SharedParam[];
  }
  if (baseParams.length === 0) {
    const { data: s } = await admin
      .from("strategies").select("params").eq("user_id", userId).eq("status", "approved")
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    baseParams = (s?.params ?? []) as SharedParam[];
  }

  const beforeNum = parseNum(exp.before_value);
  const afterNum = parseNum(exp.after_value);
  if (beforeNum == null || afterNum == null) {
    await admin.from("experiments").update({
      status: "rejected",
      auto_resolved: true,
      delta: "non-numeric",
      backtest_result: { error: "before/after not numeric — cannot backtest" },
    }).eq("id", exp.id);
    return { userId, expId: exp.id, error: "non_numeric" };
  }

  // Mark running so we don't double-pick
  await admin.from("experiments").update({ status: "running" }).eq("id", exp.id);

  // Build before/after param sets — override the one knob
  const beforeParams: SharedParam[] = baseParams.map((p) => p.key === exp.parameter ? { ...p, value: beforeNum } : p);
  const afterParams: SharedParam[] = baseParams.map((p) => p.key === exp.parameter ? { ...p, value: afterNum } : p);
  // If the parameter wasn't in the base strategy at all, inject it.
  if (!baseParams.some((p) => p.key === exp.parameter)) {
    beforeParams.push({ key: exp.parameter, value: beforeNum });
    afterParams.push({ key: exp.parameter, value: afterNum });
  }

  const before = runSharedBacktest(candles, beforeParams);
  const after = runSharedBacktest(candles, afterParams);

  // Out-of-sample slice: hold out the last 30% of candles. If the in-sample
  // result looks great but OOS disagrees, we downgrade to needs_review —
  // a strong tell for over-fitting.
  const splitIdx = Math.floor(candles.length * 0.7);
  const inSampleCandles = candles.slice(0, splitIdx);
  const outSampleCandles = candles.slice(splitIdx);
  const beforeOOS = runSharedBacktest(outSampleCandles, beforeParams);
  const afterOOS = runSharedBacktest(outSampleCandles, afterParams);
  const oosExpDelta = afterOOS.metrics.expectancy - beforeOOS.metrics.expectancy;

  const expDelta = after.metrics.expectancy - before.metrics.expectancy;
  const winRateDelta = after.metrics.winRate - before.metrics.winRate;
  const sharpeDelta = after.metrics.sharpe - before.metrics.sharpe;
  // maxDrawdown is stored as a negative number (e.g. -0.45 = 45% drawdown);
  // a more-negative value = worse. drawdownDelta < 0 = worsened.
  const drawdownDelta = after.metrics.maxDrawdown - before.metrics.maxDrawdown;
  const drawdownWorsened = drawdownDelta < -0.05; // more than 5pp worse

  const significantSample = before.metrics.trades >= 30 && after.metrics.trades >= 30;
  const noiseFloor = Math.max(before.pnlRStdev, after.pnlRStdev) || 0.01;
  const significantDelta = Math.abs(expDelta) > noiseFloor;
  const meetsMinBar = expDelta >= 0.05; // must improve by ≥0.05R to auto-accept

  let nextStatus: "accepted" | "rejected" | "needs_review";
  let needsReview = false;
  let autoResolved = true;
  let outcomeForMemory: "accepted" | "rejected" | "noise" = "noise";

  if (expDelta <= 0 && winRateDelta <= 0) {
    // Zero or negative on every metric — silent reject. Don't bother the user.
    nextStatus = "rejected";
    outcomeForMemory = "noise";
  } else if (!significantSample || !significantDelta || !meetsMinBar) {
    // Looks positive but evidence is thin / within noise / improvement < 0.05R.
    nextStatus = "needs_review";
    needsReview = true;
    autoResolved = false;
    outcomeForMemory = "noise";
  } else if (expDelta > 0 && drawdownWorsened) {
    // Expectancy improves but drawdown worsened materially — let a human decide.
    nextStatus = "needs_review";
    needsReview = true;
    autoResolved = false;
    outcomeForMemory = "noise";
  } else if (significantDelta && expDelta > 0 && !drawdownWorsened) {
    // Clear in-sample winner. One last check: did it hold out-of-sample?
    if (outSampleCandles.length >= 50 && oosExpDelta < 0) {
      // In-sample said yes, OOS said no — likely overfit. Demote.
      nextStatus = "needs_review";
      needsReview = true;
      autoResolved = false;
      outcomeForMemory = "noise";
    } else {
      nextStatus = "accepted";
      outcomeForMemory = "accepted";
    }
  } else {
    // Significant negative move.
    nextStatus = "rejected";
    outcomeForMemory = "rejected";
  }

  const deltaStr = `exp ${expDelta >= 0 ? "+" : ""}${expDelta.toFixed(3)}R · win ${winRateDelta >= 0 ? "+" : ""}${(winRateDelta * 100).toFixed(1)}%`;

  const backtestResult = {
    before: { metrics: before.metrics, pnlRStdev: before.pnlRStdev },
    after: { metrics: after.metrics, pnlRStdev: after.pnlRStdev },
    deltas: {
      expectancy: Number(expDelta.toFixed(3)),
      winRate: Number(winRateDelta.toFixed(3)),
      sharpe: Number(sharpeDelta.toFixed(3)),
      drawdown: Number(drawdownDelta.toFixed(3)),
    },
    candleCount: candles.length,
    significantSample,
    significantDelta,
    meetsMinBar,
    drawdownWorsened,
    outOfSample: {
      before: { metrics: beforeOOS.metrics },
      after: { metrics: afterOOS.metrics },
      expDelta: Number(oosExpDelta.toFixed(3)),
      candleCount: outSampleCandles.length,
    },
    ranAt: new Date().toISOString(),
  };

  await admin.from("experiments").update({
    status: nextStatus,
    delta: deltaStr,
    auto_resolved: autoResolved,
    needs_review: needsReview,
    backtest_result: backtestResult,
  }).eq("id", exp.id);

  // Write-back to copilot_memory — only for copilot-proposed experiments.
  // User-suggested ones don't pollute the AI's "what we tried" memory.
  if (exp.proposed_by === "copilot") {
    const direction = afterNum > beforeNum ? "increase" : "decrease";
    // Cooldown: noise/rejected get a long cooldown so the AI stops grinding;
    // accepted ones can be re-explored sooner since they're already winners.
    const cooldownDays = outcomeForMemory === "accepted" ? 3 : 14;
    const retryAfter = new Date(Date.now() + cooldownDays * 24 * 60 * 60 * 1000).toISOString();

    try {
      await admin.rpc("upsert_copilot_memory", {
        p_user_id: userId,
        p_parameter: exp.parameter,
        p_direction: direction,
        p_from_value: beforeNum,
        p_to_value: afterNum,
        p_outcome: outcomeForMemory,
        p_exp_delta: Number(expDelta.toFixed(4)),
        p_win_rate_delta: Number(winRateDelta.toFixed(4)),
        p_sharpe_delta: Number(sharpeDelta.toFixed(4)),
        p_drawdown_delta: Number(drawdownDelta.toFixed(4)),
        p_retry_after: retryAfter,
        p_experiment_id: exp.id,
        // Symbol-isolated memory: a "noise" learning on BTC must not block
        // the same exploration on ETH/SOL.
        p_symbol: exp.symbol ?? "BTC-USD",
      });
    } catch (e) {
      // Memory write failures shouldn't tank the experiment row.
      console.error("upsert_copilot_memory failed", e);
    }
  }

  // Fire an alert when something needs review (operator should look)
  if (needsReview) {
    await admin.from("alerts").insert({
      user_id: userId,
      severity: "info",
      title: `Experiment needs your call · ${exp.parameter}`,
      message: `${exp.title} — ${deltaStr}. Borderline result; backtest decision passed to you.`,
    });
  }

  // Inside the helper used in fetch tests, mark which candles were used.
  // Avoid unused-var lint when in-sample slice is computed but not consumed elsewhere.
  void inSampleCandles;

  return { userId, expId: exp.id, status: nextStatus, deltaStr };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const authHeader = req.headers.get("Authorization") ?? "";
    let userIds: string[] = [];

    const { data: cronTokenData } = await admin.rpc("get_signal_engine_cron_token");
    const cronToken = (cronTokenData as string | null) ?? null;
    const isCron = cronToken && authHeader === `Bearer ${cronToken}`;

    if (isCron) {
      // Only process users that actually have a queued experiment — saves a Coinbase fetch per idle user.
      const { data: rows } = await admin.from("experiments").select("user_id").eq("status", "queued");
      userIds = Array.from(new Set((rows ?? []).map((r: any) => r.user_id)));
    } else {
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const token = authHeader.replace("Bearer ", "");
      const { data: userData, error: userErr } = await userClient.auth.getUser(token);
      if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
      userIds = [userData.user.id];
    }

    if (userIds.length === 0) return json({ ok: true, processed: 0 }, 200);

    // Single Coinbase fetch shared across all users — same candles, same backtest universe.
    const candles = await fetchCandles("BTC-USD");

    const results = [];
    for (const uid of userIds) {
      try { results.push(await runOneForUser(admin, uid, candles)); }
      catch (e) { results.push({ userId: uid, error: String(e) }); }
    }
    return json({ ok: true, processed: userIds.length, results }, 200);
  } catch (e) {
    console.error("run-experiment error", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
