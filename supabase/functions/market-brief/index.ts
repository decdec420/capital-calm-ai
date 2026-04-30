// market-brief edge function — generates a terse trader brief using Lovable AI.
// Reads the caller's recent trades + journals via service-role, plus client-supplied
// market context (regime + recent candles), and returns a 2-3 sentence brief.
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { corsHeaders } from "../_shared/cors.ts";


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Validate JWT and get user
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.0");
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
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const { regime, lastPrice, pctChange, openTradesCount } = body ?? {};

    // Fetch recent journals via service role
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Rate limit: 10 req / 60s per user
    const rl = await checkRateLimit(admin, userId, "market-brief", 10);
    if (!rl.allowed) return rateLimitResponse(rl, corsHeaders);

    const { data: journals } = await admin
      .from("journal_entries")
      .select("kind,title,summary,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(5);
    const { data: closedTrades } = await admin
      .from("trades")
      .select("symbol,side,pnl_pct,outcome,closed_at")
      .eq("user_id", userId)
      .eq("status", "closed")
      .order("closed_at", { ascending: false })
      .limit(5);

    const context = `
MARKET CONTEXT
- Regime: ${regime ?? "unknown"}
- Last price: $${lastPrice ?? "?"}
- Change over window: ${pctChange ?? "?"}%
- Open positions: ${openTradesCount ?? 0}

RECENT JOURNALS
${(journals ?? []).map((j: any) => `- [${j.kind}] ${j.title}: ${j.summary}`).join("\n") || "- (none)"}

RECENT CLOSED TRADES
${(closedTrades ?? []).map((t: any) => `- ${t.side} ${t.symbol} ${t.outcome} ${t.pnl_pct ?? 0}%`).join("\n") || "- (none yet)"}
`.trim();

    // Hard 25s timeout so we never sit on the 150s idle limit
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
          model: "google/gemini-2.5-flash-lite",
          messages: [
            {
              role: "system",
              content:
                "You are the Trader OS market brief. Be terse, witty, and risk-first. 2-3 sentences max. No emojis. Use trader vernacular but stay precise. If the setup is weak, say sit on hands. Do not invent prices or stats.",
            },
            { role: "user", content: `Generate today's brief.\n\n${context}` },
          ],
        }),
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        return new Response(JSON.stringify({ error: "Brief timed out. Try again." }), {
          status: 504,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited. Try again in a moment." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add funds in Lovable Cloud." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await aiResp.text();
      console.error("AI gateway error", aiResp.status, t);
      return new Response(JSON.stringify({ error: "AI gateway failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const json = await aiResp.json();
    const brief = json.choices?.[0]?.message?.content ?? "(no brief generated)";

    return new Response(JSON.stringify({ brief }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("market-brief error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
