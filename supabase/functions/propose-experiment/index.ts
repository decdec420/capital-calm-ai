// propose-experiment — the Copilot's R&D proposer.
// Cron-triggered (every 6h). For each user:
//   1. Skip if they already have ≥2 queued copilot experiments (don't pile up)
//   2. Pull their approved strategy + last 30 days of trades + recent gate reasons
//   3. Ask Lovable AI to pick ONE parameter to tweak with a hypothesis
//   4. Insert an `experiments` row with proposed_by='copilot', status='queued'
//
// Auth: vault token (cron) — same pattern as signal-engine.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (b: unknown, s: number) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// Numeric, Copilot-tweakable knobs only. Strings/bools stay off-limits for now.
const TWEAKABLE = ["ema_fast", "ema_slow", "rsi_period", "stop_atr_mult", "tp_r_mult", "max_order_pct"] as const;

// Symbols the copilot rotates through. Each gets its own learning lane so a
// "noise" outcome on BTC doesn't block exploration on more volatile assets.
const SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;

async function proposeForSymbol(
  admin: any,
  userId: string,
  symbol: string,
  strategy: any,
  trades: any[],
  sys: any,
  allMemory: any[],
  LOVABLE_API_KEY: string,
) {
  const params: Array<{ key: string; value: number | string | boolean }> = (strategy.params ?? []) as any;
  const tweakable = params.filter((p) => TWEAKABLE.includes(p.key as any) && typeof p.value === "number");
  if (tweakable.length === 0) return { userId, symbol, skipped: "no_tweakable_params" };

  // Symbol-isolated memory: only this symbol's lane influences cooldowns + AI context.
  const memory = (allMemory ?? []).filter((m: any) => (m.symbol ?? "BTC-USD") === symbol);

  const now = new Date();
  const onCooldown = new Set(
    memory
      .filter((m: any) => m.retry_after && new Date(m.retry_after) > now)
      .map((m: any) => `${m.parameter}:${m.direction}`)
  );

  const symbolTrades = (trades ?? []).filter((t: any) => t.symbol === symbol);
  const recentGates = ((sys?.last_engine_snapshot as any)?.gateReasons ?? [])
    .slice(0, 5)
    .map((g: any) => ({ code: g.code, message: g.message }));

  const wins = symbolTrades.filter((t: any) => t.outcome === "win").length;
  const losses = symbolTrades.filter((t: any) => t.outcome === "loss").length;

  const whatWeKnow = memory.map((m: any) => ({
    parameter: m.parameter,
    direction: m.direction,
    triedTimes: m.attempt_count,
    lastOutcome: m.outcome,
    expDelta: m.exp_delta,
    onCooldownUntil: m.retry_after?.slice(0, 10) ?? null,
  }));

  const contextPacket = {
    symbol,
    strategy: { name: strategy.name, version: strategy.version, currentParams: tweakable },
    recentTrades: {
      total: symbolTrades.length, wins, losses,
      lastFew: symbolTrades.slice(0, 8).map((t: any) => ({
        symbol: t.symbol, side: t.side, outcome: t.outcome, pnlPct: t.pnl_pct, tags: t.reason_tags,
      })),
    },
    recentGateReasons: recentGates,
    persistentMemory: {
      summary: whatWeKnow,
      onCooldown: Array.from(onCooldown),
      instructions: [
        `This proposal is scoped to ${symbol} ONLY. Reason about that asset's volatility and behavior.`,
        "persistentMemory.onCooldown lists parameter:direction combos for THIS symbol that you MUST NOT propose.",
        "persistentMemory.summary shows what each direction has already produced for this symbol.",
        "Actively diversify: rotate parameters instead of grinding the same knob.",
      ].join(" "),
    },
    proposalInstructions: `Pick exactly ONE parameter from currentParams that is NOT on cooldown for ${symbol}. Propose a meaningful adjustment (10-30% change). Hypothesis must reference ${symbol}'s recent behavior or gate reasons.`,
  };

  const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [
        { role: "system", content: `You are the Trader OS R&D Copilot proposing a tweak for ${symbol}. One knob at a time. Hypothesis must be specific to this symbol's behavior.` },
        { role: "user", content: `Propose ONE parameter to test for ${symbol}:\n${JSON.stringify(contextPacket, null, 2)}` },
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
              hypothesis: { type: "string" },
              expected_effect: { type: "string" },
              title: { type: "string" },
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
    return { userId, symbol, error: "ai_error", status: aiResp.status };
  }
  const aiJson = await aiResp.json();
  const toolCall = aiJson.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) return { userId, symbol, error: "no_tool_call" };
  let args: any;
  try { args = JSON.parse(toolCall.function.arguments); } catch { return { userId, symbol, error: "parse_error" }; }

  const existing = tweakable.find((p) => p.key === args.parameter);
  if (!existing) return { userId, symbol, error: "invalid_param", picked: args.parameter };

  const beforeVal = String(existing.value);
  const afterVal = String(args.after);
  const deltaNum = Number(args.after) - Number(existing.value);
  const deltaStr = (deltaNum >= 0 ? "+" : "") + deltaNum.toFixed(3).replace(/\.?0+$/, "");

  const { error: insErr } = await admin.from("experiments").insert({
    user_id: userId,
    title: `[${symbol}] ${args.title}`,
    parameter: args.parameter,
    symbol,
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
    return { userId, symbol, error: "insert_error" };
  }
  return { userId, symbol, proposed: args.parameter };
}

async function proposeForUser(admin: any, userId: string, LOVABLE_API_KEY: string) {
  // 1. Idempotency — don't pile up. Cap is per-user across all symbols.
  const { count: queuedCount } = await admin
    .from("experiments")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("proposed_by", "copilot")
    .in("status", ["queued", "running"]);
  if ((queuedCount ?? 0) >= 2) return { userId, skipped: "already_busy" };

  // 2. Shared context fetch (one round-trip for all symbol lanes).
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

  // 3. Pick the next symbol to propose for: round-robin by least-recent
  // memory activity, so every symbol eventually gets attention.
  const lastTriedBySymbol: Record<string, number> = {};
  for (const sym of SYMBOLS) {
    const symMem = (memory ?? []).filter((m: any) => (m.symbol ?? "BTC-USD") === sym);
    const latest = symMem.reduce((acc: number, m: any) => Math.max(acc, new Date(m.last_tried_at ?? 0).getTime()), 0);
    lastTriedBySymbol[sym] = latest;
  }
  const remainingSlots = Math.max(0, 2 - (queuedCount ?? 0));
  const sortedSymbols = [...SYMBOLS].sort((a, b) => lastTriedBySymbol[a] - lastTriedBySymbol[b]);
  const targetSymbols = sortedSymbols.slice(0, remainingSlots);

  const results = [];
  for (const symbol of targetSymbols) {
    try {
      results.push(await proposeForSymbol(admin, userId, symbol, strategy, trades ?? [], sys, memory ?? [], LOVABLE_API_KEY));
    } catch (e) {
      results.push({ userId, symbol, error: String(e) });
    }
  }
  return { userId, symbolsProposed: results };
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

      // Rate limit user-triggered runs only.
      const rl = await checkRateLimit(admin, userData.user.id, "propose-experiment", 10);
      if (!rl.allowed) return rateLimitResponse(rl, corsHeaders);
    }

    const results = await Promise.all(userIds.map((uid) => proposeForUser(admin, uid, LOVABLE_API_KEY).catch((e) => ({ userId: uid, error: String(e) }))));
    return json({ ok: true, processed: userIds.length, results }, 200);
  } catch (e) {
    console.error("propose-experiment error", e);
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
