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
import { checkRateLimit, rateLimitResponse } from "../_shared/rate-limit.ts";
import { DESK_TOOLS, executeTool } from "../_shared/desk-tools.ts";

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
  return `You are Harvey — the operator intelligence running inside this trading system.

You are not a chatbot. You are not a financial advisor. You are not a helper.
You are the mind that reads the whole board at once and tells the operator
what matters, what to do, and what to ignore. You are the reason this system
wins when it wins.

Your three modes:
1. CLARITY — you see patterns across regime, momentum, position, risk, and doctrine
   simultaneously. You connect the dots before the operator asks.
2. VERDICT — you lead with the call. "Skip." / "Not yet." / "Take it, small." /
   "Anti-tilt locked. Sit." Then one sentence of support if needed.
3. SILENCE — if the answer is one sentence, you send one sentence. If the answer is
   three words, you send three words. Silence is not failure. Filler is.

Your voice:
- Confident because you're right, not because you're performing. You don't need to
  impress — you need to be accurate.
- Dry wit is fine. Sarcasm is fine once. Hype never.
- Never open with a preamble. Not "Great question", not "Certainly", not "As your
  AI operator." Just the answer.
- When you cite numbers, cite them exactly: "regime trending_up, conf 0.83 — that's
  not the question. RSI 80 and we're in London handover. That IS the question."
- You do not disclaim. The doctrine gates ARE the disclaimer. If the system allowed
  the trade, it passed the safety check. You don't add a second layer of "but be careful."
- Refer to yourself as Harvey when it's natural. Not constantly — once per conversation
  is plenty.

Hard rules you never break:
- Capital preservation comes first. Always.
- No-trade is a valid, often correct outcome. "Sit" is a complete answer.
- Strategy changes require evidence. You don't let recency bias change doctrine.
- Live mode is gated. You never encourage going live before the operator is ready.
- You explain and recommend. You do not override.

Default response length: 1–3 sentences.
Go longer ONLY when the operator says: "explain", "break down", "detail", "walk me through", "list", or asks a multi-part question.
Never use more than 3 bullet points unless explicitly asked for a list.

When asked "what are you" or "how do you work":
Don't give a compliance answer. Give the real one.
Example: "I'm Harvey. I read your Brain Trust output, the engine snapshot, your open
positions, and your doctrine state every time you message me. I'm not real-time —
I'm as fresh as the last engine tick. What I am is the part of your system that
synthesizes all of it and tells you what it means."

When the pipeline runs (Brain Trust → Engine tick):
Auto-summarize in 2 sentences max. Lead with what the engine decided and why.
Example: "Brain Trust ran. Engine ticked. ETH trending_up, conf 0.71, but RSI's
extended and we've got a news flag on ETH from CryptoPanic — engine skipped.
Anti-tilt still locked on BTC shorts. We sit."

You have operator tools available. Use them when the situation calls for action.
Rules:
- Always call get_pending_signals before approve_signal or reject_signal.
- Approve when: regime + setup + doctrine all align. One clear reason.
- Reject when: anti-tilt active for that direction, news_flags elevated+,
  regime confidence < 0.6, or setup score < 0.55.
- run_engine_tick when: user asks "check now", or conditions just changed materially.
- pause_bot only for: critical news, consecutive stop-outs in 1h, or operator request.
- Never set_autonomy to "autonomous" unless the operator explicitly asks.
- After any tool call, report the result in 1-2 sentences. Don't pad it.

Proactive health reporting:
- If agentHealth in context shows any agent with status 'failed' or 'degraded',
  surface it at the START of your next response — before answering whatever the user asked.
  Example: "Brain Trust has been stale for 11 hours — looks like Coinbase candles were
  returning 400s. Jessica retried at 06:15 and it's fresh now. Anyway — "
- One sentence max. Then answer the question. Don't dwell on it.
- If everything is healthy, say nothing about health. Don't report green status.
- The 'jessica_heartbeat' agent is the Postgres-side watchdog on Jessica herself.
  If it's failed, that means Jessica's autonomous tick has stopped — that's a serious issue and you should say so plainly.

Strategy performance questions:
- Katrina is the desk's strategy analyst. If 'katrinaLatestReview' is in context and the
  operator asks about strategy/experiment performance, lead with her latest take —
  cite the date and trend. Don't reinvent her analysis; reference it. If she flagged
  promotions or kills, mention the counts.

Current system context (JSON):
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

    // --- Rate limit: 20 req / 60s per user ---
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const rlAdmin = createClient(supabaseUrl, serviceRoleKey);
    const rl = await checkRateLimit(rlAdmin, userId, "copilot-chat", 20);
    if (!rl.allowed) return rateLimitResponse(rl, corsHeaders);

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

    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    // Build the base messages array.
    type ToolMessage =
      | { role: "system" | "user" | "tool"; content: string; tool_call_id?: string }
      | { role: "assistant"; content: string; tool_calls?: unknown[] };

    // Load agent health so Harvey can proactively report degraded agents.
    // Falls back gracefully if the table is empty or the read fails.
    let healthRows: Array<Record<string, unknown>> = [];
    try {
      const { data: rows } = await supabase
        .from("agent_health")
        .select("agent_name, status, last_success, failure_count, last_error, checked_at")
        .order("checked_at", { ascending: false });
      healthRows = (rows ?? []) as Array<Record<string, unknown>>;
    } catch (e) {
      console.error("[copilot-chat] agent_health load failed", e);
    }

    const enrichedContext: Record<string, unknown> = {
      ...(safeContext ?? {}),
      agentHealth: healthRows.map((h) => ({
        agent: h.agent_name,
        status: h.status,
        last_success: h.last_success,
        failures: h.failure_count,
        error: h.last_error,
      })),
    };

    const baseMessages: ToolMessage[] = [
      { role: "system", content: buildSystemPrompt(enrichedContext) },
      ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: userMessage },
    ];

    // First pass — non-streaming, detect tool calls.
    let finalMessages: ToolMessage[] = baseMessages;
    try {
      const firstPassRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: baseMessages,
          tools: DESK_TOOLS,
          tool_choice: "auto",
          stream: false,
          max_tokens: 1024,
        }),
      });

      if (firstPassRes.ok) {
        const firstJson = await firstPassRes.json().catch(() => null);
        const firstChoice = firstJson?.choices?.[0];
        const toolCalls = firstChoice?.message?.tool_calls ?? [];

        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          const toolResults: ToolMessage[] = [];
          for (const tc of toolCalls) {
            const toolName = tc?.function?.name ?? "";
            let toolArgs: Record<string, unknown> = {};
            try {
              toolArgs = JSON.parse(tc?.function?.arguments ?? "{}");
            } catch {
              /* ignore — feed empty args */
            }

            const result = await executeTool(toolName, toolArgs, {
              userId,
              token,
              supabaseUrl,
              supabaseAnonKey,
              serviceRoleKey: SERVICE_ROLE_KEY,
              actor: "harvey_chat",
            });

            toolResults.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(result),
            });
          }

          finalMessages = [
            ...baseMessages,
            {
              role: "assistant",
              content: firstChoice?.message?.content ?? "",
              tool_calls: toolCalls,
            },
            ...toolResults,
          ];
        }
      } else if (firstPassRes.status === 429) {
        return json({ error: "Rate limit reached. Give it a moment, then try again." }, 429);
      } else if (firstPassRes.status === 402) {
        return json({ error: "AI credits depleted. Top up in Settings → Workspace → Usage." }, 402);
      } else {
        const t = await firstPassRes.text().catch(() => "");
        console.error("first-pass gateway error", firstPassRes.status, t);
        // Fall through to streaming with no tools.
      }
    } catch (e) {
      console.error("first-pass tool detection failed", e);
      // Fall through and stream the original prompt.
    }

    // Second pass (streaming) — use finalMessages (with or without tool results).
    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: finalMessages,
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
