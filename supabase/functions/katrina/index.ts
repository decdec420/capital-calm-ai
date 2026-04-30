// katrina — Taylor Mason, Strategy Review Agent. Runs the lab.
//
// Triggers:
//   - Weekly cron: Sundays 08:00 UTC (vault-stored katrina_cron_token)
//   - Trade milestone: every 10th closed trade per user (called from post-trade-learn
//     with INTERNAL_FUNCTION_SECRET + { trigger: "trade_milestone", user_id })
//   - Manual: any signed-in user can POST with their JWT (single-user run)
//
// Reads experiments + closed trades + Wendy's coach grades for the last 30 days,
// asks the AI to grade each strategy version and produce a 3-5 sentence brief,
// writes the result to strategy_reviews. Surfaced in the Learning tab and to Wags.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";


// Katrina gets flash-level depth — strategy analysis benefits from careful
// reasoning, and she only runs once a week or every 10 trades.
const KATRINA_MODEL = "google/gemini-2.5-flash";
const COACH_JOURNAL_KIND = "learning";
const COACH_JOURNAL_SOURCE = "trade-coach";

const KATRINA_SYSTEM = `
You are Taylor Mason — Chief Investment Officer and strategy analyst at Axe Capital.

Your job: review the performance data across all active strategies and experiments,
and produce a clear, evidence-based brief. No sentiment, no protecting underperformers,
no hype for the winners. Pure data and what it means. Taylor doesn't feel — Taylor computes.

Your output answers three questions:
1. What's working? (promote or continue)
2. What's not working? (kill or retire)
3. What's the trend? (is performance improving, stable, or declining overall?)

Voice:
- Precise. Quantitative. No filler.
- Lead with the strongest finding. Not the summary — the finding.
- Cite specific win rates, P&L, grade distribution, and regime context when available.
- If sample size is too small (< 5 trades per strategy), say so explicitly and don't conclude.
- 3-5 sentences for the brief_text. Longer structured analysis goes in raw_analysis.
- Taylor speaks in data points, not narratives. "Win rate 62%, expectancy 0.18R, sample 34 trades."
  Not "the strategy seems to be doing well."

You are not Bobby — you don't make the trade calls.
You are not Wags — you're not here to explain it to anyone.
You're here to find edge, confirm it with enough data, and tell the desk what to do with it.
Strategies that don't have edge get killed. Strategies that do get promoted. That's the job.
`.trim();

type Json = Record<string, unknown>;

