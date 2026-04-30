// daily-brief edge function — pre-market summary generator.
// Writes one row per (user_id, brief_date) into public.daily_briefs.
//
// Two invocation modes:
//   1. JWT (UI "Generate now") — { } body, generates for current user only.
//   2. Cron token (vault "daily_brief_cron_token") — { fanout: true } body,
//      iterates every user with system_state and generates today's brief.
//
// Aggregates:
//   - account_state (equity, floor, start-of-day equity)
//   - yesterday's closed trades (P&L recap)
//   - latest market_intelligence per whitelisted symbol (macro/sentiment)
//   - active news_flags across all symbols (caution_flags)
// Produces:
//   - 3-4 sentence terse brief (Lovable AI)
//   - session_bias: "risk_on" | "risk_off" | "neutral" | "caution"
//   - key_levels: per-symbol { support, resistance } from latest intel
//   - watch_symbols: whitelisted symbols with tradable regime today
//   - caution_flags: dedup'd active news flag labels

import { SYMBOL_WHITELIST } from "../_shared/doctrine.ts";
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { corsHeaders } from "../_shared/cors.ts";


const BRIEF_MODEL = "google/gemini-2.5-flash";

// deno-lint-ignore no-explicit-any
type Admin = any;

interface BriefResult {
  briefText: string;
  sessionBias: "risk_on" | "risk_off" | "neutral" | "caution";
  keyLevels: Record<string, { support: number | null; resistance: number | null }>;
  watchSymbols: string[];
  cautionFlags: string[];
  aiModel: string;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUtcRange(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function buildBriefForUser(
  admin: Admin,
  userId: string,
  LOVABLE_API_KEY: string,
): Promise<BriefResult> {
  const { start: yStart, end: yEnd } = yesterdayUtcRange();

  const [
    { data: acct },
    { data: closedYesterday },
    { data: openTrades },
    { data: intel },
  ] = await Promise.all([
    admin.from("account_state").select("equity,balance_floor,start_of_day_equity,base_currency").eq("user_id", userId).maybeSingle(),
    admin
      .from("trades")
      .select("symbol,side,pnl,pnl_pct,outcome,closed_at")
      .eq("user_id", userId)
      .eq("status", "closed")
      .gte("closed_at", yStart)
      .lt("closed_at", yEnd)
      .order("closed_at", { ascending: false }),
    admin
      .from("trades")
      .select("symbol,side,entry_price,size,unrealized_pnl,unrealized_pnl_pct")
      .eq("user_id", userId)
      .eq("status", "open"),
    admin
      .from("market_intelligence")
      .select(
        "symbol,macro_bias,macro_confidence,market_phase,trend_structure,nearest_support,nearest_resistance,sentiment_summary,fear_greed_score,fear_greed_label,funding_rate_signal,environment_rating,news_flags,generated_at",
      )
      .eq("user_id", userId),
  ]);

  // Aggregate caution flags from active news_flags across symbols.
  const cautionSet = new Set<string>();
  // deno-lint-ignore no-explicit-any
  const intelBySymbol: Record<string, any> = {};
  for (const row of (intel ?? []) as Array<Record<string, unknown>>) {
    intelBySymbol[row.symbol as string] = row;
    const flags = Array.isArray(row.news_flags) ? row.news_flags : [];
    for (const f of flags) {
      if (!f || typeof f !== "object") continue;
      const flag = f as { label?: string; severity?: string; active?: boolean };
      if (flag.active !== false && flag.label) {
        cautionSet.add(
          flag.severity ? `[${flag.severity}] ${flag.label}` : flag.label,
        );
      }
    }
  }

  const watchSymbols = (SYMBOL_WHITELIST as readonly string[]).filter((s) => {
    const r = intelBySymbol[s];
    if (!r) return false;
    const phase = String(r.market_phase ?? "");
    return phase !== "unknown";
  });

  const keyLevels: Record<string, { support: number | null; resistance: number | null }> = {};
  for (const s of SYMBOL_WHITELIST) {
    const r = intelBySymbol[s];
    keyLevels[s] = {
      support: r?.nearest_support ? Number(r.nearest_support) : null,
      resistance: r?.nearest_resistance ? Number(r.nearest_resistance) : null,
    };
  }

  // Session bias derived from macro_bias confidence + caution count.
  const biases: Array<{ bias: string; conf: number }> = ((intel ?? []) as Array<Record<string, unknown>>).map((r) => ({
    bias: String(r.macro_bias ?? "neutral"),
    conf: Number(r.macro_confidence ?? 0.5),
  }));
  const bullScore = biases.filter((b) => b.bias === "bullish").reduce((a, b) => a + b.conf, 0);
  const bearScore = biases.filter((b) => b.bias === "bearish").reduce((a, b) => a + b.conf, 0);
  let sessionBias: BriefResult["sessionBias"];
  if (cautionSet.size >= 2) sessionBias = "caution";
  else if (bullScore - bearScore > 0.6) sessionBias = "risk_on";
  else if (bearScore - bullScore > 0.6) sessionBias = "risk_off";
  else sessionBias = "neutral";

  // Build context for the LLM.
  const equity = Number(acct?.equity ?? 0);
  const sodEquity = Number(acct?.start_of_day_equity ?? equity);
  const dayDeltaPct = sodEquity > 0 ? ((equity - sodEquity) / sodEquity) * 100 : 0;
  const yPnl = (closedYesterday ?? []).reduce(
    (sum: number, t: { pnl: number | null }) => sum + Number(t.pnl ?? 0),
    0,
  );
  const yWins = (closedYesterday ?? []).filter((t: { pnl: number | null }) => Number(t.pnl ?? 0) > 0).length;
  const yLosses = (closedYesterday ?? []).filter((t: { pnl: number | null }) => Number(t.pnl ?? 0) < 0).length;

  const intelLines = (SYMBOL_WHITELIST as readonly string[])
    .map((s) => {
      const r = intelBySymbol[s];
      if (!r) return `- ${s}: no intel brief`;
      return `- ${s}: ${r.macro_bias} (${(Number(r.macro_confidence) * 100).toFixed(0)}%), ${r.market_phase}, funding=${r.funding_rate_signal}, F&G=${r.fear_greed_label ?? "?"}`;
    })
    .join("\n");

  const context = `
ACCOUNT
- Equity: $${equity.toFixed(2)} (floor $${Number(acct?.balance_floor ?? 0).toFixed(2)})
- Today so far: ${dayDeltaPct >= 0 ? "+" : ""}${dayDeltaPct.toFixed(2)}%
- Open positions: ${(openTrades ?? []).length}

YESTERDAY (${yStart.slice(0, 10)})
- Closed trades: ${(closedYesterday ?? []).length} (${yWins}W / ${yLosses}L)
- Realized P&L: ${yPnl >= 0 ? "+" : ""}$${yPnl.toFixed(2)}

INTEL BRIEFS
${intelLines}

ACTIVE CAUTION FLAGS
${cautionSet.size === 0 ? "- (none)" : Array.from(cautionSet).map((f) => `- ${f}`).join("\n")}
`.trim();

  // Hard 25s timeout.
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), 25_000);

