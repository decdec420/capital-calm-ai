// ============================================================
// evaluate-candidate — strategy pipeline auto-promotion job
// ------------------------------------------------------------
// Cron every 30 minutes (see migration). For each user with at
// least one candidate strategy, finds the in-testing candidate
// (highest paper-trade count) and either:
//
//   - auto-promotes it to approved (archiving the old approved)
//     when it beats the baseline on expectancy, win rate, sharpe,
//     and drawdown isn't more than 10pp worse;
//   - retires it (archived) and lets the next queued candidate
//     get the testing slot on the next run;
//   - pauses for human review when drawdown got dramatically
//     worse (>20pp) — the one case the system refuses to decide
//     on its own.
//
// Always writes an alert so the operator sees what changed.
// Auth: cron-token via vault, OR a logged-in user can hit it
// directly with their JWT to force-evaluate ("Run check now").
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (b: unknown, s: number) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Tighter thresholds (Apr 2026 audit) — promotions should be rare and earned.
const MIN_TRADES_TO_EVALUATE = 100;
const MIN_EXP_MARGIN = 0.05;        // candidate must beat live by ≥0.05R expectancy
const MIN_WIN_RATE_MARGIN = 0.03;   // …and ≥3pp on win rate
const DRAWDOWN_TOLERANCE_PP = 0.10; // 10 percentage points
const DRAWDOWN_CRITICAL_PP = 0.20;  // 20 pp → ask the human
const COOLDOWN_DAYS = 7;            // lock auto-promotions for 7 days after one runs

type StrategyRow = {
  id: string;
  name: string;
  version: string;
  status: "approved" | "candidate" | "archived";
  metrics: Record<string, number> | null;
  updated_at: string;
};

