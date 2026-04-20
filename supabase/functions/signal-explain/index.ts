// signal-explain — deep-dive AI reasoning for a single trade signal.
// Pulls the signal + its context_snapshot and asks the model for a longer,
// structured rationale. Caches the result back to decision_reason so we
// don't burn credits re-explaining.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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

    const { signalId, force } = await req.json();
    if (!signalId || typeof signalId !== "string") {
      return new Response(JSON.stringify({ error: "signalId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: signal, error: sigErr } = await admin
      .from("trade_signals")
      .select("*")
      .eq("id", signalId)
      .eq("user_id", userId)
      .maybeSingle();

    if (sigErr || !signal) {
      return new Response(JSON.stringify({ error: "Signal not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cache: if we already wrote a deep explanation, return it unless forced.
    const cached = signal.context_snapshot?.deep_explanation as string | undefined;
    if (cached && !force) {
      return new Response(JSON.stringify({ explanation: cached, cached: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ctx = signal.context_snapshot ?? {};
    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          {
            role: "system",
            content:
              "You are the Trader OS Signal Engine, doing a post-hoc deep-dive on a trade proposal you generated. " +
              "Walk the operator through your thinking in 4 short sections, each with a bold header on its own line:\n\n" +
              "**Setup** — what pattern/regime triggered the idea (1-2 sentences).\n" +
              "**Edge** — why this has positive expectancy right now (1-2 sentences).\n" +
              "**Risk** — what would invalidate it, and why the stop is where it is (1-2 sentences).\n" +
              "**Confidence** — honest take on what could be wrong with your read (1-2 sentences).\n\n" +
              "Be sharp, witty, risk-aware. No fluff, no emojis. Markdown headers only — no bullet points.",
          },
          {
            role: "user",
            content:
              `Signal: ${String(signal.side).toUpperCase()} ${signal.symbol} @ $${Number(signal.proposed_entry).toFixed(2)}\n` +
              `Stop: ${signal.proposed_stop ? `$${Number(signal.proposed_stop).toFixed(2)}` : "none"} · ` +
              `Target: ${signal.proposed_target ? `$${Number(signal.proposed_target).toFixed(2)}` : "none"}\n` +
              `Confidence: ${(Number(signal.confidence) * 100).toFixed(0)}% · Setup score: ${Number(signal.setup_score).toFixed(2)}\n` +
              `Regime: ${signal.regime}\n` +
              `Size: $${Number(signal.size_usd).toFixed(0)} (${(Number(signal.size_pct) * 100).toFixed(2)}% of equity)\n\n` +
              `Original short reasoning:\n${signal.ai_reasoning}\n\n` +
              `Context snapshot (market state when proposed):\n${JSON.stringify(ctx, null, 2)}`,
          },
        ],
      }),
    });

    if (!aiResp.ok) {
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited. Try again in a moment." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted." }), {
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
    const explanation = json.choices?.[0]?.message?.content ?? "(no explanation)";

    // Persist to context_snapshot.deep_explanation so it's free next time.
    const newCtx = { ...ctx, deep_explanation: explanation, deep_explanation_at: new Date().toISOString() };
    await admin
      .from("trade_signals")
      .update({ context_snapshot: newCtx })
      .eq("id", signalId)
      .eq("user_id", userId);

    return new Response(JSON.stringify({ explanation, cached: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("signal-explain error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
