// run-experiment — drains the queued experiments table.
// Cron every 15m. For each user, picks the OLDEST queued experiment row
// and runs a backtest with before-params vs after-params, then writes
// the result and auto-resolves clear winners/losers.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { runSharedBacktest, type SharedCandle, type SharedParam } from "./backtest-shared.ts";

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

  const expDelta = after.metrics.expectancy - before.metrics.expectancy;
  const winRateDelta = after.metrics.winRate - before.metrics.winRate;
  // Significance: need ≥30 trades on each side AND |delta| > 1 stdev of pnlR
  const significantSample = before.metrics.trades >= 30 && after.metrics.trades >= 30;
  const noiseFloor = Math.max(before.pnlRStdev, after.pnlRStdev) || 0.01;
  const significantDelta = Math.abs(expDelta) > noiseFloor;

  let nextStatus: "accepted" | "rejected" | "needs_review";
  let needsReview = false;
  let autoResolved = true;
  if (!significantSample) {
    nextStatus = "needs_review";
    needsReview = true;
    autoResolved = false;
  } else if (significantDelta && expDelta > 0) {
    nextStatus = "accepted";
  } else if (significantDelta && expDelta < 0) {
    nextStatus = "rejected";
  } else {
    nextStatus = "needs_review";
    needsReview = true;
    autoResolved = false;
  }

  const deltaStr = `exp ${expDelta >= 0 ? "+" : ""}${expDelta.toFixed(3)}R · win ${winRateDelta >= 0 ? "+" : ""}${(winRateDelta * 100).toFixed(1)}%`;

  const backtestResult = {
    before: { metrics: before.metrics, pnlRStdev: before.pnlRStdev },
    after: { metrics: after.metrics, pnlRStdev: after.pnlRStdev },
    deltas: { expectancy: Number(expDelta.toFixed(3)), winRate: Number(winRateDelta.toFixed(3)) },
    candleCount: candles.length,
    significantSample,
    significantDelta,
    ranAt: new Date().toISOString(),
  };

  await admin.from("experiments").update({
    status: nextStatus,
    delta: deltaStr,
    auto_resolved: autoResolved,
    needs_review: needsReview,
    backtest_result: backtestResult,
  }).eq("id", exp.id);

  // Fire an alert when something needs review (operator should look)
  if (needsReview) {
    await admin.from("alerts").insert({
      user_id: userId,
      severity: "info",
      title: `Experiment needs your call · ${exp.parameter}`,
      message: `${exp.title} — ${deltaStr}. Borderline result; backtest decision passed to you.`,
    });
  }

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