  let aiResp: Response;
  try {
    aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: BRIEF_MODEL,
        messages: [
          {
            role: "system",
            content:
              "Write like a head of desk reading out the morning brief. Sharp, specific, no filler sentences. If yesterday was flat, say flat. If today's setup is clean, say clean.\n\nYou are the Trader OS pre-market brief. Be terse, witty, risk-first. 3-4 sentences max. No emojis. Trader vernacular but precise. Reference yesterday's result if relevant. If caution flags are active, lead with them. If everything is mid, say sit on hands. Never invent prices.",
          },
          { role: "user", content: `Write today's pre-market brief.\n\n${context}` },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Brief generation timed out.");
    }
    throw err;
  }
  clearTimeout(timeoutId);

  if (!aiResp.ok) {
    const t = await aiResp.text().catch(() => "");
    if (aiResp.status === 429) throw new Error("Rate limited by AI gateway.");
    if (aiResp.status === 402) throw new Error("AI credits exhausted.");
    throw new Error(`AI gateway error ${aiResp.status}: ${t.slice(0, 200)}`);
  }

  const json = await aiResp.json();
  const briefText = json.choices?.[0]?.message?.content?.trim() ?? "(no brief generated)";

  return {
    briefText,
    sessionBias,
    keyLevels,
    watchSymbols,
    cautionFlags: Array.from(cautionSet),
    aiModel: BRIEF_MODEL,
  };
}

async function upsertBrief(
  admin: Admin,
  userId: string,
  result: BriefResult,
): Promise<void> {
  const { error } = await admin
    .from("daily_briefs")
    .upsert(
      {
        user_id: userId,
        brief_date: todayUtc(),
        brief_text: result.briefText,
        session_bias: result.sessionBias,
        key_levels: result.keyLevels,
        watch_symbols: result.watchSymbols,
        caution_flags: result.cautionFlags,
        ai_model: result.aiModel,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,brief_date" },
    );
  if (error) throw new Error(`upsert failed: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const body = await req.json().catch(() => ({}));
    const fanout = body?.fanout === true;

    // ── Cron fanout path ─────────────────────────────────────────
    if (fanout) {
      const authHeader = req.headers.get("Authorization") ?? "";
      const provided = authHeader.replace(/^Bearer\s+/i, "").trim();
      const { data: tokenRow, error: tokenErr } = await admin.rpc("get_daily_brief_cron_token");
      if (tokenErr) throw new Error(`token rpc failed: ${tokenErr.message}`);
      const expected = String(tokenRow ?? "");
      if (!expected || provided !== expected) {
        return new Response(JSON.stringify({ error: "Invalid cron token" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Iterate every user with a system_state row.
      const { data: users, error: usersErr } = await admin
        .from("system_state")
        .select("user_id");
      if (usersErr) throw new Error(`user list failed: ${usersErr.message}`);

      const summary: Array<{ userId: string; ok: boolean; error?: string }> = [];
      for (const u of (users ?? []) as Array<{ user_id: string }>) {
        try {
          const result = await buildBriefForUser(admin, u.user_id, LOVABLE_API_KEY);
          await upsertBrief(admin, u.user_id, result);
          summary.push({ userId: u.user_id, ok: true });
        } catch (e) {
          summary.push({
            userId: u.user_id,
            ok: false,
            error: e instanceof Error ? e.message : "unknown",
          });
        }
      }
      return new Response(JSON.stringify({ fanout: true, count: summary.length, summary }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Single-user JWT path ─────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rate limit single-user JWT path: 5 req / 60s
    const rl = await checkRateLimit(admin, userData.user.id, "daily-brief", 5);
    if (!rl.allowed) return rateLimitResponse(rl, corsHeaders);

    const result = await buildBriefForUser(admin, userData.user.id, LOVABLE_API_KEY);
    await upsertBrief(admin, userData.user.id, result);

    return new Response(
      JSON.stringify({
        ok: true,
        date: todayUtc(),
        brief: result.briefText,
        sessionBias: result.sessionBias,
        watchSymbols: result.watchSymbols,
        cautionFlags: result.cautionFlags,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("daily-brief error:", e);
    const msg = e instanceof Error ? e.message : "Unknown";
    const status = msg.includes("Rate limited") ? 429
      : msg.includes("credits exhausted") ? 402
      : msg.includes("timed out") ? 504
      : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
