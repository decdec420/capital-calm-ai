// ============================================================
// AI Guard Event Hook — lightweight incident visibility
// ------------------------------------------------------------
// Emits a system_events row when guardAiOutput returns "reject"
// or "fallback" on a lower-risk (read-only/diagnostic) surface.
//
// Safety rules:
//   - NEVER store raw model output.
//   - NEVER store API keys, auth headers, or secrets.
//   - Store sanitized reason, counts, and metadata only.
//   - Non-fatal: insert failure is logged, never thrown.
// ============================================================

import type { AiOutputGuardResult } from "./ai-output-guard.ts";
import { sanitizeForStorage } from "./ai-output-guard.ts";

export type AiGuardEventType = "AI_GUARD_REJECTED" | "AI_GUARD_FALLBACK";

export interface AiGuardEventPayload {
  eventType: AiGuardEventType;
  surface: string;
  decisionType: string;
  validationStatus: string;
  unsafeIntentCount: number;
  protectedActionCount: number;
  sanitizedReason: string;
  timestamp: string;
}

// deno-lint-ignore no-explicit-any
type AdminClient = { from: (table: string) => any };

export async function emitAiGuardEvent(
  admin: AdminClient,
  userId: string,
  surface: string,
  guardResult: AiOutputGuardResult,
  decisionType: string,
): Promise<void> {
  if (guardResult.decision !== "reject" && guardResult.decision !== "fallback") return;

  const eventType: AiGuardEventType =
    guardResult.decision === "reject" ? "AI_GUARD_REJECTED" : "AI_GUARD_FALLBACK";

  const payload: AiGuardEventPayload = {
    eventType,
    surface,
    decisionType,
    validationStatus: guardResult.provenancePatch.validationStatus,
    unsafeIntentCount: guardResult.provenancePatch.unsafeIntentCount,
    protectedActionCount: guardResult.provenancePatch.protectedActionCount,
    sanitizedReason: sanitizeForStorage(guardResult.reason),
    timestamp: new Date().toISOString(),
  };

  try {
    const { error } = await admin.from("system_events").insert({
      user_id: userId,
      event_type: eventType,
      actor: surface,
      payload,
    });
    if (error) {
      console.warn(`[ai-guard-event] system_events insert failed (non-fatal): ${error.message}`);
    }
  } catch (e) {
    console.warn(`[ai-guard-event] emitAiGuardEvent threw (non-fatal):`, e);
  }
}
