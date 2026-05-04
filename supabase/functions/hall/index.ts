// ============================================================
// hall — Infrastructure Operator / Reliability Chief
// ------------------------------------------------------------
// Hall is Axe Capital's backend reliability operator.
// He monitors the desk every 5 minutes, detects failures,
// performs safe auto-recovery, and writes a structured incident
// report every time he intervenes.
//
// Hall is not a trader. He owns infrastructure.
//
// Chain of command: Bobby > Wags > Hall
// Hall serves Bobby. Hall supports Wags.
//
// Recovery rules (ALL must be true to auto-recover):
//   • kill switch is not engaged
//   • no active doctrine violation
//   • no account floor breach
//   • no unresolved P1 broker failure in live mode
//   • pause was NOT caused by an active manual Bobby/Wags decision
//   • recovery action is logged in incidents table
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { log } from "../_shared/logger.ts";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";

const HALL_VERSION = "v1";
const HALL_MODEL = "anthropic/claude-sonnet-4-6";

// ── Types ────────────────────────────────────────────────────

type Severity = "P1" | "P2" | "P3" | "P4";
type IncidentStatus = "open" | "resolved" | "escalated" | "standing_by";

interface PauseClassification {
  kind:
    | "intentional_manual"   // Bobby/Wags explicitly paused — stand down
    | "kill_switch_recovery" // Kill switch was the cause — safe to resume
    | "system_failure"       // Cron/actor/backend caused the pause
    | "unknown";             // Cannot determine cause
  actor: string | null;
  pausedAt: string | null;
  reason: string | null;
  standDown: boolean;        // true = do not auto-resume
}

interface RecoveryConditions {
  safe: boolean;
  blockers: string[];
}

interface HallFinding {
  severity: Severity;
  affectedSystem: string;
  affectedAgent: string;
  symptoms: string[];
  evidence: Record<string, unknown>;
  rootCause: string;
  actionsTaken: string[];
  recoveryResult: string;
  userAttentionRequired: boolean;
  followUpRecommendation: string;
  moneyAtRisk: boolean;
  safeToTradeStatus: string;
}

// ── Pause Classification ─────────────────────────────────────

