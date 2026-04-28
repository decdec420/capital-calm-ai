import { GATE_CODES, gate, type GateReason } from "./reasons.ts";

export const EVENT_MODE_REASON_DETAILS = {
  FOMC: {
    label: "FOMC rate decision window",
    detail: "Fed policy headline risk is elevated; pause new proposals until volatility normalizes.",
  },
  CPI: {
    label: "CPI release window",
    detail: "Inflation print can whip liquidity and invalidate setup quality during release window.",
  },
  NFP: {
    label: "Nonfarm Payrolls release",
    detail: "Labor print often causes sharp cross-asset repricing and spread instability.",
  },
  FED_SPEAK: {
    label: "Fed speaker risk window",
    detail: "Fed commentary can abruptly shift rates path expectations and market regime.",
  },
  OPERATOR_MANUAL: {
    label: "Operator manual event mode",
    detail: "Operator manually paused new proposals for discretionary risk control.",
  },
} as const;

export type KnownEventModeReasonCode = keyof typeof EVENT_MODE_REASON_DETAILS;

export interface EventModeReasonContext {
  code: string;
  label: string;
  detail: string;
  known: boolean;
}

export const UNKNOWN_EVENT_MODE = "UNKNOWN_EVENT_MODE";

export function resolveEventModeReasonContext(pauseReason: string | null | undefined): EventModeReasonContext {
  const normalized = typeof pauseReason === "string" ? pauseReason.trim() : "";
  if (!normalized) {
    return {
      code: UNKNOWN_EVENT_MODE,
      label: "Unknown event mode reason",
      detail: "Trading pause is active, but no reason code was recorded.",
      known: false,
    };
  }

  const known = EVENT_MODE_REASON_DETAILS[normalized as KnownEventModeReasonCode];
  if (!known) {
    return {
      code: UNKNOWN_EVENT_MODE,
      label: "Unknown event mode reason",
      detail: `Trading pause is active, but reason code '${normalized}' is not recognized.`,
      known: false,
    };
  }

  return {
    code: normalized,
    label: known.label,
    detail: known.detail,
    known: true,
  };
}

export function buildActiveEventModeGate(pausedUntilIso: string, pauseReason: string | null | undefined): GateReason {
  const reason = resolveEventModeReasonContext(pauseReason);
  return gate(
    GATE_CODES.TRADING_PAUSED_EVENT_MODE,
    "halt",
    `Trading paused until ${new Date(pausedUntilIso).toLocaleString()}. Resume via Risk Center.`,
    {
      resumesAt: pausedUntilIso,
      eventMode: reason,
    },
  );
}


export function getActiveEventModeGateFromSystem(sys: { trading_paused_until?: string | null; pause_reason?: string | null }): GateReason | null {
  const pausedUntil = sys.trading_paused_until;
  if (!pausedUntil) return null;
  if (new Date(pausedUntil) <= new Date()) return null;
  return buildActiveEventModeGate(pausedUntil, sys.pause_reason);
}