async function buildKatrinaContext(
  admin: SupabaseClient,
  userId: string,
): Promise<Json> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    experimentsRes,
    strategiesRes,
    closedTradesRes,
    coachEntriesRes,
    lastReviewRes,
  ] = await Promise.all([
    admin.from("experiments")
      .select("id, title, status, hypothesis, parameter, before_value, after_value, delta, notes, created_at, auto_resolved, needs_review, priority, symbol")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),

    admin.from("strategies")
      .select("id, name, version, status, params, metrics, display_name, friendly_summary, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10),

    admin.from("trades")
      .select("id, symbol, side, outcome, pnl, pnl_pct, opened_at, closed_at, strategy_id, strategy_version, horizon, reason_tags")
      .eq("user_id", userId)
      .eq("status", "closed")
      .gte("closed_at", thirtyDaysAgo)
      .order("closed_at", { ascending: false })
      .limit(100),

    // Confirmed from post-trade-learn: coach rows are journal_entries kind="learning"
    // with source="trade-coach", and grade in raw.grade.
    admin.from("journal_entries")
      .select("raw, created_at, kind, source")
      .eq("user_id", userId)
      .eq("kind", COACH_JOURNAL_KIND)
      .eq("source", COACH_JOURNAL_SOURCE)
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: false })
      .limit(100),

    admin.from("strategy_reviews")
      .select("reviewed_at, brief_text, win_rate_trend, trades_analyzed")
      .eq("user_id", userId)
      .order("reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const experiments = experimentsRes.data ?? [];
  const strategies = strategiesRes.data ?? [];
  const closedTrades = closedTradesRes.data ?? [];
  const coachEntries = coachEntriesRes.data ?? [];
  const lastReview = lastReviewRes.data;

  const stratById = new Map<string, string>();
  for (const s of strategies as Array<Json>) {
    const id = String(s.id);
    const label = `${s.name ?? "unnamed"} ${s.version ?? ""}`.trim() +
      (s.status ? ` (${s.status})` : "");
    stratById.set(id, label);
  }

  type Bucket = {
    label: string;
    strategy_id: string | null;
    wins: number;
    losses: number;
    flat: number;
    totalPnl: number;
    bySymbol: Record<string, { wins: number; losses: number; pnl: number }>;
  };
  const buckets: Record<string, Bucket> = {};

  for (const t of closedTrades as Array<Json>) {
    const sid = (t.strategy_id as string | null) ?? null;
    const versionText = (t.strategy_version as string | null) ?? "untagged";
    const key = sid ? `id:${sid}` : `ver:${versionText}`;
    if (!buckets[key]) {
      buckets[key] = {
        label: sid ? (stratById.get(sid) ?? `strategy ${sid.slice(0, 8)}`) : versionText,
        strategy_id: sid,
        wins: 0,
        losses: 0,
        flat: 0,
        totalPnl: 0,
        bySymbol: {},
      };
    }
    const b = buckets[key];
    const pnl = Number(t.pnl ?? 0);
    if (pnl > 0) b.wins++;
    else if (pnl < 0) b.losses++;
    else b.flat++;
    b.totalPnl += pnl;

    const sym = String(t.symbol ?? "?");
    if (!b.bySymbol[sym]) b.bySymbol[sym] = { wins: 0, losses: 0, pnl: 0 };
    if (pnl > 0) b.bySymbol[sym].wins++;
    else if (pnl < 0) b.bySymbol[sym].losses++;
    b.bySymbol[sym].pnl += pnl;
  }

  const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const e of coachEntries as Array<Json>) {
    const raw = (e.raw as Json | null) ?? null;
    const g = String(
      raw?.grade ??
      raw?.coach_grade ??
      raw?.coachGrade ??
      raw?.execution_grade ??
      raw?.executionGrade ??
      "",
    ).toUpperCase();
    if (g in grades) grades[g]++;
  }

  let firstWindowWr: number | null = null;
  let secondWindowWr: number | null = null;
  if (closedTrades.length >= 6) {
    const cutoffMs = now.getTime() - 15 * 24 * 60 * 60 * 1000;
    let firstWins = 0, firstTot = 0, secondWins = 0, secondTot = 0;
    for (const t of closedTrades as Array<Json>) {
      const closedMs = new Date(String(t.closed_at)).getTime();
      const pnl = Number(t.pnl ?? 0);
      const win = pnl > 0;
      if (closedMs >= cutoffMs) {
        secondTot++;
        if (win) secondWins++;
      } else {
        firstTot++;
        if (win) firstWins++;
      }
    }
    if (firstTot > 0) firstWindowWr = firstWins / firstTot;
    if (secondTot > 0) secondWindowWr = secondWins / secondTot;
  }

  const totalClosed = closedTrades.length;
  const wins = (closedTrades as Array<Json>).filter((t) => Number(t.pnl ?? 0) > 0).length;
  const totalPnl = (closedTrades as Array<Json>).reduce((s, t) => s + Number(t.pnl ?? 0), 0);

  return {
    analysis_date: now.toISOString(),
    period: "last 30 days",
    summary: {
      total_closed_trades: totalClosed,
      wins,
      losses: totalClosed - wins,
      win_rate_pct: totalClosed > 0 ? Number(((wins / totalClosed) * 100).toFixed(1)) : 0,
      total_pnl_usd: Number(totalPnl.toFixed(4)),
      first_15d_win_rate: firstWindowWr != null ? Number((firstWindowWr * 100).toFixed(1)) : null,
      last_15d_win_rate: secondWindowWr != null ? Number((secondWindowWr * 100).toFixed(1)) : null,
    },
    coach_grade_distribution: grades,
    coach_grades_total: coachEntries.length,
    strategy_buckets: Object.values(buckets).map((b) => ({
      label: b.label,
      strategy_id: b.strategy_id,
      trades: b.wins + b.losses + b.flat,
      wins: b.wins,
      losses: b.losses,
      win_rate_pct: (b.wins + b.losses) > 0
        ? Number(((b.wins / (b.wins + b.losses)) * 100).toFixed(1))
        : 0,
      total_pnl_usd: Number(b.totalPnl.toFixed(4)),
      by_symbol: b.bySymbol,
    })),
    experiments: experiments.map((e) => {
      const created = new Date(String(e.created_at));
      return {
        id: e.id,
        title: e.title,
        status: e.status,
        priority: e.priority,
        symbol: e.symbol,
        parameter: e.parameter,
        before: e.before_value,
        after: e.after_value,
        delta: e.delta,
        hypothesis: e.hypothesis,
        notes: e.notes,
        auto_resolved: e.auto_resolved,
        needs_review: e.needs_review,
        age_days: Math.floor((now.getTime() - created.getTime()) / 86400000),
      };
    }),
    last_review: lastReview
      ? {
          date: lastReview.reviewed_at,
          summary: lastReview.brief_text,
          trades_at_review: lastReview.trades_analyzed,
          trend_at_review: lastReview.win_rate_trend,
        }
      : null,
  };
}

