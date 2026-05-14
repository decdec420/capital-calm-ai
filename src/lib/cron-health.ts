export type CronHealthCategory = "trading" | "market_data" | "learning" | "ops" | "retention" | "safety";
export type CronHealthLastStatus = "succeeded" | "failed" | "running" | "unknown";
export type CronHealthSeverity = "ok" | "info" | "warning" | "critical";

export type CronHealthRow = {
  jobName: string;
  category: CronHealthCategory;
  configured: boolean;
  lastRunAt: string | null;
  lastStatus: CronHealthLastStatus;
  lastSafeMessage: string | null;
  expectedEverySeconds: number | null;
  stale: boolean;
  severity: CronHealthSeverity;
  userAttentionRequired: boolean;
};

export type CronHealthSummary = {
  critical: number;
  warning: number;
  ok: number;
  unknown: number;
};

export type CronHealthResponse = {
  rows: CronHealthRow[];
  summary: CronHealthSummary;
  lastCheckedAt: string | null;
};

export type CronHealthRpcRow = {
  job_name?: unknown;
  jobName?: unknown;
  category?: unknown;
  configured?: unknown;
  last_run_at?: unknown;
  lastRunAt?: unknown;
  last_status?: unknown;
  lastStatus?: unknown;
  last_safe_message?: unknown;
  lastSafeMessage?: unknown;
  expected_every_seconds?: unknown;
  expectedEverySeconds?: unknown;
  stale?: unknown;
  severity?: unknown;
  user_attention_required?: unknown;
  userAttentionRequired?: unknown;
};

const CATEGORIES: CronHealthCategory[] = ["trading", "market_data", "learning", "ops", "retention", "safety"];
const STATUSES: CronHealthLastStatus[] = ["succeeded", "failed", "running", "unknown"];
const SEVERITIES: CronHealthSeverity[] = ["ok", "info", "warning", "critical"];
const SEVERITY_RANK: Record<CronHealthSeverity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

const SECRET_PATTERNS = [
  /bearer\s+[a-z0-9._~+\-/]+=*/i,
  /authorization/i,
  /cron[_-]?token/i,
  /service[_-]?role/i,
  /vault/i,
  /decrypted[_-]?secret/i,
  /headers?/i,
  /net\.http_post/i,
];

export function containsCronSecretMaterial(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function safeNullableIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeMessage(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (containsCronSecretMaterial(value)) return "Cron health details were sanitized.";
  return value.slice(0, 180);
}

export function mapCronHealthRow(row: CronHealthRpcRow): CronHealthRow {
  const category = safeString(row.category);
  const lastStatus = safeString(row.last_status ?? row.lastStatus);
  const severity = safeString(row.severity);

  return {
    jobName: safeString(row.job_name ?? row.jobName, "unknown-cron-job"),
    category: CATEGORIES.includes(category as CronHealthCategory) ? (category as CronHealthCategory) : "ops",
    configured: row.configured === true,
    lastRunAt: safeNullableIso(row.last_run_at ?? row.lastRunAt),
    lastStatus: STATUSES.includes(lastStatus as CronHealthLastStatus) ? (lastStatus as CronHealthLastStatus) : "unknown",
    lastSafeMessage: safeMessage(row.last_safe_message ?? row.lastSafeMessage),
    expectedEverySeconds: safeNullableNumber(row.expected_every_seconds ?? row.expectedEverySeconds),
    stale: row.stale === true,
    severity: SEVERITIES.includes(severity as CronHealthSeverity) ? (severity as CronHealthSeverity) : "warning",
    userAttentionRequired: row.user_attention_required === true || row.userAttentionRequired === true,
  };
}

export function sortCronHealthRows(rows: CronHealthRow[]): CronHealthRow[] {
  return [...rows].sort((a, b) => {
    const severityDelta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDelta !== 0) return severityDelta;
    if (a.userAttentionRequired !== b.userAttentionRequired) return a.userAttentionRequired ? -1 : 1;
    return a.jobName.localeCompare(b.jobName);
  });
}

export function summarizeCronHealth(rows: CronHealthRow[]): CronHealthSummary {
  return rows.reduce<CronHealthSummary>(
    (summary, row) => {
      if (row.severity === "critical") summary.critical += 1;
      else if (row.severity === "warning") summary.warning += 1;
      else if (row.severity === "ok") summary.ok += 1;
      else summary.unknown += 1;
      return summary;
    },
    { critical: 0, warning: 0, ok: 0, unknown: 0 },
  );
}

export function mapCronHealthResponse(payload: unknown, now: Date = new Date()): CronHealthResponse {
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const rawRows = Array.isArray(record.rows) ? record.rows : Array.isArray(payload) ? payload : [];
  const rows = sortCronHealthRows(rawRows.map((row) => mapCronHealthRow(row as CronHealthRpcRow)));

  return {
    rows,
    summary: summarizeCronHealth(rows),
    lastCheckedAt: safeNullableIso(record.lastCheckedAt ?? record.last_checked_at) ?? now.toISOString(),
  };
}
