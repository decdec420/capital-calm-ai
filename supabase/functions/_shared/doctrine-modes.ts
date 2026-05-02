// ============================================================
// Doctrine Modes & Overlays — pure, deterministic, code-only
// ------------------------------------------------------------
// Modes are NEVER user-editable numbers. They are invariants.
// Operators choose WHICH conditions trigger which mode (via
// doctrine_windows rows or by letting the engine auto-detect).
// The resolver multiplies the user's effective doctrine by the
// mode's coefficients. Modes can ONLY tighten — never loosen.
// ============================================================

export type DoctrineMode = "calm" | "choppy" | "storm" | "lockout";

export interface ModeMultipliers {
  /** Multiplier on per-order USD cap (max_order_pct & max_order_abs_cap). */
  size: number;
  /** Multiplier on max_trades_per_day. */
  trades: number;
  /** Multiplier on risk_per_trade_pct. */
  risk: number;
  /** Multiplier on daily_loss_pct. */
  dailyLoss: number;
  /** If true, no new entries at all this tick. */
  blockNewEntries: boolean;
}

export const MODE_MULTIPLIERS: Record<DoctrineMode, ModeMultipliers> = {
  calm:    { size: 1.0, trades: 1.0, risk: 1.0, dailyLoss: 1.0, blockNewEntries: false },
  choppy:  { size: 0.7, trades: 0.5, risk: 0.7, dailyLoss: 1.0, blockNewEntries: false },
  storm:   { size: 0.4, trades: 0.4, risk: 0.5, dailyLoss: 0.5, blockNewEntries: false },
  lockout: { size: 0.0, trades: 0.0, risk: 0.0, dailyLoss: 1.0, blockNewEntries: true  },
};

const MODE_RANK: Record<DoctrineMode, number> = {
  calm: 0, choppy: 1, storm: 2, lockout: 3,
};

/** Pick the *most* tightening mode out of a set. */
export function strictestMode(modes: DoctrineMode[]): DoctrineMode {
  return modes.reduce<DoctrineMode>(
    (acc, m) => (MODE_RANK[m] > MODE_RANK[acc] ? m : acc),
    "calm",
  );
}

// ── Drawdown ladder ─────────────────────────────────────────
// Step → coefficients applied as an overlay (compose with mode).
export interface DrawdownStep {
  step: 0 | 1 | 2 | 3;
  /** Realized DD threshold from start_of_day_equity, e.g. 0.01 = -1%. */
  threshold: number;
  size: number;
  trades: number;
  blockNewEntries: boolean;
  label: string;
}

export const DRAWDOWN_LADDER: DrawdownStep[] = [
  { step: 0, threshold: 0.000, size: 1.0, trades: 1.0, blockNewEntries: false, label: "no drawdown" },
  { step: 1, threshold: 0.010, size: 1.0, trades: 0.8, blockNewEntries: false, label: "-1% DD: trim trade cap 20%" },
  { step: 2, threshold: 0.020, size: 0.5, trades: 0.6, blockNewEntries: false, label: "-2% DD: halve order size" },
  { step: 3, threshold: 0.030, size: 0.0, trades: 0.0, blockNewEntries: true,  label: "-3% DD: halt new entries" },
];

export function selectDrawdownStep(
  startOfDayEquity: number,
  currentEquity: number,
): DrawdownStep {
  if (!Number.isFinite(startOfDayEquity) || startOfDayEquity <= 0) return DRAWDOWN_LADDER[0];
  if (!Number.isFinite(currentEquity)) return DRAWDOWN_LADDER[0];
  const ddPct = Math.max(0, (startOfDayEquity - currentEquity) / startOfDayEquity);
  let chosen = DRAWDOWN_LADDER[0];
  for (const s of DRAWDOWN_LADDER) {
    if (ddPct >= s.threshold) chosen = s;
  }
  return chosen;
}

// ── Window selector (HH:MM in UTC) ──────────────────────────
export interface DoctrineWindowRow {
  label: string;
  days: number[];      // 0=Sun..6=Sat
  start_utc: string;   // "HH:MM"
  end_utc: string;     // "HH:MM"
  mode: DoctrineMode;
  enabled: boolean;
}

function parseHHMM(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function selectActiveWindowMode(
  windows: DoctrineWindowRow[],
  nowIso: string,
): { mode: DoctrineMode; reasons: string[] } {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) return { mode: "calm", reasons: [] };
  const day = now.getUTCDay();
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const matched: DoctrineMode[] = [];
  const reasons: string[] = [];
  for (const w of windows) {
    if (!w.enabled) continue;
    if (!w.days?.includes(day)) continue;
    const s = parseHHMM(w.start_utc);
    const e = parseHHMM(w.end_utc);
    if (s == null || e == null) continue;
    // Same-day window. (Cross-midnight windows: split into two rows.)
    const inside = s <= e ? minute >= s && minute < e : (minute >= s || minute < e);
    if (inside) {
      matched.push(w.mode);
      reasons.push(`window:${w.label}=${w.mode}`);
    }
  }
  return { mode: strictestMode(matched), reasons };
}

// ── Compose overlay = mode × drawdown ──────────────────────
export interface DoctrineOverlay {
  mode: DoctrineMode;
  drawdownStep: 0 | 1 | 2 | 3;
  /** Compounded multipliers applied on top of resolved doctrine. */
  sizeMult: number;
  tradesMult: number;
  riskMult: number;
  dailyLossMult: number;
  blockNewEntries: boolean;
  reasons: string[];
  computedAt: string;
}

export function composeOverlay(opts: {
  mode: DoctrineMode;
  modeReasons: string[];
  drawdownStep: DrawdownStep;
  nowIso?: string;
}): DoctrineOverlay {
  const m = MODE_MULTIPLIERS[opts.mode];
  const dd = opts.drawdownStep;
  const reasons = [...opts.modeReasons];
  if (dd.step > 0) reasons.push(`drawdown:step${dd.step}`);
  return {
    mode: opts.mode,
    drawdownStep: dd.step,
    sizeMult: clamp01(m.size * dd.size),
    tradesMult: clamp01(m.trades * dd.trades),
    riskMult: clamp01(m.risk),
    dailyLossMult: clamp01(m.dailyLoss),
    blockNewEntries: m.blockNewEntries || dd.blockNewEntries,
    reasons,
    computedAt: opts.nowIso ?? new Date().toISOString(),
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
