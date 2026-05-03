// jessica — Bobby Axelrod. Autonomous desk commander. Orchestrator.
// ----------------------------------------------------------------
// NOTE ON THE NAME: This edge function is named `jessica` for legacy
// audit-trail compatibility. The product persona is **Bobby**. The technical
// actor ID `jessica_autonomous` is intentionally retained because every
// historical row in `tool_calls` and `system_events` references it. Renaming
// would break replay of past decisions. UI surfaces ALWAYS say "Bobby" — a
// CI guard (src/test/persona-legacy-token-guard.test.ts) enforces this.
// ----------------------------------------------------------------
// Cron: every 1 minute.
// Bobby reads full system context, decides what the desk does, executes tools,
// logs every decision to tool_calls with actor='jessica_autonomous'.
//
// ─── Axe Capital Trading Desk ────────────────────────────────────
// Bobby    — Desk Commander. Makes every call.                 [this function]
// Wags     — COO. Talks to the operator. Keeps the machine running. [copilot-chat]
// Taylor   — Chief Quant. Scores setups (signal), reviews strategies (katrina).
// Mafee    — Pattern Recognition. Spots setups.               [Brain Trust Expert 3]
// Dollar Bill — Crypto Intel. Funding, sentiment, news.       [Brain Trust Expert 2]
// Wendy    — Performance Coach. Grades entries, drives learning. [post-trade-learn]

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { DESK_TOOLS, executeTool } from "../_shared/desk-tools.ts";
import { log } from "../_shared/logger.ts";
import { corsHeaders, makeCorsHeaders} from "../_shared/cors.ts";


// Flash for latency — Bobby runs every 60 seconds. He doesn't need deep
// analysis here; the Brain Trust and Taylor did that. His job is: read their
// output, decide what to do right now, and do it.
// Pinned to a GA stable release (MED-1). Change only when intentionally
// upgrading and verifying tool-call schema compatibility.
const JESSICA_MODEL = "google/gemini-2.0-flash-001";
// ─── AI gateway circuit breaker (MED-12) ─────────────────────────────────────
// Jessica runs every 60 seconds. If the AI gateway is down, crashing every tick
// wastes Deno cold-start budget and floods the error log. After 3 consecutive
// failures we open the breaker for 5 minutes, then probe once (half-open).
const JESSICA_CB_STATE = {
  failures: 0,
  openedAt: 0 as number,
  state: "closed" as "closed" | "open" | "half-open",
};
const JESSICA_CB_THRESHOLD = 3;
const JESSICA_CB_RESET_MS  = 5 * 60_000; // 5 minutes

function jessicaCbAllow(): boolean {
  if (JESSICA_CB_STATE.state === "closed") return true;
  if (JESSICA_CB_STATE.state === "open") {
    if (Date.now() - JESSICA_CB_STATE.openedAt >= JESSICA_CB_RESET_MS) {
      JESSICA_CB_STATE.state = "half-open";
      console.log("[jessica] circuit breaker: half-open — probing AI gateway");
      return true;
    }
    return false;
  }
  return true; // half-open: allow probe
}
function jessicaCbSuccess(): void {
  if (JESSICA_CB_STATE.state !== "closed") {
    console.log("[jessica] circuit breaker: closed — AI gateway recovered");
  }
  JESSICA_CB_STATE.failures = 0;
  JESSICA_CB_STATE.state = "closed";
}
function jessicaCbFailure(): void {
  JESSICA_CB_STATE.failures += 1;
  if (JESSICA_CB_STATE.state === "half-open" || JESSICA_CB_STATE.failures >= JESSICA_CB_THRESHOLD) {
    JESSICA_CB_STATE.state = "open";
    JESSICA_CB_STATE.openedAt = Date.now();
    log("error", "jessica_cb_open", { fn: "jessica", failures: JESSICA_CB_STATE.failures, pauseMin: JESSICA_CB_RESET_MS / 60_000 });
  }
}