function metric(s: StrategyRow, key: string): number {
  const v = s.metrics?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

async function createAlert(
  admin: ReturnType<typeof createClient>,
  userId: string,
  severity: "info" | "warning" | "critical",
  title: string,
  message: string,
) {
  await admin.from("alerts").insert({
    user_id: userId,
    severity,
    title,
    message,
  });
}

async function evaluateForUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
  isCron: boolean,
) {
  // Pull approved + all candidates in one round-trip.
  const { data: rows } = await admin
    .from("strategies")
    .select("id,name,version,status,metrics,updated_at")
    .eq("user_id", userId)
    .in("status", ["approved", "candidate"])
    .order("updated_at", { ascending: false });

  const all = (rows ?? []) as StrategyRow[];
  const approved = all.find((s) => s.status === "approved") ?? null;
  const candidates = all.filter((s) => s.status === "candidate");

  if (candidates.length === 0) {
    return { userId, skipped: "no_candidates" };
  }
  if (!approved) {
    // Without a baseline we can't compare — skip silently.
    return { userId, skipped: "no_approved_baseline" };
  }

  // Pick the in-testing candidate: most paper trades, then most-recently updated.
  const inTesting = [...candidates].sort((a, b) => {
    const dt = metric(b, "trades") - metric(a, "trades");
    if (dt !== 0) return dt;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  })[0];

  const trades = metric(inTesting, "trades");
  if (trades < MIN_TRADES_TO_EVALUATE) {
    return {
      userId,
      candidate: inTesting.version,
      skipped: "not_enough_trades",
      trades,
      need: MIN_TRADES_TO_EVALUATE,
    };
  }

  // Compare on the four criteria — now with real margins, not "≥".
  const aExp = metric(approved, "expectancy");
  const cExp = metric(inTesting, "expectancy");
  const aWin = metric(approved, "winRate");
  const cWin = metric(inTesting, "winRate");
  const aDD = metric(approved, "maxDrawdown"); // negative numbers; -0.05 is better than -0.10
  const cDD = metric(inTesting, "maxDrawdown");
  const aSharpe = metric(approved, "sharpe");
  const cSharpe = metric(inTesting, "sharpe");

  const expOk = (cExp - aExp) >= MIN_EXP_MARGIN;
  const winOk = (cWin - aWin) >= MIN_WIN_RATE_MARGIN;
  // Drawdown is stored as a negative fraction. ddDelta > 0 means candidate is BETTER (less negative).
  const ddDelta = cDD - aDD;
  const ddOk = ddDelta >= -DRAWDOWN_TOLERANCE_PP;
  const ddCritical = ddDelta < -DRAWDOWN_CRITICAL_PP;
  const sharpeOk = cSharpe >= aSharpe;
  const allPass = expOk && winOk && ddOk && sharpeOk;

  // Special case: drawdown blew up — pause and ask the human, even if returns improved.
  if (ddCritical) {
    await createAlert(
      admin,
      userId,
      "warning",
      "Candidate needs your call — drawdown concern",
      `${inTesting.version} hit ${trades} trades and looks better on returns, but max drawdown worsened by ${Math.abs(ddDelta * 100).toFixed(1)}pp. Review before promoting.`,
    );
    return { userId, candidate: inTesting.version, paused: "drawdown_critical", trades };
  }

  if (allPass) {
    // Cooldown check (cron only — manual "Run check now" can still promote).
    if (isCron) {
      const { data: state } = await admin
        .from("system_state")
        .select("last_auto_promoted_at")
        .eq("user_id", userId)
        .maybeSingle();
      const last = (state as { last_auto_promoted_at: string | null } | null)?.last_auto_promoted_at;
      if (last) {
        const ageMs = Date.now() - new Date(last).getTime();
        const cooldownMs = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
        if (ageMs < cooldownMs) {
          const daysLeft = Math.ceil((cooldownMs - ageMs) / (24 * 60 * 60 * 1000));
          return {
            userId,
            candidate: inTesting.version,
            skipped: "cooldown",
            trades,
            cooldown_days_remaining: daysLeft,
          };
        }
      }
    }

    // Auto-promote: archive old approved, candidate becomes approved.
    await admin.from("strategies").update({ status: "archived" }).eq("id", approved.id);
    await admin.from("strategies").update({ status: "approved" }).eq("id", inTesting.id);
    await admin
      .from("system_state")
      .update({ last_auto_promoted_at: new Date().toISOString() })
      .eq("user_id", userId);

    await createAlert(
      admin,
      userId,
      "info",
      `🚀 Strategy auto-promoted to ${inTesting.version}`,
      `Expectancy ${aExp.toFixed(2)}R → ${cExp.toFixed(2)}R · Win rate ${(aWin * 100).toFixed(0)}% → ${(cWin * 100).toFixed(0)}% · Sharpe ${aSharpe.toFixed(2)} → ${cSharpe.toFixed(2)} after ${trades} paper trades. Auto-promotions paused for ${COOLDOWN_DAYS} days.`,
    );
    return { userId, promoted: inTesting.version, trades };
  }

  // Failed criteria → retire this candidate. Next queued one will inherit the slot on the next run.
  await admin.from("strategies").update({ status: "archived" }).eq("id", inTesting.id);

  const failReasons = [
    !expOk && `expectancy gap too small (${cExp.toFixed(2)}R vs ${aExp.toFixed(2)}R, need +${MIN_EXP_MARGIN.toFixed(2)}R)`,
    !winOk && `win rate gap too small (${(cWin * 100).toFixed(0)}% vs ${(aWin * 100).toFixed(0)}%, need +${(MIN_WIN_RATE_MARGIN * 100).toFixed(0)}pp)`,
    !ddOk && `drawdown worsened by ${Math.abs(ddDelta * 100).toFixed(1)}pp`,
    !sharpeOk && `sharpe (${cSharpe.toFixed(2)} vs ${aSharpe.toFixed(2)})`,
  ].filter(Boolean).join(", ");

  // Look ahead: is there another candidate waiting?
  const remaining = candidates.filter((c) => c.id !== inTesting.id);
  if (remaining.length === 0) {
    await createAlert(
      admin,
      userId,
      "info",
      `Candidate ${inTesting.version} retired · pipeline empty`,
      `Didn't beat the baseline after ${trades} trades. Failed on: ${failReasons}. Head to Learning to promote a new experiment.`,
    );
  } else {
    await createAlert(
      admin,
      userId,
      "info",
      `Candidate ${inTesting.version} retired`,
      `Didn't beat the baseline after ${trades} trades. Failed on: ${failReasons}. Next candidate is now in testing.`,
    );
  }

  return { userId, retired: inTesting.version, trades, failReasons };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

    // Check cron token first; fall back to authenticated-user evaluation.
    let isCron = false;
    try {
      const { data: tok } = await admin.rpc("get_evaluate_candidate_cron_token");
      if (tok && tok === bearer) isCron = true;
    } catch {
      /* RPC missing — only user-auth path remains. */
    }
    if (!isCron && bearer === SERVICE_KEY) isCron = true;

    let userIds: string[] = [];

    if (isCron) {
      // Only process users that actually own at least one candidate strategy.
      const { data: rows } = await admin
        .from("strategies")
        .select("user_id")
        .eq("status", "candidate");
      userIds = Array.from(new Set((rows ?? []).map((r: { user_id: string }) => r.user_id)));
    } else {
      // Manual trigger from the Strategy Lab UI — single-user path.
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser(bearer);
      if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
      userIds = [userData.user.id];
    }

    if (userIds.length === 0) {
      return json({ ok: true, processed: 0, results: [] }, 200);
    }

    const results: unknown[] = [];
    for (const uid of userIds) {
      try {
        results.push(await evaluateForUser(admin, uid));
      } catch (e) {
        results.push({ userId: uid, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return json({ ok: true, processed: userIds.length, results }, 200);
  } catch (e) {
    console.error("evaluate-candidate error", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
