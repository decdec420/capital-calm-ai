import type { CronHealthRow } from "@/lib/cron-health";
import type { ExecutionDataReadiness } from "@/lib/execution-data-readiness";
import type { PortfolioRiskSummary } from "@/lib/portfolio-risk";

export type PaperOpsReadinessStatus = "not_ready" | "ready_for_7_day_paper_run" | "blocked";
export type PaperOpsReadinessCheckStatus = "pass" | "warn" | "fail" | "unknown";

export type PaperOpsReadinessCheck = {
  id: string;
  label: string;
  status: PaperOpsReadinessCheckStatus;
};

export type PaperOpsReadiness = {
  status: PaperOpsReadinessStatus;
  blockers: string[];
  warnings: string[];
  checks: PaperOpsReadinessCheck[];
  liveExecutionAllowed: false;
};

export type PaperOpsReadinessInput = {
  liveModeEnabled?: boolean | null;
  brokerExecutionEnabled?: boolean | null;
  cronHealthRows?: CronHealthRow[] | null;
  requiredCronJobs?: string[] | null;
  quietModeVisible?: boolean | null;
  executionDataReadiness?: ExecutionDataReadiness | null;
  portfolioRisk?: PortfolioRiskSummary | null;
  opsIncidents?: Array<{ severity?: string | null; status?: string | null; acknowledgedAt?: string | null }> | null;
  opsTimelineVisible?: boolean | null;
  doctrineGatesVisible?: boolean | null;
  paperOnlyPathVisible?: boolean | null;
};

const DEFAULT_REQUIRED_CRON_JOBS = [
  "market-intelligence-4h",
  "signal-engine-tick",
  "process-decision-memory",
  "strategy-learning",
  "hall-tick-5m",
];

function addUnique(target: string[], message: string): void {
  if (!target.includes(message)) target.push(message);
}

function check(id: string, label: string, status: PaperOpsReadinessCheckStatus): PaperOpsReadinessCheck {
  return { id, label, status };
}

function cronJobMatches(row: CronHealthRow, requiredJob: string): boolean {
  return row.jobName === requiredJob || row.jobName.includes(requiredJob) || requiredJob.includes(row.jobName);
}

/**
 * Pure paper-ops readiness reducer. It never authorizes live execution; any live
 * mode/execution input is converted into a blocker while liveExecutionAllowed
 * remains the literal false value.
 */
export function assessPaperOpsReadiness(input: PaperOpsReadinessInput = {}): PaperOpsReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const checks: PaperOpsReadinessCheck[] = [];

  const liveModeEnabled = input.liveModeEnabled === true;
  const brokerExecutionEnabled = input.brokerExecutionEnabled === true;
  checks.push(check("live_mode_disabled", "Live mode disabled", liveModeEnabled ? "fail" : "pass"));
  checks.push(check("broker_execution_disabled", "Broker execution disabled or paper-only", brokerExecutionEnabled ? "fail" : "pass"));
  if (liveModeEnabled) addUnique(blockers, "Live mode is enabled; the 7-day run must be paper-only.");
  if (brokerExecutionEnabled) addUnique(blockers, "Broker execution appears enabled; disable live order placement before the paper run.");

  const cronRows = input.cronHealthRows ?? [];
  const requiredCronJobs = input.requiredCronJobs ?? DEFAULT_REQUIRED_CRON_JOBS;
  const criticalCronRows = cronRows.filter((row) => row.severity === "critical" || row.configured === false);
  const missingCronJobs = requiredCronJobs.filter((job) => !cronRows.some((row) => cronJobMatches(row, job)));
  checks.push(check(
    "cron_health",
    "Critical cron jobs visible and non-critical",
    cronRows.length === 0 ? "unknown" : criticalCronRows.length > 0 || missingCronJobs.length > 0 ? "fail" : cronRows.some((row) => row.severity === "warning") ? "warn" : "pass",
  ));
  if (cronRows.length === 0) addUnique(warnings, "Cron Health returned no rows; confirm cron.job and cron.job_run_details are visible.");
  criticalCronRows.forEach((row) => addUnique(blockers, `Cron job ${row.jobName} is ${row.configured ? row.severity : "missing/unconfigured"}.`));
  missingCronJobs.forEach((job) => addUnique(blockers, `Required cron job ${job} is not visible in Cron Health.`));

  const executionReadiness = input.executionDataReadiness ?? null;
  const executionStatus = !executionReadiness
    ? "unknown"
    : executionReadiness.readiness === "ready_for_research"
      ? "pass"
      : executionReadiness.readiness === "partial"
        ? "warn"
        : "warn";
  checks.push(check("execution_data_readiness", "Execution-data readiness stays honest", executionStatus));
  if (!executionReadiness) {
    addUnique(warnings, "Execution-data readiness panel data is missing.");
  } else if (executionReadiness.readiness !== "ready_for_research") {
    addUnique(warnings, `Execution-data readiness is ${executionReadiness.readiness}; keep maker/taker and live-execution research blocked.`);
  }

  checks.push(check("portfolio_risk", "Portfolio risk panel represented", input.portfolioRisk ? "pass" : "unknown"));
  if (!input.portfolioRisk) addUnique(warnings, "Portfolio risk summary is not present in the readiness input.");

  checks.push(check("doctrine_gates", "Doctrine/risk gates visible", input.doctrineGatesVisible === true ? "pass" : "unknown"));
  if (input.doctrineGatesVisible !== true) addUnique(warnings, "Doctrine/risk gate visibility was not confirmed.");

  checks.push(check("paper_only_path", "Paper-only proposal/trade path visible", input.paperOnlyPathVisible === true ? "pass" : "unknown"));
  if (input.paperOnlyPathVisible !== true) addUnique(warnings, "Paper-only proposal/trade path visibility was not confirmed.");

  checks.push(check("quiet_mode", "Quiet Mode status panel visible", input.quietModeVisible === true ? "pass" : "unknown"));
  if (input.quietModeVisible !== true) addUnique(warnings, "Quiet Mode status panel visibility was not confirmed.");

  const criticalIncidents = (input.opsIncidents ?? []).filter((incident) => {
    const open = incident.status !== "resolved" && !incident.acknowledgedAt;
    return incident.severity === "critical" && open;
  });
  checks.push(check("ops_timeline", "Hall/Ops timeline visible without open critical incidents", input.opsTimelineVisible !== true ? "unknown" : criticalIncidents.length > 0 ? "fail" : "pass"));
  if (input.opsTimelineVisible !== true) addUnique(warnings, "Hall/Ops timeline visibility was not confirmed.");
  if (criticalIncidents.length > 0) addUnique(blockers, `${criticalIncidents.length} open critical Hall/Ops incident(s) must be resolved before the 7-day run.`);

  const hasUnknownCore = checks.some((row) => row.status === "unknown");
  const status: PaperOpsReadinessStatus = blockers.length > 0
    ? "blocked"
    : hasUnknownCore
      ? "not_ready"
      : "ready_for_7_day_paper_run";

  return {
    status,
    blockers,
    warnings,
    checks,
    liveExecutionAllowed: false,
  };
}
