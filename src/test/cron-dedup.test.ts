import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/20260513080000_quiet_mode_retention_cron_dedup.sql", "utf8");

describe("cron dedup migration", () => {
  it("removes or avoids redundant signal-engine jobs", () => {
    expect(migration).toContain("cron.unschedule('signal-engine-tick-active')");
    expect(migration).toContain("signal-engine-tick-aggressive");
    expect(migration).toContain("cannot double-fire Taylor");
  });

  it("preserves required safety jobs", () => {
    expect(migration).toContain("Do not unschedule jessica-tick");
    expect(migration).toContain("mark-to-market-15s");
    expect(migration).toContain("safety coverage remains visible");
    expect(migration).not.toContain("cron.unschedule('mark-to-market-15s')");
  });

  it("schedules one database-local cleanup job without creating duplicate HTTP work", () => {
    expect(migration).toContain("cleanup-routine-system-events-daily");
    expect(migration).toContain("public.cleanup_routine_system_events(now())");
    expect(migration).toContain("no duplicate HTTP job");
  });
});
