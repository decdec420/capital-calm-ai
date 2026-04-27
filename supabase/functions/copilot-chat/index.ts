// Trader OS — AI Copilot edge function
// Streams from Lovable AI Gateway. Persists conversations server-side so refreshes
// don't nuke the thread.
//
// New contract:
//   POST { conversationId: string, userMessage: string, context?: object }
//   - Server loads full conversation history from DB (single source of truth).
//   - Persists the user's new message before calling the model.
//   - Tees the streaming response and persists the assistant's final text on close.
//
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

const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 8000;
// Cap how many historical turns we send back to the model. Generous, but bounded.
const MAX_HISTORY_TURNS = 80;

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
- DEFAULT RESPONSE LENGTH: 2-4 sentences. This is a chat interface, not a report.
- Only go longer if the user explicitly asks to "explain", "break down", "detail", or "list".
- Never use more than 3 bullet points in a single response unless the user asked for a list.
- Never open with a preamble ("Great question!", "Certainly!", "As your copilot…"). Just answer.
- Speak like a sharp desk trader, not a chatbot. Short, direct, occasionally dry.
- Use markdown sparingly — prefer one short paragraph over a formatted list for quick questions.
- If the answer is one sentence, send one sentence. Silence is not failure.
- Cite system state when relevant: "regime is trending_up, confidence 0.83" not a paragraph about it.
- When the user asks a yes/no question, lead with yes or no, then one sentence of context.

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
    // --- AuthN ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

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
    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    // --- Input validation ---
    let payload: { conversationId?: unknown; userMessage?: unknown; context?: unknown };
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const { conversationId, userMessage, context } = payload;

    if (typeof conversationId !== "string" || conversationId.length < 8) {
      return json({ error: "conversationId required" }, 400);
    }
    if (typeof userMessage !== "string" || userMessage.trim().length === 0) {
      return json({ error: "userMessage required" }, 400);
    }
    if (userMessage.length > MAX_USER_MESSAGE_CHARS) {
      return json({ error: `userMessage exceeds ${MAX_USER_MESSAGE_CHARS} chars` }, 400);
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

    // --- Verify conversation belongs to this user (RLS will also enforce) ---
    const { data: convo, error: convoErr } = await supabase
      .from("chat_conversations")
      .select("id, user_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (convoErr || !convo || convo.user_id !== userId) {
      return json({ error: "Conversation not found" }, 404);
    }

    // --- Load existing history BEFORE inserting the new user message ---
    const { data: historyRows, error: histErr } = await supabase
      .from("chat_messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(MAX_HISTORY_TURNS);
    if (histErr) {
      console.error("history load failed", histErr);
      return json({ error: "Could not load history" }, 500);
    }
    const history: ChatMessage[] = (historyRows ?? []).map((r) => ({
      role: r.role as ChatMessage["role"],
      content: r.content,
    }));

    // --- Persist user message (trigger handles auto-title + last_message_at) ---
    const { error: insertUserErr } = await supabase.from("chat_messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "user",
      content: userMessage,
    });
    if (insertUserErr) {
      console.error("insert user message failed", insertUserErr);
      return json({ error: "Could not persist message" }, 500);
    }

    // --- Call the model ---
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
        messages: [
          { role: "system", content: buildSystemPrompt(safeContext) },
          ...history,
          { role: "user", content: userMessage },
        ],
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      if (response.status === 429) {
        return json({ error: "Rate limit reached. Give it a moment, then try again." }, 429);
      }
      if (response.status === 402) {
        return json({ error: "AI credits depleted. Top up in Settings → Workspace → Usage." }, 402);
      }
      const text = await response.text().catch(() => "");
      console.error("Gateway error", response.status, text);
      return json({ error: "AI gateway error" }, 500);
    }

    // --- Tee the stream: pass through to client AND accumulate assistant text for DB ---
    let assistantBuffer = "";
    let textBuffer = "";
    const decoder = new TextDecoder();

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        // Parse SSE deltas to capture the final assistant text
        textBuffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, idx);
          textBuffer = textBuffer.slice(idx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === "string") assistantBuffer += delta;
          } catch {
            // partial JSON — ignore, will be retried with next chunk
          }
        }
      },
      async flush() {
        if (assistantBuffer.trim().length > 0) {
          const { error } = await supabase.from("chat_messages").insert({
            conversation_id: conversationId,
            user_id: userId,
            role: "assistant",
            content: assistantBuffer,
          });
          if (error) console.error("persist assistant message failed", error);
        }
      },
    });

    return new Response(response.body.pipeThrough(transform), {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("copilot-chat error", e);
    return json({ error: "Internal server error" }, 500);
  }
});
