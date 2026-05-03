// ============================================================
// evaluate-candidate — strategy pipeline auto-promotion job
// ------------------------------------------------------------
// Cron every 30 minutes. For each user with at least one
// candidate strategy, this evaluates EVERY candidate (parallel
// paper testing) and produces one of these outcomes per candidate:
//
//   - promoted   → candidate beats live by clear margins; archive
//                  old approved, candidate becomes approved.
//                  Only ONE promotion per cron run per user; if
//                  multiple pass, the largest expectancy margin wins.
//   - retired    → reached ≥ MIN_TRADES and lost on at least one
//                  bar (expectancy / win rate / sharpe / drawdown).
//   - paused     → drawdown blew up by >20pp; needs a human call.
//   - skipped    → not enough trades yet, or in cooldown window.
//
// Paper mode (flood gates): lower trade minimum + shorter cooldown
// so the system learns faster. Live mode keeps full safety bars.
//
//   Paper:  MIN_TRADES = 30,  COOLDOWN_DAYS = 1
//   Live:   MIN_TRADES = 100, COOLDOWN_DAYS = 7
//
// A user-wide cooldown applies to auto-promotions only;
// "Run check now" from the UI bypasses the cooldown.
//
// Always stamps `system_state.last_evaluated_at` so the UI can
// show "last check: N min ago".
//
// Auth: cron-token via vault, OR a logged-in user can hit it
// directly with their JWT to force-evaluate ("Run check now").
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { corsHeaders, makeCorsHeaders} from "../_shared/cors.ts";


const MIN_EXP_MARGIN = 0.05;
const MIN_WIN_RATE_MARGIN = 0.03;
const DRAWDOWN_TOLERANCE_PP = 0.10;
const DRAWDOWN_CRITICAL_PP = 0.20;
const COOLDOWN_DAYS = 7;

type StrategyRow = {
  id: string;
  name: string;
  version: string;
  status: "approved" | "candidate" | "archived";
  metrics: Record<string, number> | null;
  updated_at: string;
};

type CandidateResult =
  | { candidate: string; outcome: "promoted"; trades: number }
  | { candidate: string; outcome: "retired"; trades: number; failReasons: string }
  | { candidate: string; outcome: "paused"; trades: number; reason: string }
  | { candidate: string; outcome: "skipped"; trades: number; reason: "not_enough_trades" | "cooldown"; need?: number; cooldown_days_remaining?: number }
  | { candidate: string; outcome: "ready"; trades: number; expMargin: number };

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
  await admin.from("alerts").insert({ user_id: userId, severity, title, message });
}