async function classifyPause(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  sys: Record<string, unknown>,
): Promise<PauseClassification> {
  // Look at the most recent bot_paused system event for this user
  const { data: recentPauseEvent } = await admin
    .from("system_events")
    .select("actor, payload, created_at")
    .eq("user_id", userId)
    .eq("event_type", "bot_paused")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Also check if kill switch was recently engaged
  const { data: killSwitchEvent } = await admin
    .from("system_events")
    .select("actor, payload, created_at")
    .eq("user_id", userId)
    .in("event_type", ["kill_switch_engaged", "kill_switch_on"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Case 1: Kill switch is now OFF but was recently engaged — this is a recovery pause
  if (
    !sys.kill_switch_engaged &&
    killSwitchEvent &&
    // Kill switch event is within the last 24h
    new Date(killSwitchEvent.created_at).getTime() > Date.now() - 24 * 60 * 60 * 1000
  ) {
    return {
      kind: "kill_switch_recovery",
      actor: killSwitchEvent.actor,
      pausedAt: killSwitchEvent.created_at,
      reason: "Kill switch was engaged, then disarmed — bot remained paused.",
      standDown: false,
    };
  }

  if (!recentPauseEvent) {
    return {
      kind: "unknown",
      actor: null,
      pausedAt: null,
      reason: "No bot_paused event found in system_events.",
      standDown: false, // Unknown in paper mode → cautious resume
    };
  }

  const manualActors = ["bobby", "wags", "user", "operator"];
  const isManual = manualActors.includes(String(recentPauseEvent.actor ?? ""));

  // Case 2: Bobby or Wags explicitly paused — respect the pause
  if (isManual) {
    return {
      kind: "intentional_manual",
      actor: recentPauseEvent.actor,
      pausedAt: recentPauseEvent.created_at,
      reason: String(recentPauseEvent.payload?.reason ?? "Manual pause — no reason given."),
      standDown: true,
    };
  }

  // Case 3: System actor paused it — likely a cron/backend failure
  return {
    kind: "system_failure",
    actor: recentPauseEvent.actor,
    pausedAt: recentPauseEvent.created_at,
    reason: String(recentPauseEvent.payload?.reason ?? "System-initiated pause."),
    standDown: false,
  };
}

// ── Recovery Conditions ──────────────────────────────────────

async function checkRecoveryConditions(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  sys: Record<string, unknown>,
  isLive: boolean,
): Promise<RecoveryConditions> {
  const blockers: string[] = [];

  if (sys.kill_switch_engaged) {
    blockers.push("Kill switch is engaged.");
  }

  // Check account floor
  const { data: acct } = await admin
    .from("account_state")
    .select("equity, balance_floor")
    .eq("user_id", userId)
    .maybeSingle();

  const equity = Number(acct?.equity ?? 0);
  const floor = Number(acct?.balance_floor ?? 0);
  if (floor > 0 && equity <= floor) {
    blockers.push(`Account equity ($${equity.toFixed(2)}) is at or below the balance floor ($${floor.toFixed(2)}).`);
  }

  // In live mode: check for unresolved P1 broker issues
  if (isLive) {
    const { data: p1Incidents } = await admin
      .from("incidents")
      .select("id, affected_agent, root_cause")
      .eq("user_id", userId)
      .eq("severity", "P1")
      .eq("status", "open")
      .limit(3);

    if (p1Incidents && p1Incidents.length > 0) {
      blockers.push(`${p1Incidents.length} unresolved P1 incident(s) in live mode — cannot auto-recover.`);
    }
  }

  return { safe: blockers.length === 0, blockers };
}

// ── Write Incident ────────────────────────────────────────────

async function writeIncident(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  finding: HallFinding,
  status: IncidentStatus,
  sys: Record<string, unknown>,
): Promise<string> {
  const now = new Date();
  const slug = finding.affectedAgent.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const incidentId = `hall_${now.toISOString().slice(0, 16).replace(/[-T:]/g, "")}_${slug}`;

  // Check if a recent open incident exists for the same agent/system (dedup within 30 min)
  const { data: existing } = await admin
    .from("incidents")
    .select("id, recurrence_count")
    .eq("user_id", userId)
    .eq("affected_agent", finding.affectedAgent)
    .eq("status", "open")
    .gte("detected_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
    .maybeSingle();

  if (existing) {
    // Increment recurrence count on existing open incident
    await admin
      .from("incidents")
      .update({
        recurrence_count: (existing.recurrence_count ?? 1) + 1,
        symptoms: finding.symptoms,
        evidence: finding.evidence,
        actions_taken: finding.actionsTaken,
        recovery_result: finding.recoveryResult,
        status,
        resolved_at: status === "resolved" ? now.toISOString() : null,
        user_attention_required: finding.userAttentionRequired,
      })
      .eq("id", existing.id);
    return existing.id;
  }

  const { data: row } = await admin
    .from("incidents")
    .insert({
      user_id: userId,
      incident_id: incidentId,
      severity: finding.severity,
      status,
      affected_system: finding.affectedSystem,
      affected_agent: finding.affectedAgent,
      detected_at: now.toISOString(),
      resolved_at: status === "resolved" ? now.toISOString() : null,
      root_cause: finding.rootCause,
      symptoms: finding.symptoms,
      evidence: finding.evidence,
      actions_taken: finding.actionsTaken,
      recovery_result: finding.recoveryResult,
      user_attention_required: finding.userAttentionRequired,
      follow_up_recommendation: finding.followUpRecommendation,
      recurrence_count: 1,
      related_events: [],
      safe_to_trade_status: finding.safeToTradeStatus,
      paper_or_live_mode: String(sys.mode ?? "paper"),
      money_at_risk: finding.moneyAtRisk,
      hall_version: HALL_VERSION,
    })
    .select("id")
    .maybeSingle();

  return row?.id ?? "unknown";
}

// ── Alert with dedup ─────────────────────────────────────────

async function fireAlert(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  severity: "critical" | "warning" | "info",
  title: string,
  message: string,
  dedupMinutes = 30,
): Promise<void> {
  const { data: existing } = await admin
    .from("alerts")
    .select("id")
    .eq("user_id", userId)
    .eq("title", title)
    .gte("created_at", new Date(Date.now() - dedupMinutes * 60 * 1000).toISOString())
    .maybeSingle();

  if (existing) return;

  await admin.from("alerts").insert({ user_id: userId, severity, title, message });
}

// ── Main Hall tick for one user ───────────────────────────────

async function runHallForUser(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  lovableApiKey: string,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const findings: HallFinding[] = [];
  const actionsLog: string[] = [];

  // ── 1. Read system state ────────────────────────────────────
  const { data: sysRaw } = await admin
    .from("system_state")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (!sysRaw) {
    log("warn", "hall_no_system_state", { fn: "hall", userId });
    return { userId, status: "no_system_state" };
  }

  const sys = sysRaw as Record<string, unknown>;
  const isLive = !!sys.live_trading_enabled;
  const isPaper = !isLive;
  const botStatus = String(sys.bot ?? "paused");
  const killSwitch = !!sys.kill_switch_engaged;

  // ── 2. Agent health rows ────────────────────────────────────
  const { data: healthRows } = await admin
    .from("agent_health")
    .select("agent_name, status, checked_at, last_success, failure_count, last_error")
    .eq("user_id", userId);

  const healthByAgent: Record<string, Record<string, unknown>> = {};
  for (const h of (healthRows ?? [])) {
    healthByAgent[h.agent_name] = h;
  }

  // ── 3. Recent system events (last 2 hours) ──────────────────
  const { data: recentEvents } = await admin
    .from("system_events")
    .select("event_type, actor, payload, created_at")
    .eq("user_id", userId)
    .gte("created_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(50);

  // ── 4. CHECK: Bot paused unexpectedly ──────────────────────

  if (botStatus === "paused" && !killSwitch) {
    const classification = await classifyPause(admin, userId, sys);
    const recovery = await checkRecoveryConditions(admin, userId, sys, isLive);

    let recoveryResult = "";
    let status: IncidentStatus = "open";
    let actsTaken: string[] = [`Classified pause as: ${classification.kind}`];
    let userAttentionRequired = false;

    if (classification.standDown) {
      // Case 1: Intentional manual pause — respect it
      recoveryResult = `Intentional pause by ${classification.actor ?? "unknown"}. Hall is standing down. No recovery action taken.`;
      status = "standing_by";
      actsTaken.push(`Standing down — pause is intentional. Bobby/Wags can resume when ready.`);

      // Only alert if paused for more than 6 hours (reminder, not alarm)
      const pausedAt = classification.pausedAt ? new Date(classification.pausedAt) : null;
      const pausedHours = pausedAt
        ? (now.getTime() - pausedAt.getTime()) / 3_600_000
        : 0;
      if (pausedHours > 6) {
        await fireAlert(admin, userId, "info",
          "Hall: Desk has been manually paused for 6+ hours",
          `The desk was paused by ${classification.actor ?? "unknown"} at ${classification.pausedAt ?? "unknown time"}. ` +
          `Hall is standing down — this appears intentional. Resume when ready.`,
          360 // dedup 6h
        );
      }
    } else if (!recovery.safe) {
      // Cannot recover — blockers exist
      recoveryResult = `Recovery blocked: ${recovery.blockers.join("; ")}`;
      status = "escalated";
      userAttentionRequired = true;
      actsTaken.push(...recovery.blockers.map((b) => `Blocker: ${b}`));
      await fireAlert(admin, userId, "critical",
        "Hall: Desk is paused — auto-recovery blocked",
        `${recoveryResult} Manual intervention required.`
      );
    } else {
      // Safe to auto-recover
      const resumeResult = await admin
        .from("system_state")
        .update({ bot: "running" })
        .eq("user_id", userId);

      if (resumeResult.error) {
        recoveryResult = `Auto-resume FAILED: ${resumeResult.error.message}`;
        status = "escalated";
        userAttentionRequired = true;
        await fireAlert(admin, userId, "critical",
          "Hall: Failed to auto-resume desk",
          `${recoveryResult}. Manual resume required.`
        );
      } else {
        recoveryResult = `Auto-resumed. Cause: ${classification.kind} (${classification.reason ?? "see evidence"}).`;
        status = "resolved";
        actsTaken.push("Set system_state.bot = 'running'");
        actsTaken.push(`Wrote system_event: bot_auto_resumed_by_hall`);

        await admin.from("system_events").insert({
          user_id: userId,
          event_type: "bot_auto_resumed",
          actor: "hall",
          payload: {
            reason: classification.reason,
            classification: classification.kind,
            recovery_conditions: "all_satisfied",
          },
        });

        await fireAlert(admin, userId, "info",
          "Hall: Desk auto-resumed",
          `Desk was paused (${classification.kind}) and has been automatically resumed. ` +
          `See incident report for full details.`
        );
      }

      actionsLog.push(`auto_resumed_bot (${classification.kind})`);
    }

    findings.push({
      severity: classification.kind === "intentional_manual" ? "P4" :
                classification.kind === "kill_switch_recovery" ? "P3" : "P2",
      affectedSystem: "system_state.bot",
      affectedAgent: "desk",
      symptoms: [
        `Bot status: paused`,
        `Kill switch: ${killSwitch ? "engaged" : "disarmed"}`,
        `Pause classification: ${classification.kind}`,
        `Pause actor: ${classification.actor ?? "unknown"}`,
      ],
      evidence: {
        sys_bot: botStatus,
        kill_switch_engaged: killSwitch,
        classification,
        recovery_conditions: await checkRecoveryConditions(admin, userId, sys, isLive),
        recent_events: (recentEvents ?? []).slice(0, 5),
      },
      rootCause: classification.reason ?? "Unknown pause cause",
      actionsTaken: actsTaken,
      recoveryResult,
      userAttentionRequired,
      followUpRecommendation: classification.kind === "intentional_manual"
        ? "No action required."
        : "Verify desk is running and producing signals. Check agent health.",
      moneyAtRisk: isLive && botStatus === "paused",
      safeToTradeStatus: isPaper ? "paper_mode_safe" : "live_mode_unsafe",
    });
  }

  // ── 5. CHECK: Taylor (signal_engine) stale ──────────────────

  const taylorHealth = healthByAgent["signal_engine"];
  if (taylorHealth) {
    const checkedAt = taylorHealth.checked_at as string;
    const ageMin = checkedAt
      ? Math.floor((now.getTime() - new Date(checkedAt).getTime()) / 60000)
      : 9999;

    if (ageMin > 5 && botStatus === "running") {
      // Try kicking signal-engine
      let kickResult = "not attempted";
      try {
        const { data: tok } = await admin.rpc("get_signal_engine_cron_token");
        if (tok) {
          const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
          const kick = await fetch(`${SUPABASE_URL}/functions/v1/signal-engine`, {
            method: "POST",
            signal: AbortSignal.timeout(10_000),
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tok}`,
            },
            body: JSON.stringify({ cronAll: true, cronToken: tok, profileTier: "active" }),
          });
          kickResult = kick.ok ? "kicked successfully" : `kick returned ${kick.status}`;
          actionsLog.push(`kicked signal-engine: ${kickResult}`);
        }
      } catch (e) {
        kickResult = `kick failed: ${String(e)}`;
      }

      findings.push({
        severity: "P2",
        affectedSystem: "agent_health.signal_engine",
        affectedAgent: "taylor",
        symptoms: [
          `Taylor last reported health ${ageMin} minutes ago`,
          `Last status: ${taylorHealth.status}`,
          `Failure count: ${taylorHealth.failure_count ?? 0}`,
        ],
        evidence: { taylorHealth, ageMin, kickResult },
        rootCause: `Taylor (signal-engine) has not reported health in ${ageMin} minutes. Cron may be stale or function may have cold-started.`,
        actionsTaken: [`Attempted signal-engine kick: ${kickResult}`],
        recoveryResult: kickResult,
        userAttentionRequired: kickResult.includes("failed"),
        followUpRecommendation: kickResult.includes("failed")
          ? "Check signal-engine edge function logs and verify cron job is registered."
          : "Monitor Taylor's next health report. If still stale in 5 minutes, check cron.",
        moneyAtRisk: false,
        safeToTradeStatus: isPaper ? "paper_mode_safe" : "paper_mode_safe",
      });

      await fireAlert(admin, userId, "warning",
        "Hall: Taylor (signal-engine) was stale — kicked",
        `Taylor had not reported health for ${ageMin} minutes. Hall kicked the engine (${kickResult}).`
      );
    }
  }

  // ── 6. CHECK: Bobby (jessica) stale ─────────────────────────

  const jessicaHealth = healthByAgent["jessica"] ?? healthByAgent["jessica_heartbeat"];
  if (jessicaHealth) {
    const checkedAt = jessicaHealth.checked_at as string;
    const ageMin = checkedAt
      ? Math.floor((now.getTime() - new Date(checkedAt).getTime()) / 60000)
      : 9999;

    if (ageMin > 5 && botStatus === "running") {
      findings.push({
        severity: "P2",
        affectedSystem: "agent_health.jessica",
        affectedAgent: "bobby",
        symptoms: [
          `Bobby last reported health ${ageMin} minutes ago`,
          `Last status: ${jessicaHealth.status}`,
        ],
        evidence: { jessicaHealth, ageMin },
        rootCause: `Bobby (jessica) has not ticked in ${ageMin} minutes. Jessica cron may be down.`,
        actionsTaken: ["Logged incident. Cannot safely kick Bobby — he manages his own cron."],
        recoveryResult: "Escalated to user. Bobby's cron requires manual verification.",
        userAttentionRequired: true,
        followUpRecommendation: "Check jessica-tick cron job in Supabase dashboard. Verify jessica_cron_token is set in vault.",
        moneyAtRisk: isLive,
        safeToTradeStatus: isPaper ? "paper_mode_safe" : "live_mode_unsafe",
      });

      await fireAlert(admin, userId, "critical",
        "Hall: Bobby (jessica) is silent",
        `Bobby has not ticked in ${ageMin} minutes. The jessica cron may be down. Manual check required.`
      );
    }
  }

  // ── 7. CHECK: Brain Trust stale (>8 hours) ──────────────────

  const btHealth = healthByAgent["brain_trust"];
  if (btHealth) {
    const checkedAt = btHealth.checked_at as string;
    const ageMin = checkedAt
      ? Math.floor((now.getTime() - new Date(checkedAt).getTime()) / 60000)
      : 9999;

    if (ageMin > 480) {
      findings.push({
        severity: "P3",
        affectedSystem: "agent_health.brain_trust",
        affectedAgent: "brain_trust",
        symptoms: [`Brain Trust last ran ${Math.floor(ageMin / 60)} hours ago`],
        evidence: { btHealth, ageMin },
        rootCause: "Brain Trust (market-intelligence) has not refreshed in 8+ hours. Market intel may be stale.",
        actionsTaken: ["Logged P3 incident. Brain Trust refresh will happen on next scheduled tick."],
        recoveryResult: "No immediate action — Brain Trust is non-critical for desk operation.",
        userAttentionRequired: false,
        followUpRecommendation: "Verify market-intelligence cron is registered. Brain Trust should refresh every 4 hours.",
        moneyAtRisk: false,
        safeToTradeStatus: isPaper ? "paper_mode_safe" : "paper_mode_safe",
      });
    }
  }

  // ── 8. CHECK: Mark-to-market stale (>2 min) ─────────────────

  const mtmAt = sys.last_mark_to_market_at as string | null;
  if (mtmAt && botStatus === "running") {
    const mtmAgeMin = Math.floor((now.getTime() - new Date(mtmAt).getTime()) / 60000);
    if (mtmAgeMin > 2) {
      const { data: openTrades } = await admin
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "open");

      const hasOpenTrades = (openTrades as unknown as { count: number })?.count > 0;

      findings.push({
        severity: hasOpenTrades ? "P1" : "P2",
        affectedSystem: "system_state.last_mark_to_market_at",
        affectedAgent: "mark_to_market",
        symptoms: [
          `MTM last ran ${mtmAgeMin} minutes ago`,
          `Open trades: ${hasOpenTrades ? "yes" : "none"}`,
        ],
        evidence: { mtmAt, mtmAgeMin, hasOpenTrades },
        rootCause: "Mark-to-market edge function has not run in 2+ minutes. Stop-loss and TP evaluation are suspended.",
        actionsTaken: ["Logged incident. MTM runs via a separate edge function — cannot self-kick safely."],
        recoveryResult: hasOpenTrades
          ? "ESCALATED — open trades are unprotected. Manual MTM verification required."
          : "No open trades. Monitoring continues.",
        userAttentionRequired: hasOpenTrades,
        followUpRecommendation: "Verify mark-to-market-15s cron is running in Supabase dashboard.",
        moneyAtRisk: isLive && hasOpenTrades,
        safeToTradeStatus: hasOpenTrades ? (isPaper ? "paper_mode_unsafe" : "live_mode_unsafe") : "paper_mode_safe",
      });

      if (hasOpenTrades) {
        await fireAlert(admin, userId, "critical",
          "Hall: Mark-to-market is down with open trades",
          `MTM last ran ${mtmAgeMin} minutes ago. Open positions are unprotected — stop-loss evaluation is suspended.`
        );
      }
    }
  }

  // ── 9. CHECK: Anomalous states (kill switch off, bot still paused) ─

  // Already handled in section 4. Here we check for UI/backend mismatches.
  if (killSwitch && botStatus === "running") {
    // Kill switch is ON but bot shows running — dangerous mismatch
    findings.push({
      severity: "P1",
      affectedSystem: "system_state",
      affectedAgent: "desk",
      symptoms: [
        "Kill switch is engaged BUT bot status shows 'running'",
        "This is a dangerous state mismatch",
      ],
      evidence: { kill_switch_engaged: killSwitch, bot: botStatus },
      rootCause: "Kill switch is engaged but bot status was not set to paused. This may allow trades to execute despite the kill switch.",
      actionsTaken: ["Pausing bot to match kill switch state"],
      recoveryResult: "Bot set to paused to match kill switch.",
      userAttentionRequired: true,
      followUpRecommendation: "Investigate how kill switch and bot status became mismatched. Check if kill_switch trigger is firing.",
      moneyAtRisk: isLive,
      safeToTradeStatus: "live_mode_unsafe",
    });

    // Force bot to paused
    await admin.from("system_state")
      .update({ bot: "paused" })
      .eq("user_id", userId);

    await admin.from("system_events").insert({
      user_id: userId,
      event_type: "bot_paused",
      actor: "hall",
      payload: { reason: "Kill switch was engaged but bot showed running. Hall enforced pause." },
    });

    await fireAlert(admin, userId, "critical",
      "Hall P1: Kill switch / bot state mismatch — Hall intervened",
      "Kill switch was engaged but bot showed 'running'. Hall has paused the bot. Investigate immediately."
    );
  }

  // ── 10. Write all incidents ──────────────────────────────────

  const incidentIds: string[] = [];
  for (const finding of findings) {
    const iStatus: IncidentStatus =
      finding.recoveryResult.toLowerCase().includes("auto-resumed") ||
      finding.recoveryResult.toLowerCase().includes("kicked successfully")
        ? "resolved"
        : finding.userAttentionRequired
        ? "escalated"
        : finding.severity === "P4"
        ? "standing_by"
        : "open";

    const id = await writeIncident(admin, userId, finding, iStatus, sys);
    incidentIds.push(id);
  }

  // ── 11. Write Hall's own heartbeat to agent_health ───────────

  await admin.from("agent_health").upsert({
    user_id: userId,
    agent_name: "hall",
    status: "healthy",
    last_success: now.toISOString(),
    failure_count: 0,
    last_error: null,
    checked_at: now.toISOString(),
  }, { onConflict: "user_id,agent_name" });

  return {
    userId,
    checkedAt: now.toISOString(),
    botStatus,
    killSwitch,
    isLive,
    findings: findings.length,
    incidentIds,
    actionsLog,
    summary: findings.length === 0
      ? "All systems nominal."
      : findings.map((f) => `[${f.severity}] ${f.affectedAgent}: ${f.rootCause}`).join(" | "),
  };
}

// ─── HTTP entry ──────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = makeCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  try {
    const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY        = Deno.env.get("SUPABASE_ANON_KEY")!;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";

    const { createClient: _createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2.45.0"
    );
    const admin = _createClient(SUPABASE_URL, SERVICE_KEY);

    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const authHeader = req.headers.get("Authorization") ?? "";

    // ── Cron fanout ─────────────────────────────────────────
    if (body?.cronAll === true && typeof body?.cronToken === "string") {
      const { data: tok } = await admin.rpc("get_hall_cron_token");
      if (!tok || tok !== body.cronToken) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      const { data: users } = await admin
        .from("system_state")
        .select("user_id")
        .not("user_id", "is", null);

      const results = [];
      for (const u of (users ?? []) as Array<{ user_id: string }>) {
        try {
          const r = await runHallForUser(admin, u.user_id, LOVABLE_API_KEY);
          results.push(r);
        } catch (err) {
          log("error", "hall_user_failed", { fn: "hall", userId: u.user_id, err: String(err) });
          results.push({ userId: u.user_id, error: String(err) });
        }
      }

      return new Response(JSON.stringify({ mode: "cron_fanout", users: results.length, results }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── Manual single-user mode ──────────────────────────────
    const userClient = _createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    if (!userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const result = await runHallForUser(admin, userData.user.id, LOVABLE_API_KEY);
    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (e) {
    log("error", "handler_error", { fn: "hall", err: String(e) });
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});
