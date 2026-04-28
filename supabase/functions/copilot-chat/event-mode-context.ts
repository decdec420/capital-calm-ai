import { resolveEventModeReasonContext, UNKNOWN_EVENT_MODE } from "../_shared/event-mode.ts";

/**
 * Resolves trading pause fields from multiple context shapes:
 * - server nested: { system: { trading_paused_until, pause_reason } }
 * - client flat snake_case: { trading_paused_until, pause_reason }
 * - client flat camelCase: { tradingPausedUntil, pauseReason }
 */
function readPauseFields(context?: Record<string, unknown>): { tradingPausedUntil: string | null; pauseReason: string | null } {
  const system = (context?.system ?? null) as Record<string, unknown> | null;

  const rawUntil =
    (typeof system?.trading_paused_until === "string" && system.trading_paused_until) ||
    (typeof context?.trading_paused_until === "string" && (context.trading_paused_until as string)) ||
    (typeof context?.tradingPausedUntil === "string" && (context.tradingPausedUntil as string)) ||
    null;

  const rawReason =
    (typeof system?.pause_reason === "string" && system.pause_reason) ||
    (typeof context?.pause_reason === "string" && (context.pause_reason as string)) ||
    (typeof context?.pauseReason === "string" && (context.pauseReason as string)) ||
    null;

  return {
    tradingPausedUntil: rawUntil,
    pauseReason: rawReason,
  };
}

/**
 * Returns a deterministic instruction block for Harvey when event mode is active.
 * Empty string means no active pause instruction should be injected into the prompt.
 */
export function buildEventModeContextInstruction(context?: Record<string, unknown>): string {
  const { tradingPausedUntil, pauseReason } = readPauseFields(context);

  if (!tradingPausedUntil || new Date(tradingPausedUntil) <= new Date()) {
    return "";
  }

  const reason = resolveEventModeReasonContext(pauseReason);

  if (reason.code === UNKNOWN_EVENT_MODE) {
    return `Event mode is active until ${tradingPausedUntil}. Reason is UNKNOWN_EVENT_MODE. State explicitly that the reason is unknown and do not guess.`;
  }

  return `Event mode is active until ${tradingPausedUntil}. Reason code: ${reason.code}. Reason label: ${reason.label}. Detail: ${reason.detail}. Use these exact reason labels/details when explaining the pause.`;
}
