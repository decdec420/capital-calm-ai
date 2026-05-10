// ============================================================
// Agent Permission Matrix — Authoritative
// ------------------------------------------------------------
// Defines what each agent can read, trigger, write, and is
// forbidden from doing. Used by Company.tsx for the UI roster
// and by tests to verify hard boundaries.
//
// Hard boundaries enforced here (must be tested):
//   - Taylor cannot change doctrine
//   - BrainTrust cannot execute trades
//   - Wendy cannot approve trades
//   - Hall cannot approve/execute trades
//   - Wags cannot place live trades independently
//   - BrokerGateway cannot decide strategy
//   - No role can require Transfer permission
//   - No role can bypass kill switch without an audited recovery path
// ============================================================

export const AGENT_PERMISSIONS = {
  bobby: {
    displayName: "Bobby",
    persona: "Desk Commander",
    canRead: [
      "all_operational_context",
      "war_room_messages",
      "agent_health",
      "system_state",
      "pending_signals",
    ],
    canTrigger: [
      "safe_refreshes",
      "directives",
      "engine_tick",
      "brain_trust_refresh",
      "signal_approval",
      "signal_rejection",
      "spyros_review",
    ],
    canWrite: [
      "war_room_messages",
      "bobby_directives",
      "system_events",
      "tool_calls",
    ],
    forbidden: [
      "bypass_doctrine",
      "bypass_kill_switch_without_audited_recovery",
      "place_live_trade_directly",
      "require_transfer_permission",
      "modify_risk_settings_unilaterally",
    ],
  },

  taylor: {
    displayName: "Taylor",
    persona: "Chief Quant / Signal Executor",
    canRead: [
      "market_data",
      "doctrine",
      "strategies",
      "bobby_directives",
      "account_state",
      "brain_trust_signals",
    ],
    canTrigger: [
      "signal_evaluation",
      "trade_proposal",
    ],
    canWrite: [
      "trade_signals",
      "trades",
      "system_events",
    ],
    forbidden: [
      "change_doctrine",
      "change_risk_settings",
      "approve_own_signals",
      "bypass_risk_gates",
      "require_transfer_permission",
    ],
  },

  brainTrust: {
    displayName: "Brain Trust",
    persona: "Market Intelligence (Hall, Dollar Bill, Mafee)",
    canRead: [
      "market_data",
      "candles",
      "public_price_feeds",
    ],
    canTrigger: [
      "intelligence_refresh",
    ],
    canWrite: [
      "brain_trust_signals",
      "market_intelligence",
    ],
    forbidden: [
      "execute_trades",
      "approve_trades",
      "change_doctrine",
      "issue_bobby_directives",
      "require_transfer_permission",
    ],
  },

  wendy: {
    displayName: "Wendy",
    persona: "Performance Coach",
    canRead: [
      "trades",
      "journal_entries",
      "strategy_performance",
      "war_room_messages",
    ],
    canTrigger: [
      "learning_updates",
      "experiment_proposals",
    ],
    canWrite: [
      "journal_entries",
      "war_room_messages",
    ],
    forbidden: [
      "approve_trades",
      "execute_trades",
      "change_doctrine",
      "issue_bobby_directives",
      "require_transfer_permission",
    ],
  },

  hall: {
    displayName: "Hall",
    persona: "Infrastructure Reliability Chief",
    canRead: [
      "agent_health",
      "alerts",
      "system_state",
      "incidents",
      "system_audit_log",
    ],
    canTrigger: [
      "safe_recovery",
      "auto_resume_system_caused_pauses",
      "signal_engine_kick",
    ],
    canWrite: [
      "incidents",
      "agent_health",
      "alerts",
    ],
    forbidden: [
      "approve_trades",
      "execute_trades",
      "bypass_kill_switch",
      "require_transfer_permission",
      "fight_bobby_intentional_pauses",
    ],
  },

  wags: {
    displayName: "Wags",
    persona: "Operator Copilot",
    canRead: [
      "status",
      "alerts",
      "tools",
      "war_room_messages",
      "system_state",
    ],
    canTrigger: [
      "safe_recovery_tools",
      "test_tools",
      "doctrine_proposals",
    ],
    canWrite: [
      "tool_calls",
    ],
    forbidden: [
      "place_live_trade_independently",
      "bypass_doctrine",
      "bypass_kill_switch",
      "require_transfer_permission",
    ],
  },

  brokerGateway: {
    displayName: "Broker Gateway",
    persona: "Execution Interface",
    canRead: [
      "approved_orders",
    ],
    canTrigger: [
      "broker_api_calls",
    ],
    canWrite: [
      "trades",
      "system_events",
    ],
    forbidden: [
      "decide_strategy",
      "approve_own_orders",
      "require_transfer_permission",
      "bypass_doctrine",
      "access_unapproved_orders",
    ],
  },

  riskDoctrine: {
    displayName: "Risk / Doctrine",
    persona: "Governance Layer",
    canRead: [
      "all_risk_context",
      "doctrine_settings",
      "account_state",
      "trades",
    ],
    canTrigger: [
      "gate_decisions",
      "doctrine_activation",
    ],
    canWrite: [
      "doctrine_settings",
      "guardrails",
      "system_events",
    ],
    forbidden: [
      "generate_trade_ideas",
      "execute_trades",
      "approve_trades",
      "require_transfer_permission",
    ],
  },
} as const;

export type AgentId = keyof typeof AGENT_PERMISSIONS;

type ForbiddenActionsFor<A extends AgentId> =
  (typeof AGENT_PERMISSIONS)[A]["forbidden"][number];

/**
 * Returns true when the given agent is forbidden from performing the action.
 * Actions are matched by exact string equality.
 */
export function isAgentForbidden(agent: AgentId, action: string): boolean {
  const forbidden = AGENT_PERMISSIONS[agent].forbidden as readonly string[];
  return forbidden.includes(action);
}

/**
 * Precondition guard: throws an AgentPermissionViolation error if the agent is
 * forbidden from performing the action. Call before executing any sensitive
 * operation to enforce hard boundaries at runtime.
 *
 * Naming convention: "assert agent CAN do X" — if it CAN'T, it throws.
 */
export function assertAgentCanDo<A extends AgentId>(
  agent: A,
  action: ForbiddenActionsFor<A>
): void {
  if (isAgentForbidden(agent, action)) {
    throw new Error(
      `[AgentPermissionViolation] ${AGENT_PERMISSIONS[agent].displayName} (${agent}) is forbidden from: ${action}`,
    );
  }
}

/** @deprecated Use assertAgentCanDo instead. */
export const assertAgentCannotDo = assertAgentCanDo;

/**
 * Returns the full permission record for an agent.
 * Useful for the Company page roster and for diagnostics.
 */
export function getAgentPermissions(agent: AgentId) {
  return AGENT_PERMISSIONS[agent];
}

/** All agent IDs in canonical order. */
export const ALL_AGENT_IDS: AgentId[] = [
  "bobby",
  "taylor",
  "brainTrust",
  "wendy",
  "hall",
  "wags",
  "brokerGateway",
  "riskDoctrine",
] as const;
