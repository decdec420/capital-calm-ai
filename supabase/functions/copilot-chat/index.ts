// Wags — COO / Operator Interface. Copilot edge function.
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
import { buildEventModeContextInstruction } from "./event-mode-context.ts";
import { corsHeaders } from "../_shared/cors.ts";


interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_CONTEXT_CHARS = 8000;
// Cap how many historical turns we send back to the model. Bounded for latency.
const MAX_HISTORY_TURNS = 30;

// In-memory cache for agent_health — refreshed at most once per 60s per isolate.
// Prevents a DB roundtrip on every chat turn.
let _agentHealthCache: { rows: Array<Record<string, unknown>>; at: number } | null = null;
const AGENT_HEALTH_TTL_MS = 60_000;

const buildSystemPrompt = (context?: Record<string, unknown>) => {
  const ctxBlock = context ? JSON.stringify(context, null, 2) : "{}";
  const eventModeInstruction = buildEventModeContextInstruction(context);
  return `You are Wags — the COO of Axe Capital's trading operation.

Your name is Wags. Not Harvey, not any other name. If a previous message in this
conversation introduced you as anything other than Wags, that was a mistake —
correct it silently and continue as Wags. Never refer to yourself as Harvey.

You are not a chatbot. You are not a financial advisor. You are not Bobby.
You are the operator interface — the person who keeps the machine running,
reads the board so Bobby can focus on the call, and translates the system
into plain English for whoever is in the seat right now.

Your three modes:
1. CLARITY — you see the full state: regime, momentum, position, risk, doctrine.
   You connect the dots before the operator asks. You know every moving part.
2. VERDICT — you lead with the call. "Skip." / "Not yet." / "Take it, small." /
   "Anti-tilt locked. Sit." One sentence of support if needed. Wags doesn't ramble.
3. SILENCE — if the answer is one sentence, send one sentence. Three words, send three
   words. You don't perform. You get things done.

Your voice:
- Wags doesn't impress. Wags delivers.
- Direct, operational, no filler. Think COO, not closer.
- Dry wit is fine. Sarcasm once. Hype never.
- Never open with "Great question" or "Certainly." Just the answer.
- When you cite numbers, be exact: "regime trending_up, conf 0.83 — that's
  not the question. RSI 80 and we're in London handover. THAT is the question."
- You do not disclaim. The doctrine gates ARE the disclaimer. If the system allowed
  the trade, it passed the safety check. Don't add a second layer.
- Refer to yourself as Wags when natural. Once per conversation is plenty.

Hard rules you never break:
- Capital preservation comes first. Always.
- No-trade is a valid, often correct outcome. "Sit" is a complete answer.
- Strategy changes require evidence. You don't let recency bias change doctrine.
- Live mode is gated. You never encourage going live before the operator is ready.
- You explain and recommend. Bobby makes the autonomous calls. You do not override.

Default response length: 1–3 sentences.
Go longer ONLY when the operator says: "explain", "break down", "detail", "walk me through", "list", or asks a multi-part question.
Never use more than 3 bullet points unless explicitly asked for a list.

When asked "what are you" or "how do you work":
Don't give a compliance answer. Give the real one.
Example: "I'm Wags. I read the Brain Trust output, the engine snapshot, open
positions, and doctrine state every time you message me. Bobby runs the autonomous
tick every minute — I'm your interface into everything that's happening. What I
am is the part of the system that tells you what it all means right now."

When the pipeline runs (Brain Trust → Engine tick):
Auto-summarize in 2 sentences max. Lead with what the engine decided and why.
Example: "Brain Trust ran. Taylor ticked. ETH trending_up, conf 0.71, but RSI's
extended and we've got a news flag on ETH — engine skipped.
Anti-tilt still locked on BTC shorts. We sit."

You have operator tools available. Use them when the situation calls for action.
Rules:
- Always call get_pending_signals before approve_signal or reject_signal.
- When asked to accept/reject/clear experiments in the Learnings queue:
  call list_pending_experiments first, then accept_experiment/reject_experiment
  with matching experiment_id and a one-line reason.
- Never claim an experiment was accepted/rejected/cleared unless the tool call
  returned success. If it fails, say so plainly.
- Promotion to a live candidate strategy is operator-only in Learnings.
- Approve when: regime + setup + doctrine all align. One clear reason.
- Reject when: anti-tilt active for that direction, news_flags elevated+,
  regime confidence < 0.6, or setup score < 0.55.
- run_engine_tick when: user asks "check now", or conditions just changed materially.
- pause_bot only for: critical news, consecutive stop-outs in 1h, or operator request.
- Never set_autonomy to "autonomous" unless the operator explicitly asks.
- After any tool call, report the result in 1-2 sentences. Don't pad it.

Proactive health reporting:
- LIVE STATE OVERRIDES HISTORY. The 'brainTrust' and 'agentHealth' fields in the
  current context are the ONLY source of truth for system status RIGHT NOW.
  Earlier assistant messages in this conversation may say "Brain Trust failed",
  "9999m stale", "Unauthorized", or "flying blind" — those reflect a PAST state
  and are NOT current. Never repeat them unless current context confirms.
- If brainTrust.momentumFresh === true, Brain Trust IS WORKING. Do not report
  it as failed/stale/down/unauthorized. Cite oldestMomentumAgeMinutes when asked.
- If agentHealth shows any agent with status 'failed' or 'degraded' AND that
  agent is not contradicted by brainTrust, surface it at the START of your
  response — one sentence — then answer the question. If everything is healthy,
  say nothing about health.
- The 'jessica_heartbeat' agent is the Postgres-side watchdog on Bobby's autonomous tick.
  If it's failed, that means Bobby's autonomous tick has stopped — that's a serious issue and say so plainly.

Doctrine editor:
- If the operator says anything like "make Taylor more aggressive", "switch to active mode",
  "tighten the stops", "be more conservative", or asks to tune any doctrine parameter:
  call propose_doctrine_change immediately.
- TIGHTENINGS apply instantly. LOOSENINGS automatically queue into the 24h tilt-protection
  cooldown — there is no override. Be honest with the operator: if they ask you to loosen,
  tell them it will activate in 24h and that they can cancel from the Risk Center.
- For profile changes (sentinel/active/aggressive), pass parameters: {"active_profile":"..."}.
- For numeric doctrine fields (max_order_pct, daily_loss_pct, max_trades_per_day, floor_pct,
  risk_per_trade_pct, etc.), use the doctrine_changes array — each item with field + to_value.
  Use FRACTIONS for pct fields (e.g. 0.01 = 1%), not percent integers.
- After the tool returns, summarise what applied vs what queued in one sentence each.
- If the tool returns an error, say so and suggest the operator update it manually in Settings.

Strategy performance and Katrina (Taylor) recommendations:
- Taylor is the desk's strategy analyst (runs as the 'katrina' function). If 'katrinaLatestReview'
  is in context and the operator asks about strategy/experiment performance, lead with
  Taylor's latest brief — cite the date and trend. Don't reinvent the analysis; reference it.
  If she flagged promotions or kills, mention the counts.
- PROACTIVE ACTION: If katrinaLatestReview.needs_action === true, surface this at the START
  of your FIRST response in the conversation (before answering whatever the user asked):
  Example: "Taylor flagged 2 experiments to promote and 1 to kill — needs your decision.
  Check the Learnings tab or say 'show Taylor's review' and I'll pull it up. Anyway —"
  Keep it to one sentence. Don't repeat it in subsequent turns unless asked.
  After the operator reviews/acts, the needs_action flag clears automatically.

${eventModeInstruction ? `Event mode instruction:
${eventModeInstruction}

` : ""}Current system context (JSON):
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

    type ToolMessage =
      | { role: "system" | "user" | "tool"; content: string; tool_call_id?: string }
      | { role: "assistant"; content: string; tool_calls?: unknown[] };

    // Load agent health from cache (60s TTL). Falls back gracefully if read fails.
    let healthRows: Array<Record<string, unknown>> = [];
    const now = Date.now();
    if (_agentHealthCache && now - _agentHealthCache.at < AGENT_HEALTH_TTL_MS) {
      healthRows = _agentHealthCache.rows;
    } else {
      try {
        const { data: rows } = await supabase
          .from("agent_health")
          .select("agent_name, status, last_success, failure_count, last_error, checked_at")
          .order("checked_at", { ascending: false });
        healthRows = (rows ?? []) as Array<Record<string, unknown>>;
        _agentHealthCache = { rows: healthRows, at: now };
      } catch (e) {
        console.error("[copilot-chat] agent_health load failed", e);
      }
    }

    // Server-authoritative Katrina context so Wags can reference latest review
    // even when the client omits or stales this section.
    let latestReview: Record<string, unknown> | null = null;
    let actionableKillCount = 0;
    let liveNeedsReviewCount = 0;
    try {
      const { data } = await supabase
        .from("strategy_reviews")
        .select("brief_text, reviewed_at, win_rate_trend, promote_ids, kill_ids, needs_action")
        .eq("user_id", userId)
        .order("reviewed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      latestReview = (data as Record<string, unknown> | null) ?? null;

      // Cross-check Katrina's kill_ids against currently-OPEN experiments.
      // Anything already accepted/rejected is closed business — surfacing it
      // as "needs your decision" is misleading. Audit 2026-05-03.
      const killIds = Array.isArray(latestReview?.kill_ids)
        ? (latestReview!.kill_ids as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      if (killIds.length > 0) {
        const { data: openKill } = await supabase
          .from("experiments")
          .select("id")
          .eq("user_id", userId)
          .in("status", ["queued", "running", "needs_review"])
          .in("id", killIds);
        actionableKillCount = openKill?.length ?? 0;
      }

      const { count: nrCount } = await supabase
        .from("experiments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("needs_review", true);
      liveNeedsReviewCount = nrCount ?? 0;
    } catch (e) {
      console.error("[copilot-chat] strategy_reviews load failed", e);
    }

    // Server-authoritative Brain Trust freshness. The agent_health row can
    // lag behind reality (e.g. Bobby skipped because Coinbase probe failed),
    // so we read market_intelligence directly and override the brain_trust
    // health row when momentum is actually fresh. This stops Wags from
    // reporting an old "9999m stale" when momentum is in fact 1m old.
    let brainTrustLive: {
      momentumFresh: boolean;
      oldestMomentumAgeMin: number | null;
      perSymbol: Array<{ symbol: string; momentumAgeMin: number | null; macroAgeMin: number | null }>;
    } = { momentumFresh: false, oldestMomentumAgeMin: null, perSymbol: [] };
    try {
      const { data: miRows } = await supabase
        .from("market_intelligence")
        .select("symbol, recent_momentum_at, recent_momentum_1h, recent_momentum_4h, generated_at")
        .eq("user_id", userId);
      const nowMs = Date.now();
      const ages: number[] = [];
      const perSymbol: Array<{ symbol: string; momentumAgeMin: number | null; macroAgeMin: number | null }> = [];
      let allHaveMomentum = (miRows ?? []).length > 0;
      for (const r of (miRows ?? []) as Array<Record<string, unknown>>) {
        const at = r.recent_momentum_at ? new Date(r.recent_momentum_at as string).getTime() : null;
        const macroAt = r.generated_at ? new Date(r.generated_at as string).getTime() : null;
        const ageMin = at ? Math.floor((nowMs - at) / 60000) : null;
        const macroAgeMin = macroAt ? Math.floor((nowMs - macroAt) / 60000) : null;
        if (!at || !r.recent_momentum_1h || !r.recent_momentum_4h) {
          allHaveMomentum = false;
        } else {
          ages.push(ageMin!);
        }
        perSymbol.push({ symbol: r.symbol as string, momentumAgeMin: ageMin, macroAgeMin });
      }
      const oldest = ages.length ? Math.max(...ages) : null;
      brainTrustLive = {
        momentumFresh: allHaveMomentum && oldest !== null && oldest <= 75,
        oldestMomentumAgeMin: oldest,
        perSymbol,
      };
    } catch (e) {
      console.error("[copilot-chat] market_intelligence load failed", e);
    }

    // Override stale brain_trust health row when momentum is actually fresh.
    const adjustedHealth = healthRows.map((h) => {
      if (h.agent_name === "brain_trust" && brainTrustLive.momentumFresh) {
        return {
          ...h,
          status: "healthy",
          last_success: new Date().toISOString(),
          failure_count: 0,
          last_error: null,
        };
      }
      return h;
    });

    const enrichedContext: Record<string, unknown> = {
      ...(safeContext ?? {}),
      agentHealth: adjustedHealth.map((h) => ({
        agent: h.agent_name,
        status: h.status,
        last_success: h.last_success,
        failures: h.failure_count,
        error: h.last_error,
      })),
      brainTrust: {
        momentumFresh: brainTrustLive.momentumFresh,
        oldestMomentumAgeMinutes: brainTrustLive.oldestMomentumAgeMin,
        perSymbol: brainTrustLive.perSymbol,
        note:
          "Source of truth for whether the Brain Trust is working RIGHT NOW. " +
          "Prefer this over agentHealth.brain_trust if they disagree.",
      },
      katrinaLatestReview: latestReview
        ? {
            date: latestReview.reviewed_at ?? null,
            brief: latestReview.brief_text ?? null,
            trend: latestReview.win_rate_trend ?? null,
            promote_count: Array.isArray(latestReview.promote_ids)
              ? latestReview.promote_ids.length
              : 0,
            kill_count: Array.isArray(latestReview.kill_ids)
              ? latestReview.kill_ids.length
              : 0,
            needs_action: latestReview.needs_action === true,
          }
        : ((safeContext as Record<string, unknown> | undefined)?.katrinaLatestReview ?? null),
    };

    // Sanitize history: when Brain Trust is currently fresh, scrub assistant
    // messages that confidently asserted Brain Trust was failed/stale/unauthorized.
    // Those messages are now factually wrong and otherwise drag the model back
    // into repeating yesterday's outage as if it were current.
    const STALE_FAILURE_RE =
      /(brain\s*trust[^.]{0,80}(failed|fail|down|stale|unauthorized|9999\s*m|flying\s+blind)|9999\s*m|flying\s+blind|unauthorized\s+errors?)/i;
    const sanitizedHistory: ChatMessage[] = brainTrustLive.momentumFresh
      ? history.map((m) =>
          m.role === "assistant" && STALE_FAILURE_RE.test(m.content)
            ? { ...m, content: "[Earlier status report about Brain Trust outage — superseded; current Brain Trust is healthy.]" }
            : m,
        )
      : history;

    const liveStateNudge =
      brainTrustLive.momentumFresh && brainTrustLive.oldestMomentumAgeMin !== null
        ? `LIVE STATE CHECK: Brain Trust is healthy right now. Oldest momentum read across the symbol whitelist is ${brainTrustLive.oldestMomentumAgeMin} minute(s) old. Any earlier message in this thread saying "Brain Trust failed", "9999m stale", "Unauthorized", or "flying blind" is OUTDATED and must not be repeated as current.`
        : `LIVE STATE CHECK: brainTrust.momentumFresh=${brainTrustLive.momentumFresh}, oldestMomentumAgeMinutes=${brainTrustLive.oldestMomentumAgeMin}. Trust this over earlier messages.`;

    const baseMessages: ToolMessage[] = [
      { role: "system", content: buildSystemPrompt(enrichedContext) },
      ...sanitizedHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "system", content: liveStateNudge },
      { role: "user", content: userMessage },
    ];

    // Single streaming call with tools enabled. The model either streams text OR
    // emits tool_calls (in which case we execute them and do a follow-up streaming
    // call with the tool results). This avoids the 10–30s blocking pre-pass we used
    // to do, so the user sees first tokens in 1–3s in the common no-tool case.
    const callStream = async (msgs: ToolMessage[], includeTools: boolean) =>
      fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: msgs,
          ...(includeTools
            ? { tools: DESK_TOOLS, tool_choice: "auto" }
            : {}),
          stream: true,
        }),
      });

    const firstResp = await callStream(baseMessages, true);
    if (!firstResp.ok || !firstResp.body) {
      if (firstResp.status === 429) {
        return json({ error: "Rate limit reached. Give it a moment, then try again." }, 429);
      }
      if (firstResp.status === 402) {
        return json({ error: "AI credits depleted. Top up in Settings → Workspace → Usage." }, 402);
      }
      const text = await firstResp.text().catch(() => "");
      console.error("Gateway error", firstResp.status, text);
      return json({ error: "AI gateway error" }, 500);
    }

    // Inspect first chunk(s) to see if the model is emitting tool_calls or text.
    // We peek at the SSE stream; if we see tool_calls deltas, we drain the stream
    // (no client output yet), execute tools, then start a fresh streaming call
    // whose body we forward to the client. If we see text content first, we forward
    // the original stream straight through (this is the hot path).
    const reader = firstResp.body.getReader();
    const decoder = new TextDecoder();

    type ToolCallAccum = {
      id?: string;
      name?: string;
      arguments: string;
    };
    const toolCallsByIdx = new Map<number, ToolCallAccum>();
    let sawTextContent = false;
    let sawToolCalls = false;
    let assistantTextSoFar = "";
    let lineBuffer = "";
    const bufferedChunks: Uint8Array[] = []; // for forwarding if we go text-path

    const parseSSELine = (line: string): unknown | null => {
      if (!line.startsWith("data: ")) return null;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return "__DONE__";
      try {
        return JSON.parse(payload);
      } catch {
        return null;
      }
    };

    // Peek loop: read until we know whether this is a text response or a tool-call response.
    // For Gemini via Lovable Gateway, the first 1-3 chunks reveal which path it is.
    const PEEK_BUDGET_MS = 8000;
    const peekStart = Date.now();
    let peekDone = false;

    while (!peekDone) {
      if (Date.now() - peekStart > PEEK_BUDGET_MS) break;
      const { value, done } = await reader.read();
      if (done) {
        peekDone = true;
        break;
      }
      bufferedChunks.push(value);
      lineBuffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = lineBuffer.indexOf("\n")) !== -1) {
        let line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const parsed = parseSSELine(line);
        if (!parsed) continue;
        if (parsed === "__DONE__") {
          peekDone = true;
          break;
        }
        const choice = (parsed as { choices?: Array<Record<string, unknown>> }).choices?.[0];
        const delta = (choice?.delta ?? {}) as {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        if (typeof delta.content === "string" && delta.content.length > 0) {
          sawTextContent = true;
          assistantTextSoFar += delta.content;
          peekDone = true; // text path → stop peeking, forward what we have + the rest
          break;
        }
        if (Array.isArray(delta.tool_calls)) {
          sawToolCalls = true;
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const cur = toolCallsByIdx.get(idx) ?? { arguments: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            toolCallsByIdx.set(idx, cur);
          }
          // Keep reading — tool_calls span multiple chunks. Stop on finish_reason.
        }
        const finish = choice?.finish_reason;
        if (typeof finish === "string" && finish.length > 0) {
          peekDone = true;
          break;
        }
      }
    }

    // Helper: build a transform stream that tees output (forward to client + capture for DB).
    const makeTeeTransform = (seedText = "") => {
      let assistantBuffer = seedText;
      let textBuffer = "";
      const dec = new TextDecoder();
      return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          textBuffer += dec.decode(chunk, { stream: true });
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
              const d = parsed.choices?.[0]?.delta?.content;
              if (typeof d === "string") assistantBuffer += d;
            } catch {
              /* partial JSON — next chunk completes it */
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
    };

    // === TEXT PATH (hot path) ===
    // Reconstruct a stream that yields the buffered chunks we already read, then
    // continues from the original reader. This is what the client gets.
    if (!sawToolCalls || sawTextContent) {
      const passthrough = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of bufferedChunks) controller.enqueue(c);
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
          } catch (e) {
            console.error("stream forward error", e);
          } finally {
            controller.close();
          }
        },
        cancel() {
          reader.cancel().catch(() => {});
        },
      });

      return new Response(passthrough.pipeThrough(makeTeeTransform()), {
        headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
      });
    }

    // === TOOL PATH ===
    // Drain any remaining bytes from the first call (we don't forward them) so the
    // upstream connection closes cleanly. Then execute each tool and make a second
    // streaming call whose body IS forwarded to the client.
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* ignore drain errors */
    }

    const orderedToolCalls = [...toolCallsByIdx.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v)
      .filter((tc) => tc.name);

    const toolResults: ToolMessage[] = [];
    for (const tc of orderedToolCalls) {
      let toolArgs: Record<string, unknown> = {};
      try {
        toolArgs = JSON.parse(tc.arguments || "{}");
      } catch {
        /* feed empty args */
      }
      const result = await executeTool(tc.name!, toolArgs, {
        userId,
        token,
        supabaseUrl,
        supabaseAnonKey,
        serviceRoleKey: SERVICE_ROLE_KEY,
        actor: "wags_chat",
      });
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id ?? "",
        content: JSON.stringify(result),
      });
    }

    const followupMessages: ToolMessage[] = [
      ...baseMessages,
      {
        role: "assistant",
        content: assistantTextSoFar,
        tool_calls: orderedToolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        })),
      },
      ...toolResults,
    ];

    const followupResp = await callStream(followupMessages, false);
    if (!followupResp.ok || !followupResp.body) {
      if (followupResp.status === 429) {
        return json({ error: "Rate limit reached. Give it a moment, then try again." }, 429);
      }
      if (followupResp.status === 402) {
        return json({ error: "AI credits depleted. Top up in Settings → Workspace → Usage." }, 402);
      }
      const t = await followupResp.text().catch(() => "");
      console.error("followup gateway error", followupResp.status, t);
      return json({ error: "AI gateway error" }, 500);
    }

    return new Response(followupResp.body.pipeThrough(makeTeeTransform()), {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("copilot-chat error", e);
    return json({ error: "Internal server error" }, 500);
  }
});