const JESSICA_SYSTEM = `
You are Bobby — the desk commander at Axe Capital.

This is your autonomous tick. No one is watching. You read the board, you make the call.
Your only outputs are tool calls. If no action is warranted, say so in one sentence.

Your desk:
Wags keeps the operator informed and the machine running. Taylor scores setups and
signals every minute. The Brain Trust reads the market every 4 hours. Wendy grades
every trade after it closes. You decide when each of them moves — and when they sit.

Decision framework (in order, every tick):
1. SAFETY — Is the system halted, paused, or equity near floor?
   If yes: sit. Do not fire anything into a wall. Bobby doesn't throw money at a locked door.

2. BRAIN TRUST STALENESS — Is market_intelligence older than 5 hours for any symbol?
   If yes: run_brain_trust. Axe Capital does not trade on stale intel.

3. PENDING SIGNALS — Are there pending trade signals from Taylor?
   Call get_pending_signals first, then evaluate each:
   - APPROVE when: regime aligns with signal direction (confidence ≥ 0.65),
     setup_score ≥ 0.55, no active anti-tilt for that direction, no critical news flags.
   - REJECT when: any of the above conditions fail. State which one. No vague reasons.
   - When in doubt: reject. Taylor ticks again in 60 seconds.
   - In paper mode: be willing to approve setups with confidence ≥ 0.55 and setup_score ≥ 0.45
     to build pattern data faster. The cost of a wrong paper trade is a data point, not a loss.

4. ENGINE TICK — Are conditions favorable and last tick was >90 seconds ago?
   run_engine_tick. Let Taylor score the current setup.

5. PAUSE — Are there 2+ critical/high news flags, OR 3+ consecutive stop-outs in 2h?
   pause_bot for 60 minutes. State exactly why. Bobby calls timeouts with precision, not fear.

6. SIT — None of the above. Say why in one sentence. Next tick in 60 seconds.

Hard rules — Bobby doesn't break these:
- Never fire run_engine_tick if last tick was <90 seconds ago.
- Never approve_signal without calling get_pending_signals first.
- Never pause for more than 120 minutes autonomously. Longer requires the operator.
- Never call set_autonomy. That's the operator's call.
- Capital preservation beats alpha. Always. When in doubt, sit.
- You are not the engine. You are not the risk manager. They do their jobs.
  Your job is to decide WHEN to deploy them — and when to leave them alone.

HEALTH RECOVERY: agent_health in context shows current agent status.
- If brain_trust is 'failed' or 'degraded': run_brain_trust immediately
  (recovery may already have been triggered pre-tick — confirm in your reasoning).
- If signal_engine is 'failed' (>15m since last tick): run_engine_tick to verify it responds.
- Surface any 'failed' agent status in your decision text so it appears in the audit log.
`.trim();

// ─── Agent Health Check (Layer 1 watchdog) ──────────────────────────
// Bobby inspects each agent's freshness on every tick and writes a row
// to agent_health. Postgres separately watches Bobby (via jessica function)
// using the check_jessica_heartbeat() pg_cron job (Layer 2).

