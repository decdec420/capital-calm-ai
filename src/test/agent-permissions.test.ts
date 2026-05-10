import { describe, it, expect } from "vitest";
import {
  isAgentForbidden,
  assertAgentCanDo,
  getAgentPermissions,
  ALL_AGENT_IDS,
  AGENT_PERMISSIONS,
} from "@/lib/agent-permissions";

describe("agent permission matrix", () => {
  // ── Hard boundary tests ───────────────────────────────────────────────────

  it("Taylor cannot change doctrine", () => {
    expect(isAgentForbidden("taylor", "change_doctrine")).toBe(true);
  });

  it("Taylor cannot approve its own signals", () => {
    expect(isAgentForbidden("taylor", "approve_own_signals")).toBe(true);
  });

  it("BrainTrust cannot execute trades", () => {
    expect(isAgentForbidden("brainTrust", "execute_trades")).toBe(true);
  });

  it("BrainTrust cannot approve trades", () => {
    expect(isAgentForbidden("brainTrust", "approve_trades")).toBe(true);
  });

  it("Wendy cannot approve trades", () => {
    expect(isAgentForbidden("wendy", "approve_trades")).toBe(true);
  });

  it("Wendy cannot execute trades", () => {
    expect(isAgentForbidden("wendy", "execute_trades")).toBe(true);
  });

  it("Hall cannot approve trades", () => {
    expect(isAgentForbidden("hall", "approve_trades")).toBe(true);
  });

  it("Hall cannot execute trades", () => {
    expect(isAgentForbidden("hall", "execute_trades")).toBe(true);
  });

  it("Hall cannot bypass kill switch", () => {
    expect(isAgentForbidden("hall", "bypass_kill_switch")).toBe(true);
  });

  it("Wags cannot place live trade independently", () => {
    expect(isAgentForbidden("wags", "place_live_trade_independently")).toBe(true);
  });

  it("Wags cannot bypass doctrine", () => {
    expect(isAgentForbidden("wags", "bypass_doctrine")).toBe(true);
  });

  it("BrokerGateway cannot decide strategy", () => {
    expect(isAgentForbidden("brokerGateway", "decide_strategy")).toBe(true);
  });

  it("BrokerGateway cannot approve its own orders", () => {
    expect(isAgentForbidden("brokerGateway", "approve_own_orders")).toBe(true);
  });

  it("RiskDoctrine cannot generate trade ideas", () => {
    expect(isAgentForbidden("riskDoctrine", "generate_trade_ideas")).toBe(true);
  });

  it("RiskDoctrine cannot execute trades", () => {
    expect(isAgentForbidden("riskDoctrine", "execute_trades")).toBe(true);
  });

  // ── Transfer permission — all agents must forbid it ───────────────────────

  it("every agent forbids require_transfer_permission", () => {
    for (const agent of ALL_AGENT_IDS) {
      expect(
        isAgentForbidden(agent, "require_transfer_permission"),
        `${agent} should forbid require_transfer_permission`,
      ).toBe(true);
    }
  });

  // ── assertAgentCanDo throws when agent is forbidden ──────────────────────

  it("assertAgentCanDo throws for a forbidden action", () => {
    expect(() => assertAgentCanDo("taylor", "change_doctrine")).toThrow(
      /AgentPermissionViolation/,
    );
    expect(() => assertAgentCanDo("brainTrust", "execute_trades")).toThrow(
      /AgentPermissionViolation/,
    );
  });

  it("isAgentForbidden returns false for a permitted action (positive check)", () => {
    // Taylor CAN trigger signal_evaluation — it is NOT in forbidden list
    expect(isAgentForbidden("taylor", "signal_evaluation")).toBe(false);
    // Bobby CAN trigger directives
    expect(isAgentForbidden("bobby", "directives")).toBe(false);
  });

  // ── Structural integrity ──────────────────────────────────────────────────

  it("all agents have displayName, canRead, canTrigger, canWrite, forbidden", () => {
    for (const agent of ALL_AGENT_IDS) {
      const perms = getAgentPermissions(agent);
      expect(perms.displayName).toBeTruthy();
      expect(Array.isArray(perms.canRead)).toBe(true);
      expect(Array.isArray(perms.canTrigger)).toBe(true);
      expect(Array.isArray(perms.canWrite)).toBe(true);
      expect(Array.isArray(perms.forbidden)).toBe(true);
      expect(perms.forbidden.length).toBeGreaterThan(0);
    }
  });

  it("ALL_AGENT_IDS covers all keys in AGENT_PERMISSIONS", () => {
    const matrixKeys = Object.keys(AGENT_PERMISSIONS).sort();
    const listKeys = [...ALL_AGENT_IDS].sort();
    expect(listKeys).toEqual(matrixKeys);
  });
});
