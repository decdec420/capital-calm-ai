import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { CronHealthPanel } from "@/components/hall/CronHealthPanel";
import { containsCronSecretMaterial, mapCronHealthResponse, sortCronHealthRows, type CronHealthRow } from "@/lib/cron-health";

const cronHealthMock = vi.fn();

vi.mock("@/hooks/useCronHealth", () => ({
  useCronHealth: () => cronHealthMock(),
}));

const migration = readFileSync("supabase/migrations/20260513100000_cron_health_status.sql", "utf8");
const edgeFunction = readFileSync("supabase/functions/cron-health/index.ts", "utf8");
const hookSource = readFileSync("src/hooks/useCronHealth.ts", "utf8");

function row(overrides: Partial<CronHealthRow> = {}): CronHealthRow {
  return {
    jobName: "cleanup-routine-system-events-daily",
    category: "retention",
    configured: true,
    lastRunAt: "2026-05-13T03:17:00.000Z",
    lastStatus: "succeeded",
    lastSafeMessage: "Last run completed.",
    expectedEverySeconds: 86400,
    stale: false,
    severity: "ok",
    userAttentionRequired: false,
    ...overrides,
  };
}

describe("cron health response mapper", () => {
  it("maps configured + recent success to ok", () => {
    const mapped = mapCronHealthResponse({
      rows: [{
        job_name: "cleanup-routine-system-events-daily",
        category: "retention",
        configured: true,
        last_run_at: "2026-05-13T03:17:00.000Z",
        last_status: "succeeded",
        last_safe_message: "Last run completed.",
        expected_every_seconds: 86400,
        stale: false,
        severity: "ok",
        user_attention_required: false,
      }],
      lastCheckedAt: "2026-05-13T08:00:00.000Z",
    });

    expect(mapped.rows[0]).toMatchObject({
      jobName: "cleanup-routine-system-events-daily",
      configured: true,
      lastStatus: "succeeded",
      severity: "ok",
      stale: false,
    });
    expect(mapped.summary.ok).toBe(1);
  });

  it("sanitizes raw cron command text, auth headers, bearer tokens, and Vault material", () => {
    const mapped = mapCronHealthResponse({
      rows: [{
        job_name: "signal-engine-tick-aggressive",
        category: "trading",
        configured: true,
        last_status: "failed",
        last_safe_message: "SELECT net.http_post(headers := jsonb_build_object('Authorization','Bearer secret'), body := jsonb_build_object('cronToken', vault.decrypted_secret))",
        expected_every_seconds: 60,
        stale: false,
        severity: "warning",
        user_attention_required: true,
      }],
    }, new Date("2026-05-13T08:00:00.000Z"));

    const serialized = JSON.stringify(mapped);
    expect(mapped.rows[0].lastSafeMessage).toBe("Cron health details were sanitized.");
    expect(serialized).not.toContain("net.http_post");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("cronToken");
    expect(serialized).not.toContain("vault");
    expect(containsCronSecretMaterial("Authorization: Bearer abc.def")).toBe(true);
  });

  it("sorts critical and warning jobs first", () => {
    const sorted = sortCronHealthRows([
      row({ jobName: "ok-job", severity: "ok" }),
      row({ jobName: "warning-job", severity: "warning", userAttentionRequired: true }),
      row({ jobName: "critical-job", severity: "critical", userAttentionRequired: true }),
    ]);

    expect(sorted.map((r) => r.jobName)).toEqual(["critical-job", "warning-job", "ok-job"]);
  });
});

