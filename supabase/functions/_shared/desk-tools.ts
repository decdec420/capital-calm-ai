// _shared/desk-tools.ts
// The desk's shared operator toolset — schemas + executors.
// Used by: Wags (copilot-chat, interactive) and Bobby (jessica, autonomous).
// Every write action is logged to tool_calls with actor, tool name, args, result, reason.
//
// ─── Axe Capital Trading Desk ────────────────────────────────────
// Bobby     — Desk Commander. Autonomous orchestrator. Makes every call. [jessica]
// Wags      — COO. Operator interface. The operator talks to Wags.      [copilot-chat]
// Taylor    — Chief Quant / CIO. Two modes:
//               Signal mode: scores setups, proposes entries.           [signal-engine]
//               Review mode: grades strategies, promotes/kills.         [katrina]
// Mafee     — Pattern Recognition. Spots setups, reads chart structure. [Brain Trust Expert 3]
// Dollar Bill — Crypto Intel. Funding, sentiment, news, environment.    [Brain Trust Expert 2]
// Hall      — Macro Strategist. Trend structure, market phase, bias.    [Brain Trust Expert 1]
// Chuck     — Risk Manager. Binary veto. Enforces doctrine.             [risk gates in signal-engine]
// Wendy     — Performance Coach. Grades entries, drives learning.       [post-trade-learn]
//
// TRADE AUTHORITY: Only Bobby (jessica_autonomous) and Wags (harvey_chat) can
// execute trade tools. The trade reaches Bobby because it was already vetted
// by Taylor's signal engine and Chuck's risk veto.
// ─────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export const DESK_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_brain_trust",
      description:
        "Fire the Brain Trust (market-intelligence) now for one or all symbols. Use when market context is stale or a major news event just dropped.",
      parameters: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "Specific symbol to refresh (e.g. 'BTC-USD'). Omit to refresh all 3.",
          },
          reason: {
            type: "string",
            description: "1-sentence reason why Brain Trust needs a refresh now.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_engine_tick",
      description:
        "Fire Taylor (signal engine) now, off-schedule. Use when conditions just changed and waiting for the next cron tick would miss the window.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "1-sentence reason for the off-schedule tick.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "approve_signal",
      description:
        "Approve a pending trade signal. The signal still flows through Chuck's doctrine gates (risk manager veto in signal-engine) — this is NOT a bypass.",
      parameters: {
        type: "object",
        properties: {
          signal_id: {
            type: "string",
            description: "UUID of the trade_signal row to approve.",
          },
          reasoning: {
            type: "string",
            description: "Reasoning for approval. Logged to audit trail.",
          },
        },
        required: ["signal_id", "reasoning"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reject_signal",
      description: "Reject a pending trade signal with a reason.",
      parameters: {
        type: "object",
        properties: {
          signal_id: {
            type: "string",
            description: "UUID of the trade_signal row to reject.",
          },
          reason: {
            type: "string",
            description: "Why the signal is being rejected.",
          },
        },
        required: ["signal_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pause_bot",
      description:
        "Pause all trading for N minutes. Use for high-severity news, consecutive stop-outs, or explicit operator request.",
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description: "Minutes to pause. Max 120 (2 hours). Bobby is not permitted to suspend trading for longer than 2 hours autonomously.",
          },
          reason: {
            type: "string",
            description: "Why trading is being paused.",
          },
        },
        required: ["minutes", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_bot",
      description: "Resume trading before the pause window expires.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why resuming early.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_autonomy",
      description: "Change the bot's autonomy level.",
      parameters: {
        type: "object",
        properties: {
          level: {
            type: "string",
            enum: ["manual", "assisted", "autonomous"],
            description: "New autonomy level.",
          },
          reason: {
            type: "string",
            description: "Why the autonomy level is changing.",
          },
        },
        required: ["level", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pending_signals",
      description:
        "Fetch all pending trade signals awaiting a decision. Always call this before approve_signal or reject_signal.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pending_experiments",
      description:
        "Fetch experiment rows that are still queued/running or need operator review. Always call this before accept_experiment or reject_experiment.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reject_experiment",
      description:
        "Reject an experiment and clear review flags. Use when sample quality is weak, overfit risk is high, or the hypothesis failed.",
      parameters: {
        type: "object",
        properties: {
          experiment_id: {
            type: "string",
            description: "UUID of the experiment row to reject.",
          },
          reason: {
            type: "string",
            description: "One-line rejection reason.",
          },
        },
        required: ["experiment_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_doctrine_change",
      description:
        "Change the trading doctrine — risk profile, position caps, or strategy parameters. Tightenings (lower size, lower trades, higher floor, etc.) apply INSTANTLY. Loosenings are queued for the 24h tilt-protection cooldown and are visible in Pending Doctrine Changes. Use when the operator says things like 'tighten the daily loss to 1%', 'cut max trades to 3', or 'switch profile to active'. Always returns a structured plan; the operator sees both applied + pending in the UI.",
      parameters: {
        type: "object",
        properties: {
          change_summary: {
            type: "string",
            description: "Plain-English one-sentence summary of what is changing.",
          },
          rationale: {
            type: "string",
            description: "One-line reason for the change.",
          },
          parameters: {
            type: "object",
            description:
              "Optional system_state knobs to set immediately (no cooldown). Currently supports: active_profile ∈ {sentinel, active, aggressive}.",
          },
          doctrine_changes: {
            type: "array",
            description:
              "Structured doctrine field edits routed through update-doctrine. Tightenings apply instantly; loosenings queue 24h.",
            items: {
              type: "object",
              properties: {
                field: {
                  type: "string",
                  enum: [
                    "max_order_pct",
                    "max_order_abs_cap",
                    "daily_loss_pct",
                    "max_trades_per_day",
                    "floor_pct",
                    "risk_per_trade_pct",
                    "consecutive_loss_limit",
                    "loss_cooldown_minutes",
                    "scan_interval_seconds",
                    "max_correlated_positions",
                  ],
                },
                to_value: { type: "number" },
                reason: { type: "string" },
              },
              required: ["field", "to_value"],
            },
          },
        },
        required: ["change_summary", "rationale"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "accept_experiment",
      description:
        "Accept an experiment and clear review flags. Promotion to candidate strategy stays an explicit operator action in the UI.",
      parameters: {
        type: "object",
        properties: {
          experiment_id: {
            type: "string",
            description: "UUID of the experiment row to accept.",
          },
          reason: {
            type: "string",
            description: "One-line acceptance reason.",
          },
        },
        required: ["experiment_id", "reason"],
      },
    },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type ToolActor = "harvey_chat" | "jessica_autonomous";

export interface ToolContext {
  userId: string;
  token: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  serviceRoleKey: string;
  actor: ToolActor;
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolCallResult> {
  const { userId, token, supabaseUrl, supabaseAnonKey, serviceRoleKey, actor } = context;

  // Trade authority gate: only Bobby (jessica_autonomous) and Wags (harvey_chat)
  // may execute desk tools. Any other actor is rejected before touching state.
  const AUTHORISED_ACTORS: readonly string[] = ["harvey_chat", "jessica_autonomous"];
  if (!AUTHORISED_ACTORS.includes(actor)) {
    return {
      success: false,
      error: `Trade authority denied: unknown actor "${actor}". Only Bobby and Wags may execute desk tools.`,
    };
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const reason = (args.reason as string) ?? (args.reasoning as string) ?? "no reason provided";
  // actorShort used in audit logs. Maps technical actor IDs → display names.
  const actorShort = actor === "harvey_chat" ? "wags" : "bobby";

  const logEntry = {
    user_id: userId,
    actor,
    tool_name: toolName,
    tool_args: args,
    reason,
    called_at: new Date().toISOString(),
  };

  // Audit-log helper (uses the existing append_audit_log RPC so the hash chain stays valid).
  const appendAudit = async (action: string, details: Record<string, unknown>) => {
    try {
      await adminClient.rpc("append_audit_log", {
        p_user_id: userId,
        p_action: action,
        p_actor: actorShort,
        p_trade_id: null,
        p_symbol: (details.symbol as string | undefined) ?? null,
        p_amount_usd: null,
        p_details: details,
      });
    } catch (e) {
      console.error("audit log append failed", e);
    }
  };

  // MED-6: Append an immutable row to system_events for every state-changing
  // Jessica action so the operator has a chronological audit trail.
  const appendSystemEvent = async (
    eventType: string,
    payload: Record<string, unknown>,
  ) => {
    try {
      await adminClient.from("system_events").insert({
        user_id: userId,
        event_type: eventType,
        actor: actorShort,
        payload,
      });
    } catch (e) {
      console.error("[desk-tools] system_events insert failed", e);
    }
  };

  try {
    switch (toolName) {
      case "run_brain_trust": {
        const body = args.symbol ? { symbol: args.symbol } : {};
        const res = await fetch(`${supabaseUrl}/functions/v1/market-intelligence`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: supabaseAnonKey,
          },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        const result: ToolCallResult = res.ok
          ? {
              success: true,
              data: { status: "Brain Trust refreshed", symbols: args.symbol ?? "all" },
            }
          : { success: false, error: data.error ?? `Brain Trust failed (${res.status})` };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        return result;
      }

      case "run_engine_tick": {
        const res = await fetch(`${supabaseUrl}/functions/v1/signal-engine`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            apikey: supabaseAnonKey,
          },
          body: JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({}));
        const result: ToolCallResult = res.ok
          ? { success: true, data: { tick: data.tick, gateReasons: data.gateReasons ?? [] } }
          : { success: false, error: data.error ?? `Engine failed (${res.status})` };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        return result;
      }

      case "approve_signal": {
        const signalId = args.signal_id as string;
        const { error } = await adminClient
          .from("trade_signals")
          .update({
            status: "approved",
            approved_by: actorShort,
            approved_at: new Date().toISOString(),
          })
          .eq("id", signalId)
          .eq("user_id", userId)
          .eq("status", "pending");
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: { signal_id: signalId, action: "approved" } };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        if (result.success) {
          await appendAudit("signal_approved", {
            signal_id: signalId,
            reasoning: args.reasoning ?? null,
          });
        }
        return result;
      }

      case "reject_signal": {
        const signalId = args.signal_id as string;
        const { error } = await adminClient
          .from("trade_signals")
          .update({ status: "rejected", rejected_reason: reason })
          .eq("id", signalId)
          .eq("user_id", userId)
          .eq("status", "pending");
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: { signal_id: signalId, action: "rejected" } };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        if (result.success) {
          await appendAudit("signal_rejected", { signal_id: signalId, reason });
        }
        return result;
      }

      case "pause_bot": {
        const minutes = Math.min(Math.max(Number(args.minutes ?? 60), 1), 120);
        const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
        const { error } = await adminClient
          .from("system_state")
          .update({ trading_paused_until: until, pause_reason: reason })
          .eq("user_id", userId);
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: { paused_until: until, minutes } };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        if (result.success) {
          await appendAudit("bot_paused", { paused_until: until, minutes, reason });
          await appendSystemEvent("bot_paused", { paused_until: until, minutes, reason });
        }
        return result;
      }

      case "resume_bot": {
        const { error } = await adminClient
          .from("system_state")
          .update({ trading_paused_until: null, pause_reason: null })
          .eq("user_id", userId);
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: { status: "trading resumed" } };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        if (result.success) {
          await appendAudit("bot_resumed", { reason });
          await appendSystemEvent("bot_resumed", { reason });
        }
        return result;
      }

      case "set_autonomy": {
        const level = args.level as string;
        const { error } = await adminClient
          .from("system_state")
          .update({ autonomy_level: level })
          .eq("user_id", userId);
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: { autonomy_level: level } };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        if (result.success) {
          await appendAudit("autonomy_changed", { level, reason });
          await appendSystemEvent("autonomy_changed", { level, reason });
        }
        return result;
      }

      case "get_pending_signals": {
        const { data, error } = await adminClient
          .from("trade_signals")
          .select("id, symbol, side, confidence, ai_reasoning, created_at, setup_score")
          .eq("user_id", userId)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(10);
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: data ?? [] };
        // Reads are not logged to tool_calls — only writes.
        return result;
      }

      case "list_pending_experiments": {
        const { data, error } = await adminClient
          .from("experiments")
          .select(
            "id,title,parameter,before_value,after_value,status,proposed_by,hypothesis,needs_review,created_at",
          )
          .eq("user_id", userId)
          .or("status.in.(queued,running),needs_review.eq.true")
          .order("created_at", { ascending: false })
          .limit(20);
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: data ?? [] };
        // Reads are not logged to tool_calls — only writes.
        return result;
      }

      case "reject_experiment": {
        const experimentId = args.experiment_id as string;
        const { data: row, error: readErr } = await adminClient
          .from("experiments")
          .select("id,notes")
          .eq("id", experimentId)
          .eq("user_id", userId)
          .maybeSingle();
        if (readErr || !row) {
          return { success: false, error: readErr?.message ?? "Experiment not found" };
        }
        const stampedReason = `[${new Date().toISOString()}] ${actorShort} rejected: ${reason}`;
        const nextNotes = row.notes ? `${row.notes}\n${stampedReason}` : stampedReason;
        const { error } = await adminClient
          .from("experiments")
          .update({
            status: "rejected",
            needs_review: false,
            notes: nextNotes,
          })
          .eq("id", experimentId)
          .eq("user_id", userId);
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: { experiment_id: experimentId, action: "rejected" } };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        return result;
      }

      case "propose_doctrine_change": {
        const changeSummary = args.change_summary as string;
        const rationale = args.rationale as string;
        const parameters = (args.parameters as Record<string, unknown>) ?? {};
        const doctrineChanges = Array.isArray(args.doctrine_changes)
          ? (args.doctrine_changes as Array<{ field: string; to_value: number; reason?: string }>)
          : [];

        // 1) Apply system_state knobs immediately (active_profile etc).
        const VALID_PROFILES = ["sentinel", "active", "aggressive"];
        const dbPatch: Record<string, unknown> = {};
        if (parameters.active_profile && VALID_PROFILES.includes(parameters.active_profile as string)) {
          dbPatch.active_profile = parameters.active_profile;
        }

        let applyError: string | undefined;
        if (Object.keys(dbPatch).length > 0) {
          const { error: patchErr } = await adminClient
            .from("system_state")
            .update(dbPatch)
            .eq("user_id", userId);
          if (patchErr) applyError = patchErr.message;
        }

        // 2) Route structured doctrine_changes through update-doctrine so the
        //    24h cooldown applies to loosenings — Wags can't bypass the gate.
        let doctrineResults: unknown[] = [];
        if (doctrineChanges.length > 0) {
          try {
            const resp = await fetch(`${supabaseUrl}/functions/v1/update-doctrine`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                // Pass the operator's JWT so update-doctrine attributes the change
                // to the right user (and audits actor=user). Wags is the
                // operator's voice; the cooldown applies regardless.
                Authorization: `Bearer ${token}`,
                apikey: supabaseAnonKey,
              },
              body: JSON.stringify({
                changes: doctrineChanges.map((c) => ({
                  field: c.field,
                  to_value: c.to_value,
                  reason: c.reason ?? `[wags] ${rationale}`,
                })),
              }),
            });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) {
              applyError = applyError ?? (body?.error ?? `update-doctrine failed: ${resp.status}`);
            } else {
              doctrineResults = Array.isArray(body?.results) ? body.results : [];
            }
          } catch (e) {
            applyError = applyError ?? `update-doctrine fetch failed: ${String(e)}`;
          }
        }

        await appendSystemEvent("doctrine_change", {
          change_summary: changeSummary,
          rationale,
          parameters,
          doctrine_changes: doctrineChanges,
          doctrine_results: doctrineResults,
          applied: !applyError,
          applied_by: actorShort,
        });

        const result: ToolCallResult = applyError
          ? { success: false, error: applyError }
          : {
              success: true,
              data: {
                status: "applied",
                change_summary: changeSummary,
                parameters_set: dbPatch,
                doctrine_results: doctrineResults,
              },
            };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        if (result.success) {
          await appendAudit("doctrine_change", {
            change_summary: changeSummary,
            rationale,
            parameters: dbPatch,
            doctrine_changes: doctrineChanges,
          });
        }
        return result;
      }

      case "accept_experiment": {
        const experimentId = args.experiment_id as string;
        const { data: row, error: readErr } = await adminClient
          .from("experiments")
          .select("id,notes")
          .eq("id", experimentId)
          .eq("user_id", userId)
          .maybeSingle();
        if (readErr || !row) {
          return { success: false, error: readErr?.message ?? "Experiment not found" };
        }
        const stampedReason = `[${new Date().toISOString()}] ${actorShort} accepted: ${reason}`;
        const nextNotes = row.notes ? `${row.notes}\n${stampedReason}` : stampedReason;
        const { error } = await adminClient
          .from("experiments")
          .update({
            status: "accepted",
            needs_review: false,
            notes: nextNotes,
          })
          .eq("id", experimentId)
          .eq("user_id", userId);
        const result: ToolCallResult = error
          ? { success: false, error: error.message }
          : { success: true, data: { experiment_id: experimentId, action: "accepted" } };
        await adminClient
          .from("tool_calls")
          .insert({ ...logEntry, result, success: result.success });
        return result;
      }

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    const result: ToolCallResult = { success: false, error: String(err) };
    await adminClient
      .from("tool_calls")
      .insert({ ...logEntry, result, success: false })
      .then(() => {})
      .catch(() => {});
    return result;
  }
}
