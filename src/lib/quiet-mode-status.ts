import type { Json } from "@/integrations/supabase/types";

export type QuietModeStatusMode = "normal" | "quiet" | "unknown";
export type CleanupStatus = "unknown" | "healthy" | "stale" | "failed";

export interface QuietModeStatusRpcRow {
  mode: string | null;
  latest_reason_codes: string[] | null;
  latest_skipped_scope: string | null;
  latest_surface: string | null;
  recommended_cadence_seconds: Json | null;
  next_recommended_check_at: string | null;
  safety_checks_preserved: boolean | null;
  last_quiet_event_at: string | null;
  last_cleanup_at: string | null;
  cleanup_status: string | null;
  cleanup_deleted_routine_event_count: number | null;
  cleanup_cron_configured: boolean | null;
  cleanup_result: string | null;
}

export interface QuietModeStatus {
  mode: QuietModeStatusMode;
  latestReasonCodes: string[];
  latestSkippedScope: string | null;
  latestSurface: string | null;
  recommendedCadenceSeconds: {
    bobby?: number;
    signalEngine?: number;
    marketIntelligence?: number;
  };
  nextRecommendedCheckAt: string | null;
  safetyChecksPreserved: boolean;
  lastQuietEventAt: string | null;
  lastCleanupAt: string | null;
  cleanupStatus: CleanupStatus;
  cleanupDeletedRoutineEventCount: number | null;
  cleanupCronConfigured: boolean | null;
  cleanupResult: string | null;
  isStale: boolean;
  isUnknown: boolean;
}

const SAFE_SKIPPED_SCOPES = new Set(["heavy_ai_only"]);
const SAFE_SURFACES = new Set(["bobby-orchestration", "signal-engine", "market-intelligence"]);
const SAFE_CLEANUP_RESULTS = new Set(["completed", "failed", "error", "unknown"]);

const DEFAULT_STATUS: QuietModeStatus = {
  mode: "unknown",
  latestReasonCodes: [],
  latestSkippedScope: null,
  latestSurface: null,
  recommendedCadenceSeconds: {},
  nextRecommendedCheckAt: null,
  safetyChecksPreserved: true,
  lastQuietEventAt: null,
  lastCleanupAt: null,
  cleanupStatus: "unknown",
  cleanupDeletedRoutineEventCount: null,
  cleanupCronConfigured: null,
  cleanupResult: null,
  isStale: false,
  isUnknown: true,
};

function safeMode(value: string | null | undefined): QuietModeStatusMode {
  return value === "quiet" || value === "normal" ? value : "unknown";
}

function safeCleanupStatus(value: string | null | undefined): CleanupStatus {
  return value === "healthy" || value === "stale" || value === "failed" ? value : "unknown";
}

function safeIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? value : null;
}

function safeString(value: string | null | undefined, allowList?: Set<string>): string | null {
  if (!value) return null;
  return allowList && !allowList.has(value) ? null : value;
}

function safeReasonCodes(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => /^[a-z0-9_:-]{1,64}$/.test(item))
    .slice(0, 8);
}

function jsonRecord(value: Json | null | undefined): Record<string, Json | undefined> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safePositiveNumber(value: Json | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeCadence(value: Json | null | undefined): QuietModeStatus["recommendedCadenceSeconds"] {
  const record = jsonRecord(value);
  return {
    bobby: safePositiveNumber(record.bobby),
    signalEngine: safePositiveNumber(record.signalEngine),
    marketIntelligence: safePositiveNumber(record.marketIntelligence),
  };
}

function minutesSince(value: string | null, now: Date): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return (now.getTime() - time) / 60_000;
}

export function mapQuietModeStatusRow(
  row: QuietModeStatusRpcRow | null | undefined,
  now: Date = new Date(),
): QuietModeStatus {
  if (!row) return DEFAULT_STATUS;

  const mode = safeMode(row.mode);
  const lastQuietEventAt = safeIso(row.last_quiet_event_at);
  const lastCleanupAt = safeIso(row.last_cleanup_at);
  const cleanupStatus = safeCleanupStatus(row.cleanup_status);
  const quietAgeMinutes = minutesSince(lastQuietEventAt, now);
  const cleanupAgeMinutes = minutesSince(lastCleanupAt, now);

  const isStale =
    (mode === "quiet" && quietAgeMinutes !== null && quietAgeMinutes > 30) ||
    (cleanupStatus === "healthy" && cleanupAgeMinutes !== null && cleanupAgeMinutes > 36 * 60) ||
    cleanupStatus === "stale";

  return {
    mode,
    latestReasonCodes: safeReasonCodes(row.latest_reason_codes),
    latestSkippedScope: safeString(row.latest_skipped_scope, SAFE_SKIPPED_SCOPES),
    latestSurface: safeString(row.latest_surface, SAFE_SURFACES),
    recommendedCadenceSeconds: safeCadence(row.recommended_cadence_seconds),
    nextRecommendedCheckAt: safeIso(row.next_recommended_check_at),
    safetyChecksPreserved: row.safety_checks_preserved === true,
    lastQuietEventAt,
    lastCleanupAt,
    cleanupStatus,
    cleanupDeletedRoutineEventCount:
      typeof row.cleanup_deleted_routine_event_count === "number" && row.cleanup_deleted_routine_event_count >= 0
        ? row.cleanup_deleted_routine_event_count
        : null,
    cleanupCronConfigured: typeof row.cleanup_cron_configured === "boolean" ? row.cleanup_cron_configured : null,
    cleanupResult: safeString(row.cleanup_result, SAFE_CLEANUP_RESULTS),
    isStale,
    isUnknown: mode === "unknown" || cleanupStatus === "unknown",
  };
}

export function emptyQuietModeStatus(): QuietModeStatus {
  return { ...DEFAULT_STATUS, latestReasonCodes: [], recommendedCadenceSeconds: {} };
}

export const QUIET_MODE_SAFETY_COPY =
  "Quiet Mode skips heavy AI only. Safety checks, incidents, kill switch, and open-position monitoring remain active.";
