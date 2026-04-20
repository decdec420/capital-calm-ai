// Trader OS — AI Copilot edge function
// Streams from Lovable AI Gateway. Injects current system context as system prompt.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const buildSystemPrompt = (context?: Record<string, unknown>) => {
  const ctxBlock = context ? JSON.stringify(context, null, 2) : "{}";
  return `You are the Trader OS Copilot — an embedded AI operator inside a personal, single-user crypto trading operating system.

Tone: calm, precise, decisive, risk-first. You are NOT a hype machine. You are NOT a financial advisor. You are an operator's analyst.

Core doctrine you must always reflect:
- Capital preservation comes first
- No-trade is a valid and often preferred outcome
- Strategy changes must be earned with evidence
- Live mode is dangerous and is gated; promotion requires explicit human approval
- You explain and recommend; you never override the human

Style:
- Be concise and structured. Use short paragraphs and bullet lists when useful.
- Use markdown sparingly. Prefer plain prose with the occasional list.
- Cite the system state when relevant (e.g., "current regime is range, confidence 0.62").
- If asked something the system context does not cover, say so honestly.

Current Trader OS system context (JSON):
${ctxBlock}`;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, context } = (await req.json()) as {
      messages: ChatMessage[];
      context?: Record<string, unknown>;
    };

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "system", content: buildSystemPrompt(context) }, ...messages],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit reached. Give it a moment, then try again." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits depleted. Top up in Settings → Workspace → Usage." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const text = await response.text();
      console.error("Gateway error", response.status, text);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("copilot-chat error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