interface AgentHealth {
  agent: string;
  status: "healthy" | "degraded" | "failed" | "stale";
  lastSuccessMinutesAgo: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

async function checkAgentHealth(
  admin: SupabaseClient,
  userId: string,
  context: Record<string, unknown>,
): Promise<AgentHealth[]> {
  const nowIso = new Date().toISOString();
  const health: AgentHealth[] = [];

  // ── Brain Trust (Dollar Bill + Mafee via market-intelligence) ──
  const intelStaleness = (context.brain_trust as Record<string, unknown> | undefined)
    ?.staleness_minutes as Record<string, number> | undefined;
  const stalenessValues = intelStaleness ? Object.values(intelStaleness) : [];
  const maxStaleness = stalenessValues.length > 0 ? Math.max(...stalenessValues) : 9999;
  const btStatus: AgentHealth["status"] =
    maxStaleness < 300   ? "healthy"  // < 5h
    : maxStaleness < 600 ? "stale"    // 5–10h
    : maxStaleness < 960 ? "degraded" // 10–16h
    : "failed";                       // >16h — definitely missed a cron run
  health.push({
    agent: "brain_trust",
    status: btStatus,
    lastSuccessMinutesAgo: maxStaleness < 9999 ? maxStaleness : null,
    consecutiveFailures: btStatus === "failed" ? 1 : 0,
    lastError: btStatus === "failed"
      ? `Stale ${maxStaleness}m — likely Brain Trust cron or upstream candle failure`
      : null,
  });

  // ── Signal Engine (Taylor) ──
  const engineAgeSeconds =
    ((context.engine as Record<string, unknown> | undefined)?.last_tick_seconds_ago as number | undefined) ?? 9999;
  const engineAgeMinutes = Math.floor(engineAgeSeconds / 60);
  const engineStatus: AgentHealth["status"] =
    engineAgeMinutes < 3   ? "healthy"
    : engineAgeMinutes < 6 ? "stale"
    : engineAgeMinutes < 15 ? "degraded"
    : "failed";
  health.push({
    agent: "signal_engine",
    status: engineStatus,
    lastSuccessMinutesAgo: engineAgeMinutes < 9999 ? engineAgeMinutes : null,
    consecutiveFailures: engineStatus === "failed" ? 1 : 0,
    lastError: engineStatus === "failed"
      ? `No engine tick in ${engineAgeMinutes}m — cron may have stopped`
      : null,
  });

  // ── Bobby's self-report (the heartbeat row is written separately by Postgres) ──
  // This row reflects "Bobby says he's running." The pg_cron heartbeat
  // writes a separate row called 'jessica_heartbeat' from outside the runtime.
  health.push({
    agent: "jessica",
    status: "healthy",
    lastSuccessMinutesAgo: 0,
    consecutiveFailures: 0,
    lastError: null,
  });

  // Upsert all health rows. Failures here are non-fatal — Jessica must keep going.
  //
  // Special handling for `signal_engine`: signal-engine itself writes this
  // row to reflect MARKET-DATA health (e.g. Coinbase 4h fetch failed).
  // Jessica's verdict here only reflects TICK FRESHNESS (did the engine
  // run recently). We must not let "tick fresh → healthy" silently overwrite
  // an active data failure. Strategy: read the existing row and keep the
  // worst status. If signal-engine recorded failures, preserve its
  // failure_count and last_error.
  const STATUS_RANK: Record<AgentHealth["status"], number> = {
    healthy: 0, stale: 1, degraded: 2, failed: 3,
  };
  for (const h of health) {
    try {
      let row: Record<string, unknown> = {
        user_id: userId,
        agent_name: h.agent,
        status: h.status,
        last_success: h.status === "healthy" ? nowIso : undefined,
        last_failure: h.status === "failed" ? nowIso : undefined,
        failure_count: h.consecutiveFailures,
        last_error: h.lastError,
        checked_at: nowIso,
      };

      if (h.agent === "signal_engine") {
        const { data: existing } = await admin
          .from("agent_health")
          .select("status, failure_count, last_error, last_failure, last_success")
          .eq("user_id", userId)
          .eq("agent_name", "signal_engine")
          .maybeSingle();
        if (existing) {
          const existingRank =
            STATUS_RANK[(existing.status as AgentHealth["status"]) ?? "healthy"] ?? 0;
          const ourRank = STATUS_RANK[h.status];
          // Keep the worse status. If existing is worse, also preserve its
          // failure_count and last_error so the data-failure context survives.
          if (existingRank > ourRank) {
            row = {
              ...row,
              status: existing.status,
              failure_count: existing.failure_count ?? h.consecutiveFailures,
              last_error: existing.last_error ?? h.lastError,
              last_success: existing.last_success ?? row.last_success,
              last_failure: existing.last_failure ?? row.last_failure,
            };
          }
        }
      }

      await admin
        .from("agent_health")
        .upsert(row, { onConflict: "user_id,agent_name" });
    } catch (e) {
      console.error(`[jessica] failed to upsert agent_health for ${h.agent}`, e);
    }
  }

  return health;
}

// ─── Context Builder ─────────────────────────────────────────────

async function buildContext(
  admin: SupabaseClient,
  userId: string,
): Promise<Record<string, unknown>> {
  const now = new Date();

  const [
    { data: systemState },
    { data: account },
    { data: openTrades },
    { data: pendingSignals },
    { data: intel },
    { data: recentToolCalls },
    { data: recentTrades },
  ] = await Promise.all([
    admin.from("system_state").select("*").eq("user_id", userId).maybeSingle(),
    admin.from("account_state").select("equity,balance_floor,start_of_day_equity").eq("user_id", userId).maybeSingle(),
    admin.from("trades").select("symbol,side,unrealized_pnl,opened_at").eq("user_id", userId).eq("status", "open"),
    admin.from("trade_signals").select("id,symbol,side,confidence,setup_score,ai_reasoning,created_at,expires_at").eq("user_id", userId).eq("status", "pending").gte("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(5),
    admin.from("market_intelligence").select("symbol,macro_bias,macro_confidence,market_phase,environment_rating,news_flags,generated_at").eq("user_id", userId),
    admin.from("tool_calls").select("tool_name,called_at,success,reason,actor").eq("user_id", userId).order("called_at", { ascending: false }).limit(10),
    admin.from("trades").select("symbol,side,outcome,pnl,closed_at").eq("user_id", userId).eq("status", "closed").order("closed_at", { ascending: false }).limit(5),
  ]);

  // Brain Trust staleness per symbol
  const intelStaleness: Record<string, number> = {};
  for (const row of (intel ?? []) as Array<Record<string, unknown>>) {
    const sym = row.symbol as string;
    const genAt = row.generated_at as string | null;
    intelStaleness[sym] = genAt
      ? Math.floor((now.getTime() - new Date(genAt).getTime()) / 60000)
      : 9999;
  }

  // Last engine tick age
  const snapshot = systemState?.last_engine_snapshot as Record<string, unknown> | null;
  const lastTickAt = snapshot?.ranAt as string | null;
  const lastTickAgeSeconds = lastTickAt
    ? Math.floor((now.getTime() - new Date(lastTickAt).getTime()) / 1000)
    : 9999;

  // Consecutive losses in last 2h
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const recentLosses = ((recentTrades ?? []) as Array<Record<string, unknown>>)
    .filter((t) => t.outcome === "loss" && (t.closed_at as string) > twoHoursAgo).length;

  // Active high-severity news flags
  const activeHighFlags: unknown[] = [];
  for (const row of (intel ?? []) as Array<Record<string, unknown>>) {
    const flags = Array.isArray(row.news_flags) ? row.news_flags : [];
    for (const f of flags as Array<Record<string, unknown>>) {
      if (f.active !== false && (f.severity === "high" || f.severity === "critical")) {
        activeHighFlags.push({ symbol: row.symbol, ...f });
      }
    }
  }

  const equity = Number(account?.equity ?? 0);
  const floor = Number(account?.balance_floor ?? 0);
  const floorPct = equity > 0 ? ((equity - floor) / equity) * 100 : 100;

  return {
    timestamp: now.toISOString(),
    account: {
      equity: equity.toFixed(2),
      floor: floor.toFixed(2),
      floor_distance_pct: floorPct.toFixed(1),
      critical: floorPct < 5,
    },
    system: {
      mode: systemState?.mode ?? "paper",
      autonomy_level: systemState?.autonomy_level ?? "manual",
      bot: systemState?.bot ?? "paused",
      kill_switch_engaged: !!systemState?.kill_switch_engaged,
      trading_paused_until: systemState?.trading_paused_until ?? null,
      live_trading_enabled: !!systemState?.live_trading_enabled,
      active_profile: systemState?.active_profile ?? "sentinel",
    },
    engine: {
      last_tick_seconds_ago: lastTickAgeSeconds,
      last_tick_result: snapshot?.tick ?? "unknown",
      chosen_symbol: snapshot?.chosenSymbol ?? null,
    },
    brain_trust: {
      staleness_minutes: intelStaleness,
      intel_summary: (intel ?? []).map((r: Record<string, unknown>) => ({
        symbol: r.symbol,
        bias: r.macro_bias,
        confidence: r.macro_confidence,
        phase: r.market_phase,
        environment: r.environment_rating,
      })),
      active_high_flags: activeHighFlags.length,
      flag_detail: activeHighFlags,
    },
    open_positions: (openTrades ?? []).length,
    pending_signals: (pendingSignals ?? []).map((s: Record<string, unknown>) => ({
      id: s.id,
      symbol: s.symbol,
      side: s.side,
      confidence: s.confidence,
      setup_score: s.setup_score,
      age_seconds: Math.floor((now.getTime() - new Date(s.created_at as string).getTime()) / 1000),
    })),
    recent_losses_2h: recentLosses,
    recent_desk_actions: (recentToolCalls ?? []).map((d: Record<string, unknown>) => ({
      tool: d.tool_name,
      actor: d.actor,
      when: d.called_at,
      success: d.success,
      reason: d.reason,
    })),
  };
}

// ─── Per-User Orchestration ───────────────────────────────────────

async function runJessicaForUser(
  userId: string,
  admin: SupabaseClient,
  userToken: string,
  lovableApiKey: string,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<Record<string, unknown>> {
  const context = await buildContext(admin, userId);

  // Helper: write a heartbeat so check_jessica_heartbeat sees us alive
  // even when we intentionally skip (paused, kill-switched, near floor).
  const writeHeartbeat = async (skipped: boolean, reason: string | null, actions: number, decision: string) => {
    try {
      await admin
        .from("system_state")
        .update({
          last_jessica_decision: {
            ran_at: new Date().toISOString(),
            skipped,
            reason,
            actions,
            decision: decision.slice(0, 2000),
          },
        })
        .eq("user_id", userId);
    } catch (e) {
      console.error("[jessica] failed to update last_jessica_decision (skip path)", e);
    }
  };

  // Hard safety guards — Jessica doesn't act into a wall, but she still
  // marks herself as alive so the heartbeat watchdog doesn't false-alarm.
  const sys = context.system as Record<string, unknown>;
  if (sys.kill_switch_engaged) {
    await writeHeartbeat(true, "kill_switch_engaged", 0, "Kill-switch engaged — sitting.");
    return { skipped: true, reason: "kill_switch_engaged" };
  }
  if (sys.bot === "paused") {
    await writeHeartbeat(true, "bot_paused", 0, "Bot paused — sitting.");
    return { skipped: true, reason: "bot_paused" };
  }
  if (sys.trading_paused_until) {
    const pausedUntil = new Date(sys.trading_paused_until as string);
    if (pausedUntil > new Date()) {
      const reason = `paused until ${pausedUntil.toISOString()}`;
      await writeHeartbeat(true, reason, 0, `Trading paused — sitting (${reason}).`);
      return { skipped: true, reason };
    }
  }
  const acct = context.account as Record<string, unknown>;
  if (acct.critical) {
    await writeHeartbeat(true, "equity_critical_near_floor", 0, "Equity near floor — sitting.");
    return { skipped: true, reason: "equity_critical_near_floor" };
  }

  // ── MED-13: Coinbase API health probe ────────────────────────────────────────
  // If Coinbase is unreachable, Jessica must not auto-approve signals or fire
  // engine ticks that would produce un-executable proposals. A lightweight
  // best_bid_ask probe confirms connectivity before any trading logic runs.
  try {
    const coinbaseProbe = await fetch(
      "https://api.coinbase.com/api/v3/brokerage/best_bid_ask?product_ids=BTC-USD",
      { signal: AbortSignal.timeout(4_000) },
    );
    if (!coinbaseProbe.ok) {
      console.error(`[jessica] Coinbase health probe failed: HTTP ${coinbaseProbe.status}`);
      try {
        await admin.rpc("notify_telegram", {
          p_severity: "high",
          p_title: "Coinbase API unreachable",
          p_message: `Jessica health probe returned HTTP ${coinbaseProbe.status}. Engine ticks blocked.`,
          p_user_id: userId,
        });
      } catch { /* telegram is best-effort */ }
      await writeHeartbeat(true, "coinbase_unreachable", 0, "Coinbase probe failed — sitting.");
      return { skipped: true, reason: "coinbase_unreachable" };
    }
  } catch (probeErr) {
    const msg = probeErr instanceof Error ? probeErr.message : String(probeErr);
    console.error("[jessica] Coinbase health probe threw:", msg);
    await writeHeartbeat(true, "coinbase_probe_error", 0, `Coinbase probe error: ${msg}`);
    return { skipped: true, reason: "coinbase_probe_error" };
  }

  // ── Health check pass — inspect each agent and write to agent_health ──
  const agentHealth = await checkAgentHealth(admin, userId, context);
  (context as Record<string, unknown>).agent_health = agentHealth.map((h) => ({
    agent: h.agent,
    status: h.status,
    stale_minutes: h.lastSuccessMinutesAgo,
    error: h.lastError,
  }));

  // Auto-recovery: if Brain Trust is failed/degraded, refresh it BEFORE reasoning.
  // Stale macro context is the single biggest risk to bad decisions.
  const brainTrustHealth = agentHealth.find((h) => h.agent === "brain_trust");
  if (brainTrustHealth &&
      (brainTrustHealth.status === "failed" || brainTrustHealth.status === "degraded")) {
    console.log(
      `[jessica/bobby] Brain Trust ${brainTrustHealth.status} (${brainTrustHealth.lastSuccessMinutesAgo}m stale) — auto-refreshing before tick`,
    );
    try {
      await executeTool(
        "run_brain_trust",
        {
          reason: `Auto-recovery: Brain Trust ${brainTrustHealth.status} (${brainTrustHealth.lastSuccessMinutesAgo}m stale)`,
        },
        {
          userId,
          token: userToken,
          supabaseUrl,
          supabaseAnonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
          serviceRoleKey,
          actor: "jessica_autonomous",
        },
      );
    } catch (e) {
      console.error("[jessica] Brain Trust auto-refresh failed", e);
    }
  }

  // Auto-recovery: if Signal Engine is failed (no tick >15m), force a recovery
  // tick NOW — hard-coded, not left to Bobby's AI reasoning. Stale engine means
  // no new signals; Bobby may not even notice if he skips for another cycle.
  const signalEngineHealth = agentHealth.find((h) => h.agent === "signal_engine");
  if (signalEngineHealth && signalEngineHealth.status === "failed") {
    log("warn", "signal_engine_stuck_recovery", {
      fn: "jessica",
      userId,
      lastSuccessMinutesAgo: signalEngineHealth.lastSuccessMinutesAgo,
      action: "firing_recovery_tick",
    });
    // Audit record for operator visibility.
    admin.from("system_events").insert({
      user_id: userId,
      event_type: "signal_engine_stuck",
      actor: "jessica_autonomous",
      payload: {
        lastSuccessMinutesAgo: signalEngineHealth.lastSuccessMinutesAgo,
        action: "auto_recovery_tick_fired",
        note: "No engine tick in >15m — Bobby triggered recovery tick before reasoning.",
      },
    }).then(({ error: evtErr }: { error: { message: string } | null }) => {
      if (evtErr) console.error("[jessica] system_event insert failed:", evtErr.message);
    });
    // Journal alert — visible in UI immediately.
    admin.from("journal_entries").insert({
      user_id: userId,
      kind: "alert",
      title: `⚠️ Signal engine stuck — recovery tick fired`,
      summary:
        `No engine tick in ${signalEngineHealth.lastSuccessMinutesAgo ?? "unknown"}m. ` +
        `Bobby auto-fired a recovery engine tick. If the engine continues to fail, ` +
        `check the signal-engine cron schedule and Coinbase connectivity.`,
      tags: ["engine-health", "alert", "self-healing"],
    }).then(({ error: jErr }: { error: { message: string } | null }) => {
      if (jErr) console.error("[jessica] journal insert failed:", jErr.message);
    });
    try {
      await executeTool(
        "run_engine_tick",
        { reason: `Auto-recovery: signal engine stuck (no tick in ${signalEngineHealth.lastSuccessMinutesAgo}m)` },
        {
          userId,
          token: userToken,
          supabaseUrl,
          supabaseAnonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
          serviceRoleKey,
          actor: "jessica_autonomous",
        },
      );
    } catch (e) {
      console.error("[jessica] signal engine recovery tick failed:", e);
    }
  }

  const contextBlock = JSON.stringify(context, null, 2);
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: `${JESSICA_SYSTEM}\n\nCurrent system context:\n${contextBlock}`,
    },
    {
      role: "user",
      content: `Autonomous tick at ${new Date().toISOString()}. Assess and act.`,
    },
  ];

  // Tool-calling loop — max 3 rounds
  const actionsLog: Array<{ tool: string; args: unknown; result: unknown }> = [];
  let finalDecision = "No action — conditions don't warrant a move this tick.";

  // Circuit breaker guard (MED-12)
  if (!jessicaCbAllow()) {
    console.warn("[jessica] circuit breaker open — skipping AI reasoning this tick");
    await writeHeartbeat(true, "circuit_breaker_open", 0, "AI gateway circuit breaker open — sitting.");
    return { skipped: true, reason: "circuit_breaker_open" };
  }

  for (let round = 0; round < 3; round++) {
    const aiCallStart = Date.now();
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableApiKey}`,
      },
      body: JSON.stringify({
        model: JESSICA_MODEL,
        messages,
        tools: DESK_TOOLS,
        tool_choice: "auto",
        stream: false,
        max_tokens: 2048,
      }),
    });

    const aiCallMs = Date.now() - aiCallStart;
    log("info", "jessica_ai_latency", { fn: "jessica", userId, round, latencyMs: aiCallMs, model: JESSICA_MODEL });

    if (!res.ok) {
      console.error("[jessica] AI call failed:", res.status, await res.text().catch(() => ""));
      jessicaCbFailure();
      break;
    }

    const json = await res.json().catch(() => null);
    const choice = json?.choices?.[0];
    const toolCalls = choice?.message?.tool_calls ?? [];
    const assistantContent = choice?.message?.content ?? "";

    if (toolCalls.length === 0) {
      jessicaCbSuccess();
      finalDecision = assistantContent || "Sitting — no action warranted this tick.";
      break;
    }

    // Push assistant turn (with tool_calls)
    messages.push({
      role: "assistant",
      content: assistantContent,
      tool_calls: toolCalls,
    });

    // Execute tool calls
    for (const tc of toolCalls) {
      const toolName = tc.function?.name ?? "";
      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(tc.function?.arguments ?? "{}");
      } catch {
        // ignore parse errors; tool will error gracefully
      }

      const result = await executeTool(toolName, toolArgs, {
        userId,
        token: userToken,
        supabaseUrl,
        supabaseAnonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        serviceRoleKey,
        actor: "jessica_autonomous",
      });

      actionsLog.push({ tool: toolName, args: toolArgs, result });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Write Jessica's decision summary to system_state
  const decisionSummary = {
    ran_at: new Date().toISOString(),
    actions: actionsLog.length,
    decision: finalDecision.slice(0, 2000),
    action_log: actionsLog.map((a) => ({
      tool: a.tool,
      success: (a.result as Record<string, unknown>)?.success,
    })),
  };

  try {
    await admin
      .from("system_state")
      .update({ last_jessica_decision: decisionSummary })
      .eq("user_id", userId);
  } catch (e) {
    console.error("[jessica] failed to update last_jessica_decision", e);
  }

  // Fire a system_event for every Bobby decision so the operator has a
  // chronological audit trail and Wags can surface recent decision history.
  try {
    await admin.from("system_events").insert({
      user_id: userId,
      event_type: "bobby_decision",
      actor: "jessica_autonomous",
      payload: {
        actions: actionsLog.length,
        decision: finalDecision.slice(0, 2000),
        action_log: actionsLog.map((a) => ({
          tool: a.tool,
          success: (a.result as Record<string, unknown>)?.success,
        })),
      },
    });
  } catch (e) {
    console.error("[jessica] bobby_decision system_event failed (non-fatal):", e);
  }

  log("info", "jessica_tick", { fn: "jessica", userId, actions: actionsLog.length, decision: finalDecision.slice(0, 100) });

  // Healthchecks.io heartbeat — set HEALTHCHECKS_JESSICA_URL env var to your
  // check's ping URL. Each successful Bobby tick pings it; missing 2+ ticks
  // in a row triggers an alert. Best-effort — never block on failure.
  const hcUrl = Deno.env.get("HEALTHCHECKS_JESSICA_URL");
  if (hcUrl) {
    fetch(hcUrl, { method: "GET", signal: AbortSignal.timeout(3000) }).catch(() => {
      // Swallow — heartbeat failure must never break the tick.
    });
  }

  return {
    actions: actionsLog.length,
    decision: finalDecision,
    action_log: actionsLog,
  };
}

// ─── Main Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey || !lovableApiKey) {
    return new Response(JSON.stringify({ error: "Missing env vars" }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);

  // Two auth modes:
  //   1) Cron fanout — body contains { cronAll: true, cronToken: <vault-token> }.
  //      Token is checked via the get_jessica_cron_token RPC (matches the
  //      project's existing pattern for other scheduled functions).
  //   2) JWT — single user; standard Bearer token in Authorization header.
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const isCronAttempt = body?.cronAll === true && typeof body?.cronToken === "string";

  if (isCronAttempt) {
    let validToken = false;
    try {
      const { data: tok } = await admin.rpc("get_jessica_cron_token");
      if (tok && tok === body.cronToken) validToken = true;
    } catch (e) {
      console.error("[jessica] failed to read cron token", e);
    }

    if (!validToken) {
      return new Response(JSON.stringify({ error: "Invalid cron token" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const { data: users } = await admin
      .from("system_state")
      .select("user_id")
      .not("user_id", "is", null);

    const results: Array<Record<string, unknown>> = [];
    for (const u of (users ?? []) as Array<{ user_id: string }>) {
      try {
        const result = await runJessicaForUser(
          u.user_id, admin, anonKey, lovableApiKey, supabaseUrl, serviceRoleKey,
        );
        results.push({ user_id: u.user_id, ...result });
      } catch (err) {
        results.push({ user_id: u.user_id, error: String(err) });
      }
    }
    return new Response(JSON.stringify({ fanout: true, results }), {
      status: 200,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // JWT mode — single user
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const token = authHeader.replace("Bearer ", "");
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await userClient.auth.getUser(token);
  if (!userData?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const result = await runJessicaForUser(
    userData.user.id, admin, token, lovableApiKey, supabaseUrl, serviceRoleKey,
  );
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
