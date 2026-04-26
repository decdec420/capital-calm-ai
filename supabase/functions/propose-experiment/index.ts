// propose-experiment — the Copilot's R&D proposer.
// Cron-triggered (every 6h). For each user:
//   1. Skip if they already have ≥2 queued copilot experiments (don't pile up)
//   2. Pull their approved strategy + last 30 days of trades + recent gate reasons
//   3. Ask Lovable AI to pick ONE parameter to tweak with a hypothesis
//   4. Insert an `experiments` row with proposed_by='copilot', status='queued'
//
// Auth: vault token (cron) — same pattern as signal-engine.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (b: unknown, s: number) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Numeric, Copilot-tweakable knobs only. Strings/bools stay off-limits for now.
const TWEAKABLE = ["ema_fast", "ema_slow", "rsi_period", "stop_atr_mult", "tp_r_mult", "max_order_pct"] as const;

async function proposeForUser(admin: any, userId: string, LOVABLE_API_KEY: string) {
  // 1. Idempotency — don't pile up
  const { count: queuedCount } = await admin
    .from("experiments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("proposed_by", "copilot")
    .in("status", ["queued", "running"]);
  if ((queuedCount ?? 0) >= 2) return { userId, skipped: "already_busy" };

  // 2. Context — strategy + trades + gate reasons + PERSISTENT MEMORY.
  // Memory is the source of truth for "what have we already tried" so the
  // copilot stops grinding the same parameter to dust.
  const [{ data: strategy }, { data: trades }, { data: sys }, { data: memory }] = await Promise.all([
    admin.from("strategies").select("id,version,name,params,metrics")
      .eq("user_id", userId).eq("status", "approved")
      .order("updated_at", { ascending: false }).maybeSingle(),
    admin.from("trades").select("symbol,side,outcome,pnl_pct,reason_tags,closed_at")
      .eq("user_id", userId).eq("status", "closed")
      .order("closed_at", { ascending: false }).limit(50),
    admin.from("system_state").select("last_engine_snapshot").eq("user_id", userId).maybeSingle(),
    admin.from("copilot_memory").select("*").eq("user_id", userId),
  ]);
  if (!strategy) return { userId, skipped: "no_approved_strategy" };

  const params: Array<{ key: string; value: number | string | boolean }> = (strategy.params ?? []) as any;
  const tweakable = params.filter((p) => TWEAKABLE.includes(p.key as any) && typeof p.value === "number");
  if (tweakable.length === 0) return { userId, skipped: "no_tweakable_params" };

  // Hard-block parameter+direction combos still on cooldown — these never
  // even get shown to the AI as candidates.
  const now = new Date();
  const onCooldown = new Set(
    (memory ?? [])
      .filter((m: any) => m.retry_after && new Date(m.retry_after) > now)
      .map((m: any) => `${m.parameter}:${m.direction}`)
  );

  const recentGates = ((sys?.last_engine_snapshot as any)?.gateReasons ?? [])
    .slice(0, 5)
    .map((g: any) => ({ code: g.code, message: g.message }));

  const wins = (trades ?? []).filter((t: any) => t.outcome === "win").length;
  const losses = (trades ?? []).filter((t: any) => t.outcome === "loss").length;

  const whatWeKnow = (memory ?? []).map((m: any) => ({
    parameter: m.parameter,
    direction: m.direction,
    triedTimes: m.attempt_count,
    lastOutcome: m.outcome,
    expDelta: m.exp_delta,
    onCooldownUntil: m.retry_after?.slice(0, 10) ?? null,
  }));

  const contextPacket = {
    strategy: { name: strategy.name, version: strategy.version, currentParams: tweakable },
    recentTrades: {
      total: trades?.length ?? 0, wins, losses,
      lastFew: (trades ?? []).slice(0, 8).map((t: any) => ({
        symbol: t.symbol, side: t.side, outcome: t.outcome, pnlPct: t.pnl_pct, tags: t.reason_tags,
      })),
    },
    recentGateReasons: recentGates,
    persistentMemory: {
      summary: whatWeKnow,
      onCooldown: Array.from(onCooldown),
      instructions: [
        "persistentMemory.onCooldown lists parameter:direction combos you MUST NOT propose — they are on cooldown because they showed no improvement or were rejected.",
        "persistentMemory.summary shows what each direction has already produced. Do NOT re-propose a direction that already showed noise (expDelta near 0) or rejection.",
        "Actively diversify: if stop_atr_mult has been tried many times, explore ema_fast, ema_slow, rsi_period, or tp_r_mult instead.",
        "If a parameter has been tried in both directions and both failed, leave it alone entirely this round.",
      ].join(" "),
    },
    proposalInstructions: "Pick exactly ONE parameter from currentParams that is NOT on cooldown and has NOT already been exhausted. Propose a meaningful adjustment (10-30% change). Hypothesis must be specific and grounded in recent trades or gate reasons.",
  };

  // 3. AI tool call
  const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: "You are the Trader OS R&D Copilot. You propose small, testable parameter tweaks based on observed strategy behavior. One knob at a time. Hypothesis must be specific (e.g. 'recent losses cluster in chop — wider stops would reduce noise-stops')." },
        { role: "user", content: `Propose ONE parameter to test based on this context:\n${JSON.stringify(contextPacket, null, 2)}` },
      ],
      tools: [{
        type: "function",
        function: {
          name: "propose_experiment",
          description: "Propose a single-parameter experiment to test.",
          parameters: {
            type: "object",
            properties: {
              parameter: { type: "string", description: `One of: ${TWEAKABLE.join(", ")}` },
              before: { type: "number" },
              after: { type: "number" },
              hypothesis: { type: "string", description: "1-2 sentences. Why this change might help, grounded in the recent trades or gate reasons." },
              expected_effect: { type: "string", description: "What metric you'd expect to move and which direction (e.g. 'win rate +2-5%, expectancy roughly flat')." },
              title: { type: "string", description: "Short headline like 'Widen stop_atr_mult 1.5 → 1.8'." },
            },
            required: ["parameter", "before", "after", "hypothesis", "expected_effect", "title"],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "propose_experiment" } },
    }),
  });

  if (!aiResp.ok) {
    const t = await aiResp.text().catch(() => "");
    console.error("AI gateway error", aiResp.status, t);
    return { userId, error: "ai_error", status: aiResp.status };
  }
  const aiJson = await aiResp.json();
  const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return { userId, error: "no_tool_call" };
  let args: any;
  try { args = JSON.parse(toolCall.function.arguments); } catch { return { userId, error: "parse_error" }; }

  // Validate the picked parameter actually exists in the strategy
  const existing = tweakable.find((p) => p.key === args.parameter);
  if (!existing) return { userId, error: "invalid_param", picked: args.parameter };

  const beforeVal = String(existing.value);
  const afterVal = String(args.after);
  const deltaNum = Number(args.after) - Number(existing.value);
  const deltaStr = (deltaNum >= 0 ? "+" : "") + deltaNum.toFixed(3).replace(/\.?0+$/, "");

  const { error: insErr } = await admin.from("experiments").insert({
    user_id: userId,
    title: args.title,
    parameter: args.parameter,
    before_value: beforeVal,
    after_value: afterVal,
    delta: deltaStr,
    status: "queued",
    proposed_by: "copilot",
    hypothesis: args.hypothesis + (args.expected_effect ? `\n\nExpected: ${args.expected_effect}` : ""),
    strategy_id: strategy.id,
  });
  if (insErr) {
    console.error("insert experiment failed", insErr);
    return { userId, error: "insert_error" };
  }
  return { userId, proposed: args.parameter };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) return json({ error: "LOVABLE_API_KEY not configured" }, 500);

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Auth: cron token OR user JWT (single-user manual trigger)
    const authHeader = req.headers.get("Authorization") ?? "";
    let userIds: string[] = [];

    // Try cron token
    const { data: cronTokenData } = await admin.rpc("get_signal_engine_cron_token");
    const cronToken = (cronTokenData as string | null) ?? null;
    const isCron = cronToken && authHeader === `Bearer ${cronToken}`;

    if (isCron) {
      const { data: users } = await admin.from("system_state").select("user_id");
      userIds = (users ?? []).map((u: any) => u.user_id);
    } else {
      // User JWT path
      const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const token = authHeader.replace("Bearer ", "");
      const { data: userData, error: userErr } = await userClient.auth.getUser(token);
      if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
      userIds = [userData.user.id];
    }

    const results = await Promise.all(userIds.map((uid) => proposeForUser(admin, uid, LOVABLE_API_KEY).catch((e) => ({ userId: uid, error: String(e) }))));
    return json({ ok: true, processed: userIds.length, results }, 200);
  } catch (e) {
    console.error("propose-experiment error", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
