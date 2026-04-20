// Trader OS — AI Copilot edge function
// Streams from Lovable AI Gateway. Injects current system context as system prompt.
// Auth: validates Supabase JWT in-function (verify_jwt = false at gateway).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

// Hard limits to prevent credit-drain abuse
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 8000;
const ALLOWED_ROLES = new Set(["user", "assistant", "system"]);

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

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // --- AuthN: validate JWT in-function (verify_jwt = false at gateway) ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY env");
      return json({ error: "Internal server error" }, 500);
    }
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return json({ error: "Unauthorized" }, 401);
    }

    // --- Input validation ---
    let payload: { messages?: unknown; context?: unknown };
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const { messages, context } = payload;

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "messages must be a non-empty array" }, 400);
    }
    if (messages.length > MAX_MESSAGES) {
      return json({ error: `Too many messages (max ${MAX_MESSAGES})` }, 400);
    }

    const cleanMessages: ChatMessage[] = [];
    for (const m of messages) {
      if (!m || typeof m !== "object") {
        return json({ error: "Invalid message entry" }, 400);
      }
      const { role, content } = m as { role?: unknown; content?: unknown };
      if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
        return json({ error: "Invalid message role" }, 400);
      }
      if (typeof content !== "string") {
        return json({ error: "Message content must be a string" }, 400);
      }
      if (content.length > MAX_MESSAGE_CHARS) {
        return json({ error: `Message exceeds ${MAX_MESSAGE_CHARS} chars` }, 400);
      }
      cleanMessages.push({ role: role as ChatMessage["role"], content });
    }

    let safeContext: Record<string, unknown> | undefined;
    if (context !== undefined && context !== null) {
      if (typeof context !== "object" || Array.isArray(context)) {
        return json({ error: "context must be an object" }, 400);
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(context);
      } catch {
        return json({ error: "context is not serializable" }, 400);
      }
      if (serialized.length > MAX_CONTEXT_CHARS) {
        return json({ error: `context exceeds ${MAX_CONTEXT_CHARS} chars` }, 400);
      }
      safeContext = context as Record<string, unknown>;
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY not configured");
      return json({ error: "Internal server error" }, 500);
    }

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [{ role: "system", content: buildSystemPrompt(safeContext) }, ...cleanMessages],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return json({ error: "Rate limit reached. Give it a moment, then try again." }, 429);
      }
      if (response.status === 402) {
        return json({ error: "AI credits depleted. Top up in Settings → Workspace → Usage." }, 402);
      }
      const text = await response.text();
      console.error("Gateway error", response.status, text);
      return json({ error: "AI gateway error" }, 500);
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("copilot-chat error", e);
    return json({ error: "Internal server error" }, 500);
  }
});
