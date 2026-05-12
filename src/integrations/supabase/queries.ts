/**
 * Typed query helpers for every Supabase table.
 * Each function returns { data, error } directly from the JS SDK.
 * All queries are scoped to the authenticated user's user_id where applicable.
 *
 * Usage:
 *   import { queryTrades } from "@/integrations/supabase/queries";
 *   const { data, error } = await queryTrades(supabase, userId);
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

type DB = SupabaseClient<Database>;

// ── account_state ──────────────────────────────────────────────────────────
export const queryAccountState = (db: DB, userId: string) =>
  db.from("account_state").select("*").eq("user_id", userId).maybeSingle();

// ── agent_health ───────────────────────────────────────────────────────────
export const queryAgentHealth = (db: DB, userId: string) =>
  db.from("agent_health").select("*").eq("user_id", userId).order("checked_at", { ascending: false });

// ── alerts ─────────────────────────────────────────────────────────────────
export const queryAlerts = (db: DB, userId: string, limit = 100) =>
  db.from("alerts").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);

// ── api_rate_limits ────────────────────────────────────────────────────────
export const queryApiRateLimits = (db: DB, userId: string) =>
  db.from("api_rate_limits").select("*").eq("user_id", userId);

// ── bobby_directives ───────────────────────────────────────────────────────
export const queryBobbyDirectives = (db: DB, userId: string, status?: string) => {
  let q = db.from("bobby_directives").select("*").eq("user_id", userId);
  if (status) q = q.eq("status", status);
  return q.order("issued_at", { ascending: false });
};

// ── broker_credentials ─────────────────────────────────────────────────────
export const queryBrokerCredentials = (db: DB, userId: string) =>
  db.from("broker_credentials").select("*").eq("user_id", userId).order("created_at", { ascending: false });

// ── broker_fills ───────────────────────────────────────────────────────────
export const queryBrokerFills = (db: DB, userId: string, limit = 200) =>
  db.from("broker_fills").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);

export const queryBrokerFillsByTrade = (db: DB, userId: string, tradeId: string) =>
  db.from("broker_fills").select("*").eq("user_id", userId).eq("trade_id", tradeId).order("created_at", { ascending: true });

// ── broker_health ──────────────────────────────────────────────────────────
export const queryBrokerHealth = (db: DB, userId: string) =>
  db.from("broker_health").select("*").eq("user_id", userId).maybeSingle();

// ── chat_conversations ─────────────────────────────────────────────────────
export const queryChatConversations = (db: DB, userId: string) =>
  db.from("chat_conversations").select("*").eq("user_id", userId).order("last_message_at", { ascending: false });

// ── chat_messages ──────────────────────────────────────────────────────────
export const queryChatMessages = (db: DB, userId: string, conversationId: string) =>
  db.from("chat_messages").select("*").eq("user_id", userId).eq("conversation_id", conversationId).order("created_at", { ascending: true });

// ── copilot_memory ─────────────────────────────────────────────────────────
export const queryCopilotMemory = (db: DB, userId: string) =>
  db.from("copilot_memory").select("*").eq("user_id", userId).order("last_tried_at", { ascending: false });

// ── daily_briefs ───────────────────────────────────────────────────────────
export const queryDailyBriefs = (db: DB, userId: string, limit = 30) =>
  db.from("daily_briefs").select("*").eq("user_id", userId).order("brief_date", { ascending: false }).limit(limit);

export const queryTodaysBrief = (db: DB, userId: string) => {
  const today = new Date().toISOString().slice(0, 10);
  return db.from("daily_briefs").select("*").eq("user_id", userId).eq("brief_date", today).maybeSingle();
};

// ── decision_memory ────────────────────────────────────────────────────────
export const queryDecisionMemory = (db: DB, userId: string, limit = 200) =>
  db.from("decision_memory").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);

// ── doctrine_settings ──────────────────────────────────────────────────────
export const queryDoctrineSettings = (db: DB, userId: string) =>
  db.from("doctrine_settings").select("*").eq("user_id", userId).maybeSingle();

// ── doctrine_symbol_overrides ──────────────────────────────────────────────
export const queryDoctrineSymbolOverrides = (db: DB, userId: string) =>
  db.from("doctrine_symbol_overrides").select("*").eq("user_id", userId).order("symbol");

// ── doctrine_versions ──────────────────────────────────────────────────────
export const queryDoctrineVersions = (db: DB, userId: string) =>
  db.from("doctrine_versions").select("*").eq("user_id", userId).order("version_no", { ascending: false });

// ── doctrine_windows ───────────────────────────────────────────────────────
export const queryDoctrineWindows = (db: DB, userId: string) =>
  db.from("doctrine_windows").select("*").eq("user_id", userId).order("start_utc");

// ── experiments ────────────────────────────────────────────────────────────
export const queryExperiments = (db: DB, userId: string, status?: string) => {
  let q = db.from("experiments").select("*").eq("user_id", userId);
  if (status) q = q.eq("status", status);
  return q.order("created_at", { ascending: false });
};

// ── guardrails ─────────────────────────────────────────────────────────────
export const queryGuardrails = (db: DB, userId: string) =>
  db.from("guardrails").select("*").eq("user_id", userId).order("sort_order");

// ── journal_entries ────────────────────────────────────────────────────────
export const queryJournalEntries = (db: DB, userId: string, limit = 100) =>
  db.from("journal_entries").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);

// ── market_intelligence ────────────────────────────────────────────────────
export const queryMarketIntelligence = (db: DB, userId: string) =>
  db.from("market_intelligence").select("*").eq("user_id", userId).order("generated_at", { ascending: false });

export const queryMarketIntelligenceBySymbol = (db: DB, userId: string, symbol: string) =>
  db.from("market_intelligence").select("*").eq("user_id", userId).eq("symbol", symbol).order("generated_at", { ascending: false }).limit(1).maybeSingle();

// ── notification_preferences ───────────────────────────────────────────────
export const queryNotificationPreferences = (db: DB, userId: string) =>
  db.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle();

// ── pending_doctrine_changes ───────────────────────────────────────────────
export const queryPendingDoctrineChanges = (db: DB, userId: string) =>
  db.from("pending_doctrine_changes").select("*").eq("user_id", userId).eq("status", "pending").order("effective_at");

// ── profiles ───────────────────────────────────────────────────────────────
export const queryProfile = (db: DB, userId: string) =>
  db.from("profiles").select("*").eq("user_id", userId).maybeSingle();

// ── strategies ─────────────────────────────────────────────────────────────
export const queryStrategies = (db: DB, userId: string, status?: string) => {
  let q = db.from("strategies").select("*").eq("user_id", userId);
  if (status) q = q.eq("status", status);
  return q.order("created_at", { ascending: false });
};

// ── strategy_reviews ───────────────────────────────────────────────────────
export const queryStrategyReviews = (db: DB, userId: string, limit = 20) =>
  db.from("strategy_reviews").select("*").eq("user_id", userId).order("reviewed_at", { ascending: false }).limit(limit);

// ── system_audit_log ───────────────────────────────────────────────────────
export const querySystemAuditLog = (db: DB, userId: string, limit = 200) =>
  db.from("system_audit_log").select("*").eq("user_id", userId).order("seq", { ascending: false }).limit(limit);

// ── system_events ──────────────────────────────────────────────────────────
export const querySystemEvents = (db: DB, userId: string, limit = 200) =>
  db.from("system_events").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);

// ── system_state ───────────────────────────────────────────────────────────
export const querySystemState = (db: DB, userId: string) =>
  db.from("system_state").select("*").eq("user_id", userId).maybeSingle();

// ── tool_calls ─────────────────────────────────────────────────────────────
export const queryToolCalls = (db: DB, userId: string, limit = 200) =>
  db.from("tool_calls").select("*").eq("user_id", userId).order("called_at", { ascending: false }).limit(limit);

// ── trade_signals ──────────────────────────────────────────────────────────
export const queryTradeSignals = (db: DB, userId: string, status?: string, limit = 50) => {
  let q = db.from("trade_signals").select("*").eq("user_id", userId);
  if (status) q = q.eq("status", status);
  return q.order("created_at", { ascending: false }).limit(limit);
};

// ── trades ─────────────────────────────────────────────────────────────────
export const queryTrades = (db: DB, userId: string, status?: string, limit = 500) => {
  let q = db.from("trades").select("*").eq("user_id", userId);
  if (status) q = q.eq("status", status);
  return q.order("opened_at", { ascending: false }).limit(limit);
};

export const queryOpenTrades = (db: DB, userId: string) =>
  queryTrades(db, userId, "open");

export const queryClosedTrades = (db: DB, userId: string) =>
  queryTrades(db, userId, "closed");

// ── war_room_messages ──────────────────────────────────────────────────────
export const queryWarRoomMessages = (db: DB, userId: string, limit = 100) =>
  db.from("war_room_messages").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(limit);

export const queryUnreadWarRoomMessages = (db: DB, userId: string) =>
  db.from("war_room_messages").select("*").eq("user_id", userId).eq("read_by_bobby", false).order("created_at", { ascending: false });

// ── views ──────────────────────────────────────────────────────────────────
export const queryStrategyPerformance = (db: DB, userId: string) =>
  db.from("strategy_performance_v").select("*").eq("user_id", userId);

export const queryStrategyPerformanceCI = (db: DB, userId: string) =>
  db.from("strategy_performance_ci_v").select("*").eq("user_id", userId);

export const queryStrategyRegimePerf = (db: DB, userId: string) =>
  db.from("strategy_regime_perf_v").select("*").eq("user_id", userId);

export const queryLiveExecutionStats = (db: DB, userId: string) =>
  db.from("live_execution_stats_v").select("*").eq("user_id", userId).maybeSingle();