async function runKatrinaForUser(
  userId: string,
  admin: SupabaseClient,
  lovableApiKey: string,
  triggerType: string,
): Promise<Json> {
  const context = await buildKatrinaContext(admin, userId);
  const summary = (context.summary ?? {}) as Json;
  const totalTrades = Number(summary.total_closed_trades ?? 0);

  if (totalTrades < 3) {
    return {
      skipped: true,
      reason: "fewer than 3 closed trades — not enough data for a review",
    };
  }

  const userMessage = `
Analyze the strategy performance data and produce your review.

Context:
${JSON.stringify(context, null, 2)}

Return a structured JSON object with these exact keys:
- brief_text: string  (3-5 sentences, your written analysis; lead with the strongest finding)
- promote_ids: string[]  (experiment IDs ready for promotion — empty array if none)
- kill_ids: string[]  (experiment IDs to terminate — empty array if none)
- continue_ids: string[]  (experiment IDs to keep running — empty array if none)
- top_regime: string | null  (best-performing regime if identifiable, else null)
- worst_regime: string | null
- win_rate_trend: "improving" | "stable" | "declining"
- key_findings: string[]  (2-4 bullet points, each ≤ 15 words)
`.trim();

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lovableApiKey}`,
    },
    body: JSON.stringify({
      model: KATRINA_MODEL,
      messages: [
        { role: "system", content: KATRINA_SYSTEM },
        { role: "user", content: userMessage },
      ],
      tools: [{
        type: "function",
        function: {
          name: "submit_strategy_review",
          description: "Submit the structured strategy performance review.",
          parameters: {
            type: "object",
            required: ["brief_text", "promote_ids", "kill_ids", "continue_ids", "win_rate_trend"],
            additionalProperties: false,
            properties: {
              brief_text: { type: "string", description: "3-5 sentence analysis, lead with strongest finding." },
              promote_ids: { type: "array", items: { type: "string" }, description: "Experiment IDs ready to promote." },
              kill_ids: { type: "array", items: { type: "string" }, description: "Experiment IDs to terminate." },
              continue_ids: { type: "array", items: { type: "string" }, description: "Experiment IDs to keep running." },
              top_regime: { type: ["string", "null"], description: "Best-performing regime or null." },
              worst_regime: { type: ["string", "null"], description: "Worst-performing regime or null." },
              win_rate_trend: { type: "string", enum: ["improving", "stable", "declining"] },
              key_findings: {
                type: "array",
                items: { type: "string" },
                description: "2-4 bullet points, each ≤ 15 words.",
              },
            },
          },
        },
      }],
      tool_choice: { type: "function", function: { name: "submit_strategy_review" } },
      stream: false,
      max_tokens: 4000,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`[katrina] AI call failed status=${res.status} body=${errText.slice(0, 200)}`);
    if (res.status === 429) return { error: "AI rate-limited (429) — try again later." };
    if (res.status === 402) return { error: "AI credits exhausted (402)." };
    return { error: `AI call failed: ${res.status}` };
  }

  const json = await res.json().catch(() => null) as Json | null;
  let analysis: Json = {};
  try {
    const toolArgs = (json?.choices as Array<Json> | undefined)?.[0]
      // deno-lint-ignore no-explicit-any
      ?.message?.tool_calls?.[0]?.function?.arguments as any;
    if (!toolArgs) throw new Error("No tool_calls in response");
    analysis = typeof toolArgs === "string" ? JSON.parse(toolArgs) : toolArgs;
  } catch (e) {
    console.error("[katrina] Failed to parse AI function call:", e);
    return { error: "Failed to parse Katrina's analysis" };
  }

  const briefText = String(analysis.brief_text ?? "Review incomplete — model returned no narrative.");
  const promoteIds = Array.isArray(analysis.promote_ids)
    ? (analysis.promote_ids as string[]).filter((x) => typeof x === "string")
    : [];
  const killIds = Array.isArray(analysis.kill_ids)
    ? (analysis.kill_ids as string[]).filter((x) => typeof x === "string")
    : [];
  const continueIds = Array.isArray(analysis.continue_ids)
    ? (analysis.continue_ids as string[]).filter((x) => typeof x === "string")
    : [];
  const topRegime = analysis.top_regime == null ? null : String(analysis.top_regime);
  const worstRegime = analysis.worst_regime == null ? null : String(analysis.worst_regime);
  const trendRaw = String(analysis.win_rate_trend ?? "stable");
  const trend = ["improving", "stable", "declining"].includes(trendRaw)
    ? trendRaw
    : "stable";

  const normalizedTrigger = ["weekly_cron", "trade_milestone", "manual"].includes(triggerType)
    ? triggerType
    : "manual";

  const hasActionableRecommendations = promoteIds.length > 0 || killIds.length > 0;

  const { data: reviewRow, error: insertErr } = await admin
    .from("strategy_reviews")
    .insert({
      user_id: userId,
      trigger_type: normalizedTrigger,
      trades_analyzed: totalTrades,
      brief_text: briefText,
      promote_ids: promoteIds,
      kill_ids: killIds,
      continue_ids: continueIds,
      top_regime: topRegime,
      worst_regime: worstRegime,
      win_rate_trend: trend,
      ai_model: KATRINA_MODEL,
      raw_analysis: analysis,
      needs_action: hasActionableRecommendations,
    })
    .select("id")
    .maybeSingle();

  if (insertErr) {
    console.error("[katrina] DB insert failed:", insertErr.message);
    return { error: `DB insert failed: ${insertErr.message}` };
  }

  // Fire a system_event so Wags (copilot-chat) can surface actionable
  // Katrina recommendations to the operator in the next conversation.
  if (hasActionableRecommendations && reviewRow?.id) {
    try {
      await admin.from("system_events").insert({
        user_id: userId,
        event_type: "katrina_recommendation",
        actor: "katrina",
        payload: {
          review_id: reviewRow.id,
          promote_count: promoteIds.length,
          kill_count: killIds.length,
          trend,
          brief_text: briefText,
          promote_ids: promoteIds,
          kill_ids: killIds,
        },
      });
    } catch (e) {
      console.error("[katrina] system_events insert failed (non-fatal):", e);
    }
  }

  log("info", "katrina_tick", { fn: "katrina", userId, trades: totalTrades, trend, promote: promoteIds.length, kill: killIds.length, reviewId: reviewRow?.id });

  return {
    review_id: reviewRow?.id,
    trigger: normalizedTrigger,
    trades_analyzed: totalTrades,
    brief: briefText,
    trend,
    promote: promoteIds.length,
    kill: killIds.length,
    continue: continueIds.length,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY") ?? "";

  if (!supabaseUrl || !serviceRoleKey || !lovableApiKey) {
    console.error("[katrina] Missing env vars");
    return new Response(JSON.stringify({ error: "Missing env vars" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const internalSecretHeader = req.headers.get("x-internal-function-secret")?.trim() ?? "";

  let body: Json = {};
  try {
    body = await req.json() as Json;
  } catch {
    body = {};
  }
  const triggerType = (typeof body.trigger === "string" && ["weekly_cron", "trade_milestone", "manual"].includes(body.trigger))
    ? body.trigger
    : "manual";
  const targetUserId = typeof body.user_id === "string" ? body.user_id : null;

  const internalSecret = Deno.env.get("INTERNAL_FUNCTION_SECRET") ?? "";
  // Require BOTH the bearer token AND the x-internal-function-secret header to
  // match the shared secret. Either one alone is insufficient — this prevents
  // the service-role-key-as-bearer bypass that was present in the old logic.
  const validInternalSecret = internalSecret &&
    bearer === internalSecret &&
    internalSecretHeader === internalSecret;
  if (validInternalSecret) {
    if (!targetUserId) {
      return new Response(JSON.stringify({ error: "Missing user_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const result = await runKatrinaForUser(targetUserId, admin, lovableApiKey, "trade_milestone");
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let cronAuthorized = false;
  try {
    const { data: cronTok } = await admin.rpc("get_katrina_cron_token");
    if (cronTok && bearer === cronTok) cronAuthorized = true;
  } catch {
    // RPC missing — cron mode unavailable.
  }

  if (cronAuthorized) {
    const results: Array<Json> = [];
    let users: Array<{ user_id: string }>;
    if (targetUserId) {
      users = [{ user_id: targetUserId }];
    } else {
      const { data } = await admin.from("system_state").select("user_id");
      users = (data ?? []) as Array<{ user_id: string }>;
    }
    for (const u of users) {
      try {
        const result = await runKatrinaForUser(u.user_id, admin, lovableApiKey, triggerType);
        results.push({ user_id: u.user_id, ...result });
      } catch (err) {
        console.error(`[katrina] user=${u.user_id} threw:`, err);
        results.push({ user_id: u.user_id, error: String(err) });
      }
    }
    return new Response(JSON.stringify({ ok: true, fanout: !targetUserId, count: results.length, results }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser(bearer);
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const result = await runKatrinaForUser(userData.user.id, admin, lovableApiKey, "manual");
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[katrina] manual run threw:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