async function evaluateForUser(
  admin: ReturnType<typeof createClient>,
  userId: string,
  isCron: boolean,
) {
  const { data: rows } = await admin
    .from("strategies")
    .select("id,name,version,status,metrics,updated_at")
    .eq("user_id", userId)
    .in("status", ["approved", "candidate"])
    .order("updated_at", { ascending: false });

  const all = (rows ?? []) as StrategyRow[];
  const approved = all.find((s) => s.status === "approved") ?? null;
  const candidates = all.filter((s) => s.status === "candidate");

  // Always stamp the heartbeat so the UI knows the loop is alive.
  await admin
    .from("system_state")
    .update({ last_evaluated_at: new Date().toISOString() })
    .eq("user_id", userId);

  if (candidates.length === 0) {
    return { userId, evaluated: 0, results: [] as CandidateResult[], skipped: "no_candidates" };
  }
  if (!approved) {
    return { userId, evaluated: 0, results: [] as CandidateResult[], skipped: "no_approved_baseline" };
  }

  // Paper mode flood gates: lower bars so the system builds pattern data faster.
  // Live mode keeps full safety bars.
  const { data: sysState } = await admin
    .from("system_state")
    .select("last_auto_promoted_at, mode")
    .eq("user_id", userId)
    .maybeSingle();
  const isPaper = ((sysState as { mode?: string } | null)?.mode ?? "paper") !== "live";
  const minTrades = isPaper ? 30 : MIN_TRADES_TO_EVALUATE;   // paper: 30, live: 100
  const cooldownDays = isPaper ? 1 : COOLDOWN_DAYS;          // paper: 1 day, live: 7 days

  // Cooldown: applies to auto (cron) only.
  let cooldownDaysRemaining = 0;
  if (isCron) {
    const last = (sysState as { last_auto_promoted_at?: string | null } | null)?.last_auto_promoted_at;
    if (last) {
      const ageMs = Date.now() - new Date(last).getTime();
      const cooldownMs = cooldownDays * 24 * 60 * 60 * 1000;
      if (ageMs < cooldownMs) {
        cooldownDaysRemaining = Math.ceil((cooldownMs - ageMs) / (24 * 60 * 60 * 1000));
      }
    }
  }

  const aExp = metric(approved, "expectancy");
  const aWin = metric(approved, "winRate");
  const aDD = metric(approved, "maxDrawdown");
  const aSharpe = metric(approved, "sharpe");

  // Phase 3 CI gate: pull honest verdicts for every candidate (and the
  // baseline) from the strategy_performance_ci_v view. We refuse to
  // promote anything that hasn't earned a `positive_edge` verdict in
  // live mode; paper mode is more permissive (`positive_edge` OR
  // `inconclusive` with sufficient evidence) so the system can still
  // learn from candidates that beat the baseline on point estimates
  // but haven't crossed the CI bar yet.
  const candidateIds = candidates.map((c) => c.id);
  const { data: ciRows } = await admin
    .from("strategy_performance_ci_v")
    .select("strategy_id, edge_verdict, evidence_status, avg_pnl_lo, avg_pnl_hi, win_rate_lo, win_rate_hi, closed_trades")
    .in("strategy_id", candidateIds.length ? candidateIds : ["00000000-0000-0000-0000-000000000000"]);
  const ciByStrategy = new Map<string, {
    edge_verdict: string | null;
    evidence_status: string | null;
    avg_pnl_lo: number | null;
    avg_pnl_hi: number | null;
    win_rate_lo: number | null;
    win_rate_hi: number | null;
    closed_trades: number | null;
  }>();
  for (const r of (ciRows ?? []) as Array<Record<string, unknown>>) {
    ciByStrategy.set(r.strategy_id as string, {
      edge_verdict: (r.edge_verdict as string) ?? null,
      evidence_status: (r.evidence_status as string) ?? null,
      avg_pnl_lo: r.avg_pnl_lo as number | null,
      avg_pnl_hi: r.avg_pnl_hi as number | null,
      win_rate_lo: r.win_rate_lo as number | null,
      win_rate_hi: r.win_rate_hi as number | null,
      closed_trades: r.closed_trades as number | null,
    });
  }

  const results: CandidateResult[] = [];
  // Pass 1: classify every candidate. Don't promote yet — we want to pick
  // the best of any that pass before mutating state.
  const readyToPromote: Array<{ row: StrategyRow; expMargin: number; trades: number }> = [];

  for (const c of candidates) {
    const trades = metric(c, "trades");
    if (trades < minTrades) {
      results.push({
        candidate: c.version,
        outcome: "skipped",
        reason: "not_enough_trades",
        trades,
        need: minTrades,
      });
      continue;
    }

    const cExp = metric(c, "expectancy");
    const cWin = metric(c, "winRate");
    const cDD = metric(c, "maxDrawdown");
    const cSharpe = metric(c, "sharpe");

    const expMargin = cExp - aExp;
    const winMargin = cWin - aWin;
    const ddDelta = cDD - aDD;

    const expOk = expMargin >= MIN_EXP_MARGIN;
    const winOk = winMargin >= MIN_WIN_RATE_MARGIN;
    const ddOk = ddDelta >= -DRAWDOWN_TOLERANCE_PP;
    const ddCritical = ddDelta < -DRAWDOWN_CRITICAL_PP;
    const sharpeOk = cSharpe >= aSharpe;
    const allPass = expOk && winOk && ddOk && sharpeOk;

    // Phase 3 honest-edge gate. Even if point-estimate margins beat
    // the baseline, we refuse to crown a candidate whose edge is
    // statistically indistinguishable from luck.
    const ci = ciByStrategy.get(c.id);
    const verdict = ci?.edge_verdict ?? "unproven";
    const evidence = ci?.evidence_status ?? "no_data";
    const ciAcceptable = isPaper
      ? (verdict === "positive_edge" || (verdict === "inconclusive" && evidence === "sufficient"))
      : (verdict === "positive_edge" && evidence === "sufficient");

    if (ddCritical) {
      await createAlert(
        admin,
        userId,
        "warning",
        "Candidate needs your call — drawdown concern",
        `${c.version} hit ${trades} trades and looks better on returns, but max drawdown worsened by ${Math.abs(ddDelta * 100).toFixed(1)}pp. Review before promoting.`,
      );
      results.push({
        candidate: c.version,
        outcome: "paused",
        trades,
        reason: "drawdown_critical",
      });
      continue;
    }

    if (allPass && !ciAcceptable) {
      // Point estimates look great but the CI says we can't be sure.
      // Don't retire — keep gathering trades. Surface as "ready" so the
      // operator can see the candidate is on track but waiting on stats.
      results.push({
        candidate: c.version,
        outcome: "skipped",
        reason: "not_enough_trades",
        trades,
        need: Math.max(minTrades, 30),
      });
      continue;
    }

    if (allPass) {
      // If we're in cooldown (cron only), defer — don't retire a winner.
      if (isCron && cooldownDaysRemaining > 0) {
        results.push({
          candidate: c.version,
          outcome: "skipped",
          reason: "cooldown",
          trades,
          cooldown_days_remaining: cooldownDaysRemaining,
        });
        continue;
      }
      readyToPromote.push({ row: c, expMargin, trades });
      results.push({
        candidate: c.version,
        outcome: "ready",
        trades,
        expMargin,
      });
      continue;
    }

    // Failed the bar → retire.
    const failReasons = [
      !expOk && `expectancy gap too small (${cExp.toFixed(2)}R vs ${aExp.toFixed(2)}R, need +${MIN_EXP_MARGIN.toFixed(2)}R)`,
      !winOk && `win rate gap too small (${(cWin * 100).toFixed(0)}% vs ${(aWin * 100).toFixed(0)}%, need +${(MIN_WIN_RATE_MARGIN * 100).toFixed(0)}pp)`,
      !ddOk && `drawdown worsened by ${Math.abs(ddDelta * 100).toFixed(1)}pp`,
      !sharpeOk && `sharpe (${cSharpe.toFixed(2)} vs ${aSharpe.toFixed(2)})`,
    ].filter(Boolean).join(", ");

    await admin.from("strategies").update({ status: "archived" }).eq("id", c.id);
    await createAlert(
      admin,
      userId,
      "info",
      `Candidate ${c.version} retired`,
      `Didn't beat the baseline after ${trades} trades. Failed on: ${failReasons}.`,
    );
    results.push({
      candidate: c.version,
      outcome: "retired",
      trades,
      failReasons,
    });
  }

  // Pass 2: at most one promotion per run. Best expectancy margin wins.
  if (readyToPromote.length > 0) {
    readyToPromote.sort((a, b) => b.expMargin - a.expMargin);
    const winner = readyToPromote[0];
    const cExp = metric(winner.row, "expectancy");
    const cWin = metric(winner.row, "winRate");
    const cSharpe = metric(winner.row, "sharpe");

    await admin.from("strategies").update({ status: "archived" }).eq("id", approved.id);
    await admin.from("strategies").update({ status: "approved" }).eq("id", winner.row.id);
    await admin
      .from("system_state")
      .update({ last_auto_promoted_at: new Date().toISOString() })
      .eq("user_id", userId);

    const winnerCi = ciByStrategy.get(winner.row.id);
    const ciNote = winnerCi && typeof winnerCi.avg_pnl_lo === "number"
      ? ` · 95% CI on expectancy lower-bound = ${Number(winnerCi.avg_pnl_lo).toFixed(2)}R (${winnerCi.evidence_status})`
      : "";

    await createAlert(
      admin,
      userId,
      "info",
      `🚀 Strategy auto-promoted to ${winner.row.version}`,
      `Expectancy ${aExp.toFixed(2)}R → ${cExp.toFixed(2)}R · Win rate ${(aWin * 100).toFixed(0)}% → ${(cWin * 100).toFixed(0)}% · Sharpe ${aSharpe.toFixed(2)} → ${cSharpe.toFixed(2)} after ${winner.trades} paper trades${ciNote}. Auto-promotions paused for ${cooldownDays} day${cooldownDays === 1 ? "" : "s"}.`,
    );


    // Mark the winner's "ready" entry as "promoted"; remaining "ready"
    // entries become "skipped" (they'll get re-evaluated after cooldown).
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.outcome !== "ready") continue;
      if (r.candidate === winner.row.version) {
        results[i] = { candidate: r.candidate, outcome: "promoted", trades: r.trades };
      } else {
        results[i] = {
          candidate: r.candidate,
          outcome: "skipped",
          reason: "cooldown",
          trades: r.trades,
          cooldown_days_remaining: cooldownDays,
        };
      }
    }
  }

  return { userId, evaluated: candidates.length, results };
}

Deno.serve(async (req: Request) => {
    const cors = makeCorsHeaders(req);
  const json = (b: unknown, s: number) =>
    new Response(JSON.stringify(b), {
      status: s,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  
  const MIN_TRADES_TO_EVALUATE = 100;
if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

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
      const { data: rows } = await admin
        .from("strategies")
        .select("user_id")
        .eq("status", "candidate");
      userIds = Array.from(new Set((rows ?? []).map((r: { user_id: string }) => r.user_id)));
    } else {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser(bearer);
      if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
      userIds = [userData.user.id];

      // Rate limit user-triggered runs only.
      const rl = await checkRateLimit(admin, userData.user.id, "evaluate-candidate", 10);
      if (!rl.allowed) return rateLimitResponse(rl, cors);
    }

    if (userIds.length === 0) {
      return json({ ok: true, processed: 0, results: [] }, 200);
    }

    const results: unknown[] = [];
    for (const uid of userIds) {
      try {
        results.push(await evaluateForUser(admin, uid, isCron));
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
