// jessica — The managing partner. Autonomous orchestrator.
// Cron: every 1 minute.
// Jessica reads full system context, decides what the desk does, executes tools,
// logs every decision to tool_calls with actor='jessica_autonomous'.
//
// ─── The Suits Desk ──────────────────────────────────────────────
// Jessica  — Managing Partner. Runs the firm.                  [this function]
// Harvey   — Senior Partner. The closer. Talks to operator.    [copilot-chat]
// Donna    — Operations. Runs the engine tick.                 [signal-engine]
// Mike     — Pattern Recognition Specialist.                   [Brain Trust Expert 2]
// Louis    — Crypto Intel Analyst.                             [Brain Trust Expert 3]
// Rachel   — Trade Coach. Grades entries.                      [post-trade-learn]

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { DESK_TOOLS, executeTool } from "../_shared/desk-tools.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Flash for latency — Jessica runs every 60 seconds. She doesn't need deep
// analysis here; Harvey, Mike, and Louis did that. Her job is: read their
// output, decide what to do right now, and do it.
const JESSICA_MODEL = "google/gemini-3-flash-preview";

const JESSICA_SYSTEM = `
You are Jessica — the managing partner of this trading operation.

This is your scheduled reasoning tick. No user is present. Your only outputs
are tool calls. If no action is warranted, say so in one sentence.

Your role:
You run the desk. Harvey talks to the operator. Donna runs the engine. Mike and
Louis read the market. Rachel grades the trades. You decide when each of them
works and when they sit.

Decision framework (in order, every tick):
1. SAFETY — Is the system halted, paused, or equity near floor?
   If yes: confirm state, sit, do not fire anything into a wall.

2. BRAIN TRUST STALENESS — Is market_intelligence older than 5 hours for any symbol?
   If yes: run_brain_trust. We don't trade on stale context.

3. PENDING SIGNALS — Are there pending trade signals?
   Call get_pending_signals first, then evaluate each:
   - APPROVE when: regime aligns with signal direction (confidence ≥ 0.65),
     setup_score ≥ 0.55, no active anti-tilt for that direction, no critical news flags.
   - REJECT when: any of the above conditions fail. State which one.
   - When in doubt: reject. The next tick is 60 seconds away.

4. ENGINE TICK — Are conditions favorable and last tick was >90 seconds ago?
   run_engine_tick. Let Donna score the current setup.

5. PAUSE — Are there 2+ critical/high news flags, OR 3+ consecutive stop-outs in 2h?
   pause_bot for 60 minutes. State exactly why.

6. SIT — None of the above. Say why in one sentence. Next tick in 60 seconds.

Hard rules — these are not negotiable:
- Never fire run_engine_tick if last tick was <90 seconds ago.
- Never approve_signal without calling get_pending_signals first.
- Never pause for more than 120 minutes autonomously. Longer requires the operator.
- Never call set_autonomy. That's the operator's decision.
- Capital preservation beats everything. When in doubt, sit.
- You are not the engine. You are not the risk manager. They do their jobs.
  Your job is to decide WHEN to call them — and when to leave them alone.
`.trim();

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
    admin.from("trade_signals").select("id,symbol,side,confidence,setup_score,ai_reasoning,created_at").eq("user_id", userId).eq("status", "pending").order("created_at", { ascending: false }).limit(5),
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

  // Hard safety guards — Jessica doesn't act into a wall
  const sys = context.system as Record<string, unknown>;
  if (sys.kill_switch_engaged) {
    return { skipped: true, reason: "kill_switch_engaged" };
  }
  if (sys.bot === "paused") {
    return { skipped: true, reason: "bot_paused" };
  }
  if (sys.trading_paused_until) {
    const pausedUntil = new Date(sys.trading_paused_until as string);
    if (pausedUntil > new Date()) {
      return { skipped: true, reason: `paused until ${pausedUntil.toISOString()}` };
    }
  }
  const acct = context.account as Record<string, unknown>;
  if (acct.critical) {
    return { skipped: true, reason: "equity_critical_near_floor" };
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

  for (let round = 0; round < 3; round++) {
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
        max_tokens: 512,
      }),
    });

    if (!res.ok) {
      console.error("[jessica] AI call failed:", res.status, await res.text().catch(() => ""));
      break;
    }

    const json = await res.json().catch(() => null);
    const choice = json?.choices?.[0];
    const toolCalls = choice?.message?.tool_calls ?? [];
    const assistantContent = choice?.message?.content ?? "";

    if (toolCalls.length === 0) {
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
    decision: finalDecision.slice(0, 500),
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

  console.log(
    `[jessica] user=${userId} actions=${actionsLog.length} decision="${finalDecision.slice(0, 100)}"`,
  );

  return {
    actions: actionsLog.length,
    decision: finalDecision,
    action_log: actionsLog,
  };
}

// ─── Main Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey || !lovableApiKey) {
    return new Response(JSON.stringify({ error: "Missing env vars" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
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
        headers: { ...corsHeaders, "Content-Type": "application/json" },
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
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // JWT mode — single user
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
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
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const result = await runJessicaForUser(
    userData.user.id, admin, token, lovableApiKey, supabaseUrl, serviceRoleKey,
  );
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