describe("cron health migration and Edge Function", () => {
  it("adds a service-role-only sanitized read path over cron.job and cron.job_run_details", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.get_cron_health_status");
    expect(migration).toContain("FROM cron.job j");
    expect(migration).toContain("FROM cron.job_run_details d");
    expect(migration).toContain("REVOKE ALL ON FUNCTION public.get_cron_health_status");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.get_cron_health_status(uuid, timestamptz) TO service_role");
    expect(edgeFunction).toContain('admin.rpc("get_cron_health_status"');
  });

  it("tracks the critical known cron catalog using current repo names", () => {
    [
      "cleanup-routine-system-events-daily",
      "signal-engine-tick-aggressive",
      "market-intelligence-1m",
      "jessica-tick",
      "mark-to-market-15s",
      "process-decision-memory-10m",
      "enrich-simulations-15m",
      "process-strategy-learning-15m",
      "hall-tick-5m",
    ].forEach((jobName) => expect(migration).toContain(jobName));
  });

  it("classifies missing critical and mark-to-market open-position failures as critical", () => {
    expect(migration).toContain("NOT cl.configured AND (cl.critical_when_missing OR (cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions)) THEN 'critical'");
    expect(migration).toContain("cl.last_status = 'failed' AND cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions THEN 'critical'");
    expect(migration).toContain("cl.stale AND cl.job_name = 'mark-to-market-15s' AND cl.has_open_positions THEN 'critical'");
  });

  it("classifies failed and stale cleanup as warning, not critical", () => {
    expect(migration).toContain("('cleanup-routine-system-events-daily'::text, 'retention'::text, 86400::integer, 2.0::numeric, false::boolean");
    expect(migration).toContain("WHEN cl.last_status = 'failed' THEN 'warning'");
    expect(migration).toContain("WHEN cl.stale THEN 'warning'");
  });

  it("classifies stale signal-engine as warning without changing mode rules", () => {
    expect(migration).toContain("('signal-engine-tick-aggressive', 'trading', 60, 5.0, false, false)");
    expect(migration).toContain("WHEN cl.stale THEN 'warning'");
    expect(migration).not.toContain("quiet_mode_activation_threshold");
  });

  it("does not expose raw command, headers, bearer tokens, or Vault data", () => {
    expect(migration).not.toMatch(/SELECT[\s\S]*j\.command[\s\S]*AS/);
    expect(migration).not.toMatch(/return_message[\s\S]*AS last_safe_message/);
    expect(edgeFunction).toContain("containsSecretMaterial(body)");
    expect(edgeFunction).not.toContain("command:");
  });

  it("hook consumes only the sanitized Edge Function output and never raw cron tables", () => {
    expect(hookSource).toContain('supabase.functions.invoke("cron-health"');
    expect(hookSource).toContain("mapCronHealthResponse(data)");
    expect(hookSource).not.toContain("cron.job");
    expect(hookSource).not.toContain("cron.job_run_details");
    expect(hookSource).not.toContain("get_cron_health_status");
  });

  it("does not mutate doctrine, trades, signals, or trading behavior", () => {
    const combined = `${migration}\n${edgeFunction}`;
    expect(combined).not.toMatch(/INSERT INTO public\.(trades|trade_signals|doctrine)/i);
    expect(combined).not.toMatch(/UPDATE public\.(trades|trade_signals|doctrine)/i);
    expect(combined).not.toMatch(/approve_signal|broker-execute|broker_execute/i);
    expect(combined).not.toMatch(/cron\.schedule\(|cron\.unschedule\(/i);
  });
});

describe("CronHealthPanel", () => {
  beforeEach(() => {
    cronHealthMock.mockReset();
  });

  it("shows critical/warning jobs before ok jobs and states secrets are hidden", () => {
    cronHealthMock.mockReturnValue({
      loading: false,
      error: null,
      rows: [
        row({ jobName: "mark-to-market-15s", category: "safety", severity: "critical", lastStatus: "failed", lastSafeMessage: "Last run failed. Check Supabase Cron logs with admin access.", userAttentionRequired: true }),
        row({ jobName: "cleanup-routine-system-events-daily", severity: "warning", stale: true, lastSafeMessage: "No recent successful run inside expected window.", userAttentionRequired: true }),
        row({ jobName: "signal-engine-tick-aggressive", category: "trading", severity: "ok" }),
      ],
      summary: { critical: 1, warning: 1, ok: 1, unknown: 0 },
      lastCheckedAt: "2026-05-13T08:00:00.000Z",
      refetch: vi.fn(),
    });

    render(<CronHealthPanel />);

    expect(screen.getByText("Cron Health")).toBeTruthy();
    expect(screen.getByText(/Raw cron commands and secrets are never shown/i)).toBeTruthy();
    expect(screen.getByText("mark-to-market-15s")).toBeTruthy();
    expect(screen.getByText("cleanup-routine-system-events-daily")).toBeTruthy();
    expect(screen.queryByText("signal-engine-tick-aggressive")).toBeNull();

    const text = document.body.textContent ?? "";
    expect(text.indexOf("mark-to-market-15s")).toBeLessThan(text.indexOf("cleanup-routine-system-events-daily"));
  });
});
