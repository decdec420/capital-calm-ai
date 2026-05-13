import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/20260513080000_quiet_mode_retention_cron_dedup.sql", "utf8");

describe("system_events retention migration", () => {
  it("deletes routine old bobby_decision events", () => {
    expect(migration).toContain("se.event_type = 'bobby_decision'");
    expect(migration).toContain("interval '7 days'");
    expect(migration).toContain("DELETE FROM public.system_events");
  });

  it("deletes quiet_mode_skip events after the short retention window", () => {
    expect(migration).toContain("se.event_type = 'quiet_mode_skip'");
    expect(migration).toContain("interval '3 days'");
  });

  it("preserves AI_GUARD_REJECTED and AI_GUARD_FALLBACK instead of deleting them", () => {
    expect(migration).toContain("Preserves AI guard");
    expect(migration).not.toMatch(/se\.event_type\s+IN\s*\([^)]*AI_GUARD_REJECTED/);
    expect(migration).not.toMatch(/se\.event_type\s*=\s*'AI_GUARD_REJECTED'/);
    expect(migration).not.toMatch(/se\.event_type\s*=\s*'AI_GUARD_FALLBACK'/);
  });

  it("preserves kill switch, broker, trade, portfolio, and incident-linked events", () => {
    expect(migration).toContain("Preserves AI guard, kill switch, broker, incident, trade, portfolio-risk");
    expect(migration).toContain("NOT (se.payload ? 'incident_id')");
    expect(migration).toContain("NOT (se.payload ? 'incidentId')");
    expect(migration).toContain("COALESCE(se.payload->>'incident_linked', 'false') <> 'true'");
  });

  it("does not delete decision_memory or trade_signals", () => {
    expect(migration).not.toContain("DELETE FROM public.decision_memory");
    expect(migration).not.toContain("DELETE FROM public.trade_signals");
    expect(migration).toContain("does NOT touch trades");
  });
});
