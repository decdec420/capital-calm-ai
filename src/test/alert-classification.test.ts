import { describe, expect, it } from "vitest";
import { classifyAlert } from "@/lib/alert-classification";

const mkAlert = (title: string, message = "") => ({ title, message }) as any;

describe("classifyAlert copy", () => {
  it("uses Billions-themed wording for cron health guidance", () => {
    const result = classifyAlert(mkAlert("cron may be down"));

    expect({
      summary: result.summary,
      what: result.what,
      why: result.why,
      fixes: result.fixes,
    }).toMatchInlineSnapshot(`
      {
        "fixes": [
          "Check the live status block above. If the bot is paused or the kill-switch is engaged, this is expected — start the bot and the alert clears within a minute.",
          "Otherwise, click Run Bobby now to kick a tick. If it succeeds, the heartbeat resets immediately.",
          "If Run Bobby now fails, the edge function itself is down — open Copilot to check agent logs or contact support.",
        ],
        "summary": "Bobby hasn't checked in recently.",
        "what": "Bobby — the autonomous decision agent that runs every minute — hasn't reported a tick within the expected window.",
        "why": "While Bobby is silent, no new signals are generated and automated lifecycle steps (approvals, exits, learning) pause. Open positions are still tracked but won't be re-evaluated until ticks resume.",
      }
    `);
  });

  it("uses Brain Trust members Wags and Taylor in stale momentum guidance", () => {
    const result = classifyAlert(mkAlert("momentum stale from brain trust"));

    expect({
      summary: result.summary,
      what: result.what,
      why: result.why,
      fixes: result.fixes,
    }).toMatchInlineSnapshot(`
      {
        "fixes": [
          "Open Copilot and trigger a Brain Trust refresh (market intelligence run) to repopulate momentum reads.",
          "Confirm the market-intelligence cron is running — if it's silent, that's the underlying issue.",
          "Once a fresh read lands the next engine tick will resume normal proposals.",
        ],
        "summary": "Brain Trust short-horizon momentum is stale.",
        "what": "The signal engine refused to propose a trade because the latest 1h/4h momentum read from the Brain Trust (Wags & Taylor) is missing or older than 2 hours.",
        "why": "Without a fresh short-horizon read, Bobby and Wags can't confirm direction safely. The engine fails closed rather than guess.",
      }
    `);
  });
});
