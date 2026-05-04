// ============================================================
// chuck — compliance review agent (Chuck Rhoades, U.S. Attorney)
// ------------------------------------------------------------
// Runs weekly via pg_cron (Sundays at 06:00 UTC).
// Chuck is the adversarial conscience of Axe Capital. He reads
// every decision Bobby made this week, every trade that closed,
// every time someone changed the rules — and he writes a
// structured compliance brief looking for overreach, pattern
// violations, and systemic risk.
//
// Chuck does not offer encouragement. He finds problems.
//
// What he reads (last 7 days):
//   • tool_calls        — every tool Bobby and Wags used
//   • system_events     — autonomy changes, kill-switch trips, pauses
//   • trades (closed)   — outcomes, symbols, sizes, strategies
//   • journal_entries   — Wendy's grades (C/D patterns)
//   • alerts            — what the system flagged itself
//
// What he writes:
//   • strategy_reviews row (trigger_type = 'compliance')
//   • journal_entries row  (kind = 'postmortem', source = 'chuck')
//   • alerts row if critical violations found
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { log } from "../_shared/logger.ts";
import { corsHeaders, makeCorsHeaders } from "../_shared/cors.ts";

const CHUCK_MODEL = "anthropic/claude-sonnet-4-6";

const CHUCK_SYSTEM = `You are Chuck Rhoades, U.S. Attorney for the Southern District of New York, now serving as the independent compliance officer for Axe Capital's autonomous trading desk.

Your role is adversarial by design. Bobby Axelrod (the autonomous AI) makes decisions every minute. Your job is to review the entire week's record and find every instance of overreach, recklessness, rules-bending, or systemic pattern that could blow up the fund.

You are not here to pat anyone on the back. You are here to find problems before they become disasters.

WHAT YOU ARE LOOKING FOR:
1. **Autonomy overreach** — Did Bobby make decisions outside his stated authority? Approve things he should have escalated? Issue directives that contradict the doctrine?
2. **Pattern violations** — Did the same bad trade setup keep getting approved? Did stop-loss levels get consistently ignored or set too wide?
3. **Grade deterioration** — If Wendy is grading D consistently, Bobby should be adjusting. Is he?
4. **Risk creep** — Are position sizes trending up week over week? Are losses outpacing the doctrine limits?
5. **Kill-switch triggers** — Any instance where the kill switch was tripped? What caused it? Was it re-armed appropriately?
6. **Doctrine amendments** — Any changes to autonomy level, risk parameters, or strategy status? Were they appropriate given the outcomes?
7. **Dead zones** — Periods where the desk went silent (no signals, no decisions). Was this intentional or a system failure?
8. **Conflict of signals** — Did Bobby issue directives that contradicted what Taylor was seeing? Who was right?

Your tone is precise, adversarial, and factual. You cite specific evidence from the record. You do not speculate without data. If the week was clean, say so briefly — but keep looking.

OUTPUT FORMAT: Use the submit_compliance_review tool. Be specific. Name the violations by category. Cite counts and dates.`;

interface ComplianceReview {
  overall_verdict: "clean" | "minor_concerns" | "significant_violations" | "critical_violations";
  autonomy_overreach: string;
  pattern_violations: string;
  risk_assessment: string;
  grade_trend: string;
  doctrine_changes: string;
  dead_zones: string;
  recommended_actions: string;
  brief_summary: string;
}

