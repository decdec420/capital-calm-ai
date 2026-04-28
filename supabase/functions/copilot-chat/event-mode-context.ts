import { resolveEventModeReasonContext, UNKNOWN_EVENT_MODE } from "../_shared/event-mode.ts";

export function buildEventModeContextInstruction(context?: Record<string, unknown>): string {
  const system = (context?.system ?? null) as Record<string, unknown> | null;
  const tradingPausedUntil = typeof system?.trading_paused_until === "string"
    ? system.trading_paused_until
    : null;

  if (!tradingPausedUntil || new Date(tradingPausedUntil) <= new Date()) {
    return "";
  }

  const pauseReason = typeof system?.pause_reason === "string" ? system.pause_reason : null;
  const reason = resolveEventModeReasonContext(pauseReason);

  if (reason.code === UNKNOWN_EVENT_MODE) {
    return `Event mode is active until ${tradingPausedUntil}. Reason is UNKNOWN_EVENT_MODE. State explicitly that the reason is unknown and do not guess.`;
  }

  return `Event mode is active until ${tradingPausedUntil}. Reason code: ${reason.code}. Reason label: ${reason.label}. Detail: ${reason.detail}. Use these exact reason labels/details when explaining the pause.`;
}
