import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { QuietModeStatusTile } from "@/components/hall/QuietModeStatusTile";
import {
  QUIET_MODE_SAFETY_COPY,
  mapQuietModeStatusRow,
  type QuietModeStatusRpcRow,
} from "@/lib/quiet-mode-status";

const quietStatusMock = vi.fn();

vi.mock("@/hooks/useQuietModeStatus", () => ({
  useQuietModeStatus: () => quietStatusMock(),
}));

const baseRow: QuietModeStatusRpcRow = {
  mode: "quiet",
  latest_reason_codes: ["no_open_positions", "paper_or_non_live_mode"],
  latest_skipped_scope: "heavy_ai_only",
  latest_surface: "signal-engine",
  recommended_cadence_seconds: { bobby: 300, signalEngine: 300, marketIntelligence: 900 },
  next_recommended_check_at: "2026-05-13T08:05:00.000Z",
  safety_checks_preserved: true,
  last_quiet_event_at: "2026-05-13T08:00:00.000Z",
  last_cleanup_at: "2026-05-13T03:17:00.000Z",
  cleanup_status: "healthy",
  cleanup_deleted_routine_event_count: 12,
  cleanup_cron_configured: null,
  cleanup_result: "completed",
};

function baseHookStatus() {
  return {
    ...mapQuietModeStatusRow(baseRow, new Date("2026-05-13T08:10:00.000Z")),
    loading: false,
    error: null,
    refetch: vi.fn(),
  };
}

describe("Quiet Mode status mapper", () => {
  it("maps latest quiet_mode_skip RPC data to quiet status", () => {
    const mapped = mapQuietModeStatusRow(baseRow, new Date("2026-05-13T08:10:00.000Z"));

    expect(mapped.mode).toBe("quiet");
    expect(mapped.latestReasonCodes).toEqual(["no_open_positions", "paper_or_non_live_mode"]);
    expect(mapped.latestSkippedScope).toBe("heavy_ai_only");
    expect(mapped.latestSurface).toBe("signal-engine");
    expect(mapped.safetyChecksPreserved).toBe(true);
    expect(mapped.nextRecommendedCheckAt).toBe("2026-05-13T08:05:00.000Z");
  });

  it("maps no recent quiet event to normal safely", () => {
    const mapped = mapQuietModeStatusRow({
      ...baseRow,
      mode: "normal",
      latest_reason_codes: [],
      latest_skipped_scope: null,
      latest_surface: null,
      last_quiet_event_at: null,
      next_recommended_check_at: null,
    });

    expect(mapped.mode).toBe("normal");
    expect(mapped.latestReasonCodes).toEqual([]);
    expect(mapped.latestSkippedScope).toBeNull();
    expect(mapped.lastQuietEventAt).toBeNull();
  });

  it("only exposes safe known payload-derived fields", () => {
    const mapped = mapQuietModeStatusRow({
      ...baseRow,
      latest_reason_codes: ["no_open_positions", "DROP TABLE", "raw secret value", "recent_news_pressure"],
      latest_skipped_scope: "all_safety_checks",
      latest_surface: "untrusted-function",
      recommended_cadence_seconds: { bobby: 300, unsafeRawPayload: 999 },
      cleanup_result: "raw-json-dump",
    });

    expect(mapped.latestReasonCodes).toEqual(["no_open_positions", "recent_news_pressure"]);
    expect(mapped.latestSkippedScope).toBeNull();
    expect(mapped.latestSurface).toBeNull();
    expect(mapped.recommendedCadenceSeconds).toEqual({ bobby: 300, signalEngine: undefined, marketIntelligence: undefined });
    expect(mapped.cleanupResult).toBeNull();
    expect(JSON.stringify(mapped)).not.toContain("unsafeRawPayload");
    expect(JSON.stringify(mapped)).not.toContain("raw-json-dump");
  });

  it("does not crash on unknown or malformed RPC payloads", () => {
    const mapped = mapQuietModeStatusRow({
      ...baseRow,
      mode: "not-a-mode",
      latest_reason_codes: null,
      recommended_cadence_seconds: "bad-shape",
      next_recommended_check_at: "not-a-date",
      last_quiet_event_at: "not-a-date",
      cleanup_status: "surprise",
    });

    expect(mapped.mode).toBe("unknown");
    expect(mapped.latestReasonCodes).toEqual([]);
    expect(mapped.recommendedCadenceSeconds).toEqual({ bobby: undefined, signalEngine: undefined, marketIntelligence: undefined });
    expect(mapped.nextRecommendedCheckAt).toBeNull();
    expect(mapped.cleanupStatus).toBe("unknown");
  });

  it("maps cleanup status healthy, stale, and unknown", () => {
    expect(mapQuietModeStatusRow({ ...baseRow, cleanup_status: "healthy" }).cleanupStatus).toBe("healthy");
    expect(mapQuietModeStatusRow({ ...baseRow, cleanup_status: "stale" }).cleanupStatus).toBe("stale");
    expect(mapQuietModeStatusRow({ ...baseRow, cleanup_status: null }).cleanupStatus).toBe("unknown");
  });
});

describe("QuietModeStatusTile", () => {
  it("shows safety checks preserved copy", () => {
    quietStatusMock.mockReturnValue(baseHookStatus());

    render(<QuietModeStatusTile />);

    expect(screen.getByText(QUIET_MODE_SAFETY_COPY)).toBeTruthy();
    expect(screen.getByText(/Safety checks preserved: yes/i)).toBeTruthy();
  });

  it("does not claim Quiet Mode disables safety checks", () => {
    quietStatusMock.mockReturnValue(baseHookStatus());

    render(<QuietModeStatusTile />);

    expect(screen.queryByText(/disable(s|d)? safety checks/i)).toBeNull();
    expect(screen.queryByText(/safety checks.*inactive/i)).toBeNull();
  });

  it("does not expose raw system_events payload", () => {
    quietStatusMock.mockReturnValue({
      ...baseHookStatus(),
      rawPayload: { secret: "SHOULD_NOT_RENDER" },
      latestReasonCodes: ["no_open_positions"],
    });

    render(<QuietModeStatusTile />);

    expect(screen.queryByText(/SHOULD_NOT_RENDER/)).toBeNull();
    expect(screen.queryByText(/rawPayload/)).toBeNull();
  });
});

describe("Quiet Mode status RPC migration", () => {
  const migration = readFileSync("supabase/migrations/20260513090000_quiet_mode_status_rpc.sql", "utf8");

  it("adds a read-only current status RPC", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.get_current_quiet_mode_status");
    expect(migration).toContain("LANGUAGE sql");
    expect(migration).toContain("STABLE");
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_current_quiet_mode_status[\s\S]*DELETE FROM public\./);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_current_quiet_mode_status[\s\S]*INSERT INTO public\./);
    expect(migration).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_current_quiet_mode_status[\s\S]*UPDATE public\./);
  });

  it("documents app-role cron catalog limitation", () => {
    expect(migration).toContain("Cron catalog visibility is intentionally not required for app roles");
    expect(migration).toContain("NULL::boolean AS cleanup_cron_configured");
  });
});