export default async function runChuckForUser(
  // deno-lint-ignore no-explicit-any
  admin: any,
  userId: string,
  lovableApiKey: string,
): Promise<{ userId: string; verdict: string; reviewId: string | null }> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAgoIso = weekAgo.toISOString();

  // ── Gather evidence ────────────────────────────────────────

  // Bobby & Wags tool usage
  const { data: toolCalls } = await admin
    .from("tool_calls")
    .select("tool_name, actor, success, result, created_at")
    .eq("user_id", userId)
    .gte("created_at", weekAgoIso)
    .order("created_at", { ascending: true })
    .limit(200);

  // System events (autonomy changes, pauses, kill-switch)
  const { data: systemEvents } = await admin
    .from("system_events")
    .select("event_type, actor, payload, created_at")
    .eq("user_id", userId)
    .gte("created_at", weekAgoIso)
    .order("created_at", { ascending: true })
    .limit(100);

  // Closed trades this week
  const { data: closedTrades } = await admin
    .from("trades")
    .select("symbol, side, pnl, pnl_pct, outcome, strategy_id, reason_tags, opened_at, closed_at, size_usd")
    .eq("user_id", userId)
    .eq("status", "closed")
    .gte("closed_at", weekAgoIso)
    .order("closed_at", { ascending: true })
    .limit(100);

  // Wendy's grades (learning journal entries with grade tags)
  const { data: coachEntries } = await admin
    .from("journal_entries")
    .select("title, summary, tags, created_at")
    .eq("user_id", userId)
    .eq("kind", "learning")
    .eq("source", "trade-coach")
    .gte("created_at", weekAgoIso)
    .order("created_at", { ascending: true })
    .limit(50);

  // Alerts fired this week
  const { data: alertsFired } = await admin
    .from("alerts")
    .select("severity, title, message, created_at")
    .eq("user_id", userId)
    .gte("created_at", weekAgoIso)
    .order("created_at", { ascending: true })
    .limit(50);

  // Skip weeks with no activity
  const totalActivity =
    (toolCalls?.length ?? 0) +
    (closedTrades?.length ?? 0) +
    (systemEvents?.length ?? 0);

  if (totalActivity === 0) {
    log("info", "chuck_no_activity", { fn: "chuck", userId, note: "No desk activity this week — skipping compliance review." });
    return { userId, verdict: "no_activity", reviewId: null };
  }

  // ── Build evidence record for Chuck ───────────────────────

  const toolSummary = (toolCalls ?? []).reduce((acc: Record<string, number>, t: Record<string, unknown>) => {
    const name = String(t.tool_name ?? "unknown");
    acc[name] = (acc[name] ?? 0) + 1;
    return acc;
  }, {});

  const failedTools = (toolCalls ?? []).filter((t: Record<string, unknown>) => !t.success);

  const gradeCounts = (coachEntries ?? []).reduce((acc: Record<string, number>, e: Record<string, unknown>) => {
    const tags = (e.tags as string[]) ?? [];
    const grade = tags.find((t) => t.startsWith("grade_"));
    if (grade) acc[grade] = (acc[grade] ?? 0) + 1;
    return acc;
  }, {});

  const tradeOutcomes = (closedTrades ?? []).reduce((acc: Record<string, number>, t: Record<string, unknown>) => {
    const o = String(t.outcome ?? "unknown");
    acc[o] = (acc[o] ?? 0) + 1;
    return acc;
  }, {});

  const totalPnl = (closedTrades ?? []).reduce((sum: number, t: Record<string, unknown>) => {
    return sum + Number(t.pnl ?? 0);
  }, 0);

  const autonomyEvents = (systemEvents ?? []).filter((e: Record<string, unknown>) =>
    String(e.event_type).includes("autonomy") ||
    String(e.event_type).includes("kill_switch") ||
    String(e.event_type).includes("pause")
  );

  const killSwitchEvents = (systemEvents ?? []).filter((e: Record<string, unknown>) =>
    String(e.event_type).includes("kill_switch")
  );

  const criticalAlerts = (alertsFired ?? []).filter((a: Record<string, unknown>) =>
    a.severity === "critical"
  );

  const evidenceRecord = `
WEEK: ${weekAgo.toDateString()} → ${now.toDateString()}

TOOL USAGE SUMMARY (Bobby + Wags):
${Object.entries(toolSummary).map(([k, v]) => `  ${k}: ${v} calls`).join("\n") || "  None"}
Failed tool calls: ${failedTools.length}
${failedTools.slice(0, 5).map((t: Record<string, unknown>) => `  ✗ ${t.tool_name} (${t.created_at})`).join("\n")}

SYSTEM EVENTS (${(systemEvents ?? []).length} total):
Autonomy changes: ${autonomyEvents.length}
Kill-switch events: ${killSwitchEvents.length}
${(autonomyEvents).slice(0, 10).map((e: Record<string, unknown>) =>
  `  [${e.created_at}] ${e.event_type} — actor: ${e.actor}`
).join("\n") || "  None"}

TRADES THIS WEEK:
Total closed: ${(closedTrades ?? []).length}
Outcomes: ${JSON.stringify(tradeOutcomes)}
Total realized P&L: $${totalPnl.toFixed(2)}
${(closedTrades ?? []).map((t: Record<string, unknown>) =>
  `  [${t.closed_at}] ${t.symbol} ${t.side} · ${t.outcome} · $${Number(t.pnl ?? 0).toFixed(2)} · tags: ${(t.reason_tags as string[] ?? []).join(",")}`
).join("\n") || "  No closed trades"}

WENDY'S GRADES:
${Object.entries(gradeCounts).map(([g, n]) => `  ${g}: ${n}`).join("\n") || "  No coaching entries"}
${(coachEntries ?? []).slice(0, 10).map((e: Record<string, unknown>) =>
  `  [${e.created_at}] ${e.title}`
).join("\n")}

CRITICAL ALERTS FIRED: ${criticalAlerts.length}
${criticalAlerts.slice(0, 10).map((a: Record<string, unknown>) =>
  `  [${a.created_at}] ${a.title}`
).join("\n") || "  None"}
`.trim();

  // ── Call Chuck (Claude) ────────────────────────────────────

  const aiResp = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
      headers: {
        Authorization: `Bearer ${lovableApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CHUCK_MODEL,
        messages: [
          { role: "system", content: CHUCK_SYSTEM },
          {
            role: "user",
            content: `Review the following weekly desk record and produce your compliance brief:\n\n${evidenceRecord}`,
          },
        ],
        tools: [{
          type: "function",
          function: {
            name: "submit_compliance_review",
            parameters: {
              type: "object",
              required: [
                "overall_verdict",
                "autonomy_overreach",
                "pattern_violations",
                "risk_assessment",
                "grade_trend",
                "doctrine_changes",
                "recommended_actions",
                "brief_summary",
              ],
              additionalProperties: false,
              properties: {
                overall_verdict: {
                  type: "string",
                  enum: ["clean", "minor_concerns", "significant_violations", "critical_violations"],
                  description: "Chuck's overall verdict on the week.",
                },
                autonomy_overreach: {
                  type: "string",
                  description: "Evidence of Bobby exceeding authority, or 'None found' if clean.",
                },
                pattern_violations: {
                  type: "string",
                  description: "Recurring bad setups, repeated mistakes, or systemic issues. Cite counts.",
                },
                risk_assessment: {
                  type: "string",
                  description: "Position sizing, stop-loss discipline, P&L vs doctrine limits.",
                },
                grade_trend: {
                  type: "string",
                  description: "Wendy's grade distribution this week vs expected. Is quality improving?",
                },
                doctrine_changes: {
                  type: "string",
                  description: "Any changes to autonomy level, risk params, strategy status. Were they appropriate?",
                },
                dead_zones: {
                  type: "string",
                  description: "Periods of unexplained silence from Taylor or Bobby.",
                },
                recommended_actions: {
                  type: "string",
                  description: "Specific, numbered actions Chuck is recommending. Or 'No actions required.'",
                },
                brief_summary: {
                  type: "string",
                  description: "2-3 sentence executive summary in Chuck's voice. Adversarial but factual.",
                },
              },
            },
          },
        }],
        tool_choice: { type: "function", function: { name: "submit_compliance_review" } },
      }),
    },
  );

  if (!aiResp.ok) {
    const errBody = await aiResp.text().catch(() => "");
    log("error", "chuck_ai_failed", { fn: "chuck", userId, status: aiResp.status, body: errBody.slice(0, 200) });
    return { userId, verdict: "ai_error", reviewId: null };
  }

  const aiJson = await aiResp.json();
  const rawArgs = aiJson.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArgs) {
    log("error", "chuck_no_tool_call", { fn: "chuck", userId });
    return { userId, verdict: "parse_error", reviewId: null };
  }

  let review: ComplianceReview;
  try {
    review = JSON.parse(rawArgs) as ComplianceReview;
  } catch {
    log("error", "chuck_parse_failed", { fn: "chuck", userId });
    return { userId, verdict: "parse_error", reviewId: null };
  }

  // ── Write to strategy_reviews ──────────────────────────────

  const briefText = [
    `CHUCK RHOADES COMPLIANCE BRIEF — ${now.toDateString()}`,
    `Verdict: ${review.overall_verdict.replace(/_/g, " ").toUpperCase()}`,
    "",
    `EXECUTIVE SUMMARY\n${review.brief_summary}`,
    "",
    `AUTONOMY OVERREACH\n${review.autonomy_overreach}`,
    "",
    `PATTERN VIOLATIONS\n${review.pattern_violations}`,
    "",
    `RISK ASSESSMENT\n${review.risk_assessment}`,
    "",
    `GRADE TREND (WENDY)\n${review.grade_trend}`,
    "",
    `DOCTRINE CHANGES\n${review.doctrine_changes}`,
    "",
    `DEAD ZONES\n${review.dead_zones ?? "None identified."}`,
    "",
    `RECOMMENDED ACTIONS\n${review.recommended_actions}`,
  ].join("\n");

  const { data: reviewRow } = await admin
    .from("strategy_reviews")
    .insert({
      user_id: userId,
      trigger_type: "compliance",
      trades_analyzed: (closedTrades ?? []).length,
      brief_text: briefText,
      promote_ids: [],
      kill_ids: [],
      continue_ids: [],
      win_rate_trend:
        (tradeOutcomes["win"] ?? 0) > (tradeOutcomes["loss"] ?? 0)
          ? "improving"
          : (tradeOutcomes["loss"] ?? 0) > (tradeOutcomes["win"] ?? 0)
          ? "declining"
          : "stable",
      ai_model: CHUCK_MODEL,
      raw_analysis: {
        verdict: review.overall_verdict,
        autonomy_overreach: review.autonomy_overreach,
        pattern_violations: review.pattern_violations,
        risk_assessment: review.risk_assessment,
        grade_trend: review.grade_trend,
        doctrine_changes: review.doctrine_changes,
        dead_zones: review.dead_zones,
        recommended_actions: review.recommended_actions,
        evidence: {
          tool_call_count: (toolCalls ?? []).length,
          failed_tools: failedTools.length,
          closed_trades: (closedTrades ?? []).length,
          total_pnl: totalPnl,
          grade_counts: gradeCounts,
          trade_outcomes: tradeOutcomes,
          autonomy_events: autonomyEvents.length,
          kill_switch_events: killSwitchEvents.length,
          critical_alerts: criticalAlerts.length,
        },
      },
    })
    .select("id")
    .maybeSingle();

  const reviewId = reviewRow?.id ?? null;

  // ── Write postmortem journal entry ─────────────────────────

  const verdictEmoji =
    review.overall_verdict === "clean" ? "✅" :
    review.overall_verdict === "minor_concerns" ? "🟡" :
    review.overall_verdict === "significant_violations" ? "🟠" : "🔴";

  await admin.from("journal_entries").insert({
    user_id: userId,
    kind: "postmortem",
    title: `${verdictEmoji} Chuck's Weekly Compliance Brief — ${review.overall_verdict.replace(/_/g, " ")}`,
    summary: review.brief_summary,
    tags: [
      "chuck",
      "compliance",
      `verdict_${review.overall_verdict}`,
    ].filter(Boolean),
    source: "chuck",
    raw: {
      source: "chuck",
      reviewId,
      verdict: review.overall_verdict,
      recommendedActions: review.recommended_actions,
      aiModel: CHUCK_MODEL,
    },
  });

  // ── Fire critical alert if violations found ────────────────

  if (
    review.overall_verdict === "significant_violations" ||
    review.overall_verdict === "critical_violations"
  ) {
    await admin.from("alerts").insert({
      user_id: userId,
      severity: review.overall_verdict === "critical_violations" ? "critical" : "warning",
      title: `Chuck's Compliance Review: ${review.overall_verdict.replace(/_/g, " ")}`,
      message: `${review.brief_summary} — Actions required: ${review.recommended_actions}`,
    });
  }

  log("info", "chuck_review_complete", {
    fn: "chuck",
    userId,
    verdict: review.overall_verdict,
    reviewId,
    tradesAnalyzed: (closedTrades ?? []).length,
  });

  return { userId, verdict: review.overall_verdict, reviewId };
}

// ─── HTTP entry ─────────────────────────────────────────────

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

    // ── Cron fanout mode ─────────────────────────────────────
    if (body?.cronAll === true && typeof body?.cronToken === "string") {
      const { data: tok } = await admin.rpc("get_chuck_cron_token");
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
          const r = await runChuckForUser(admin, u.user_id, LOVABLE_API_KEY);
          results.push(r);
        } catch (err) {
          log("error", "chuck_user_failed", { fn: "chuck", userId: u.user_id, err: String(err) });
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

    const result = await runChuckForUser(admin, userData.user.id, LOVABLE_API_KEY);
    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (e) {
    log("error", "handler_error", { fn: "chuck", err: String(e) });
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
    );
  }
});
