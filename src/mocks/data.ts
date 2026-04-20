import type {
  AIInsight,
  AccountState,
  Alert,
  Candle,
  ClosedTrade,
  Experiment,
  JournalEntry,
  MarketRegime,
  OpenPosition,
  RiskGuardrail,
  StrategyVersion,
  SystemState,
} from "./types";

export const systemState: SystemState = {
  mode: "paper",
  bot: "running",
  brokerConnection: "connected",
  dataFeed: "connected",
  killSwitchEngaged: false,
  liveTradingEnabled: false,
  uptimeHours: 47.2,
  lastHeartbeat: new Date().toISOString(),
  latencyMs: 84,
};

export const accountState: AccountState = {
  equity: 10_482.17,
  cash: 8_120.04,
  startOfDayEquity: 10_510.0,
  balanceFloor: 9_500.0,
  baseCurrency: "USD",
};

export const marketRegime: MarketRegime = {
  symbol: "BTC-USD",
  regime: "range",
  confidence: 0.62,
  volatility: "normal",
  spread: "tight",
  timeOfDayScore: 0.71,
  noTradeReasons: ["Confidence below entry threshold", "Range midpoint — poor RR"],
  summary:
    "BTC is consolidating inside a 1.4% range with declining volume. No clear breakout signal. Setup score 0.42 (entry threshold 0.65).",
};

export const openPosition: OpenPosition | null = {
  id: "pos_2041",
  symbol: "BTC-USD",
  side: "long",
  size: 0.0184,
  entryPrice: 67_120.5,
  currentPrice: 67_388.2,
  stopLoss: 66_650.0,
  takeProfit: 68_180.0,
  unrealizedPnl: 4.92,
  unrealizedPnlPct: 0.4,
  openedAt: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
  strategyVersion: "trend-rev v1.3",
};

export const closedTrades: ClosedTrade[] = [
  {
    id: "t_2039",
    symbol: "BTC-USD",
    side: "long",
    size: 0.018,
    entryPrice: 66_800,
    exitPrice: 67_240,
    pnl: 7.92,
    pnlPct: 0.66,
    outcome: "win",
    reasonTags: ["trend-confirm", "tod-good"],
    openedAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
    closedAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    strategyVersion: "trend-rev v1.3",
  },
  {
    id: "t_2038",
    symbol: "BTC-USD",
    side: "long",
    size: 0.018,
    entryPrice: 67_010,
    exitPrice: 66_850,
    pnl: -2.88,
    pnlPct: -0.24,
    outcome: "loss",
    reasonTags: ["false-breakout", "low-vol"],
    openedAt: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
    closedAt: new Date(Date.now() - 1000 * 60 * 60 * 11).toISOString(),
    strategyVersion: "trend-rev v1.3",
  },
  {
    id: "t_2037",
    symbol: "BTC-USD",
    side: "short",
    size: 0.012,
    entryPrice: 67_400,
    exitPrice: 67_120,
    pnl: 3.36,
    pnlPct: 0.41,
    outcome: "win",
    reasonTags: ["range-fade", "tod-good"],
    openedAt: new Date(Date.now() - 1000 * 60 * 60 * 22).toISOString(),
    closedAt: new Date(Date.now() - 1000 * 60 * 60 * 20).toISOString(),
    strategyVersion: "trend-rev v1.2",
  },
  {
    id: "t_2036",
    symbol: "BTC-USD",
    side: "long",
    size: 0.018,
    entryPrice: 66_540,
    exitPrice: 66_540,
    pnl: 0.0,
    pnlPct: 0.0,
    outcome: "breakeven",
    reasonTags: ["stop-moved", "session-end"],
    openedAt: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(),
    closedAt: new Date(Date.now() - 1000 * 60 * 60 * 28).toISOString(),
    strategyVersion: "trend-rev v1.2",
  },
];

export const journalEntries: JournalEntry[] = [
  {
    id: "j_501",
    kind: "skip",
    title: "Skipped long setup at 14:22",
    summary: "Setup score 0.58 below threshold 0.65. Spread widened to 4.2 bps.",
    timestamp: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    tags: ["score-low", "spread-wide"],
    llmExplanation:
      "The signal had directional alignment but the volatility-adjusted RR was 1.1, below the 1.4 minimum. Correctly skipped.",
  },
  {
    id: "j_500",
    kind: "research",
    title: "Asia session range observation",
    summary: "BTC held a 1.2% range through Asia hours. Mean reversion edge weak (sample n=8).",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    tags: ["regime-range", "session-asia"],
  },
  {
    id: "j_499",
    kind: "trade",
    title: "Closed long t_2039 +0.66%",
    summary: "Exited on TP1. Held 2h 04m. Trend confirmation held throughout.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    tags: ["win", "trend-confirm"],
  },
  {
    id: "j_498",
    kind: "learning",
    title: "Experiment exp_22 accepted",
    summary: "Stop distance widened from 0.6% to 0.7%. Win rate +3.2%, expectancy +0.04R.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString(),
    tags: ["accepted", "stop-tuning"],
  },
  {
    id: "j_497",
    kind: "daily",
    title: "Daily summary — yesterday",
    summary: "3 trades, 2W 1L, +0.42% net. Within all guardrails. No regime shifts detected.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
    tags: ["daily"],
  },
  {
    id: "j_496",
    kind: "postmortem",
    title: "Postmortem: t_2038 false breakout",
    summary: "Entered on a 5m breakout that failed within 4 candles. Volume profile was thin.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 11).toISOString(),
    tags: ["loss", "false-breakout"],
    llmExplanation:
      "Volume confirmation rule was satisfied at the bar close but immediately reversed. Consider requiring 2 consecutive volume bars above MA20.",
  },
];

export const strategies: StrategyVersion[] = [
  {
    id: "s_13",
    name: "trend-rev",
    version: "v1.3",
    status: "approved",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
    description: "Trend continuation with mean-reversion exit. Approved for paper trading.",
    params: [
      { key: "ma_fast", value: 9 },
      { key: "ma_slow", value: 21 },
      { key: "stop_pct", value: 0.7, unit: "%" },
      { key: "tp_r", value: 1.6, unit: "R" },
      { key: "min_setup_score", value: 0.65 },
    ],
    metrics: { expectancy: 0.18, winRate: 0.54, maxDrawdown: 0.032, sharpe: 1.42, trades: 84 },
  },
  {
    id: "s_14",
    name: "trend-rev",
    version: "v1.4-cand",
    status: "candidate",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
    description: "Tightened entry threshold + volume confirmation rule. Awaiting promotion review.",
    params: [
      { key: "ma_fast", value: 9 },
      { key: "ma_slow", value: 21 },
      { key: "stop_pct", value: 0.7, unit: "%" },
      { key: "tp_r", value: 1.6, unit: "R" },
      { key: "min_setup_score", value: 0.7 },
      { key: "vol_confirm_bars", value: 2 },
    ],
    metrics: { expectancy: 0.24, winRate: 0.58, maxDrawdown: 0.028, sharpe: 1.61, trades: 31 },
  },
  {
    id: "s_12",
    name: "trend-rev",
    version: "v1.2",
    status: "archived",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 40).toISOString(),
    description: "Previous approved version. Replaced by v1.3 after stop-distance tuning.",
    params: [
      { key: "ma_fast", value: 9 },
      { key: "ma_slow", value: 21 },
      { key: "stop_pct", value: 0.6, unit: "%" },
      { key: "tp_r", value: 1.5, unit: "R" },
      { key: "min_setup_score", value: 0.65 },
    ],
    metrics: { expectancy: 0.12, winRate: 0.51, maxDrawdown: 0.041, sharpe: 1.18, trades: 162 },
  },
];

export const riskGuardrails: RiskGuardrail[] = [
  {
    id: "g_order_max",
    label: "Max order size",
    description: "Hard cap per single order, % of equity",
    current: "0.18%",
    limit: "0.25%",
    level: "safe",
    utilization: 0.72,
  },
  {
    id: "g_daily_loss",
    label: "Daily loss cap",
    description: "Max realized loss before halt",
    current: "−0.27%",
    limit: "1.50%",
    level: "safe",
    utilization: 0.18,
  },
  {
    id: "g_daily_trades",
    label: "Daily trade cap",
    description: "Max trades per UTC day",
    current: "3 / 6",
    limit: "6",
    level: "safe",
    utilization: 0.5,
  },
  {
    id: "g_spread",
    label: "Spread filter",
    description: "Reject if spread exceeds threshold",
    current: "1.8 bps",
    limit: "5.0 bps",
    level: "safe",
    utilization: 0.36,
  },
  {
    id: "g_stale",
    label: "Stale data filter",
    description: "Reject if last tick > N seconds old",
    current: "1.2s",
    limit: "5.0s",
    level: "safe",
    utilization: 0.24,
  },
  {
    id: "g_position",
    label: "Position limit",
    description: "Max concurrent positions",
    current: "1 / 1",
    limit: "1",
    level: "caution",
    utilization: 1,
  },
  {
    id: "g_floor",
    label: "Balance floor",
    description: "Hard kill-switch if equity drops below",
    current: "$10,482",
    limit: "$9,500",
    level: "safe",
    utilization: 0.1,
  },
  {
    id: "g_live",
    label: "Live trading gate",
    description: "All checks required to enable live mode",
    current: "Paper only",
    limit: "Approved v1.3 + 30d paper",
    level: "blocked",
    utilization: 1,
  },
];

export const experiments: Experiment[] = [
  {
    id: "exp_24",
    title: "Volume confirmation bars",
    status: "running",
    parameter: "vol_confirm_bars",
    before: "1",
    after: "2",
    delta: "+1",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
    notes: "Testing whether 2-bar confirm reduces false breakouts.",
  },
  {
    id: "exp_23",
    title: "Setup score threshold lift",
    status: "queued",
    parameter: "min_setup_score",
    before: "0.65",
    after: "0.70",
    delta: "+0.05",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 1).toISOString(),
  },
  {
    id: "exp_22",
    title: "Stop distance widen",
    status: "accepted",
    parameter: "stop_pct",
    before: "0.6%",
    after: "0.7%",
    delta: "+0.1%",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
    notes: "Win rate +3.2%, expectancy +0.04R. Promoted into v1.3.",
  },
  {
    id: "exp_21",
    title: "Asia session entry",
    status: "rejected",
    parameter: "session_asia_enabled",
    before: "false",
    after: "true",
    delta: "enable",
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 9).toISOString(),
    notes: "Edge weak (n=8). Did not clear significance bar.",
  },
];

export const alerts: Alert[] = [
  {
    id: "a_3",
    severity: "info",
    title: "Heartbeat OK",
    message: "Bot heartbeat steady. Latency 84ms. Data feed healthy.",
    timestamp: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
  },
  {
    id: "a_2",
    severity: "warning",
    title: "Spread briefly widened",
    message: "Spread touched 4.2 bps at 14:22 UTC. Below 5.0 bps cap. No action taken.",
    timestamp: new Date(Date.now() - 1000 * 60 * 26).toISOString(),
  },
  {
    id: "a_1",
    severity: "info",
    title: "Daily summary posted",
    message: "Yesterday: 3 trades, +0.42% net. Within all guardrails.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
  },
];

export const aiInsights: AIInsight[] = [
  {
    id: "ai_1",
    title: "Today's market brief",
    body: "BTC range-bound between $66.8k–$67.6k with declining volume. No high-confidence setups. Recommend: hold no-trade bias unless setup score exceeds 0.70.",
    timestamp: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  },
  {
    id: "ai_2",
    title: "Candidate v1.4 review",
    body: "Candidate strategy shows +0.06 expectancy improvement over 31 trades. Sample below 50-trade promotion threshold. Continue paper testing 12 more sessions.",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
];

// Generate deterministic mock candles
export function generateCandles(count = 96, base = 67_000): Candle[] {
  const candles: Candle[] = [];
  let price = base;
  const now = Math.floor(Date.now() / 1000);
  for (let i = count - 1; i >= 0; i--) {
    const t = now - i * 3600;
    const drift = Math.sin(i / 7) * 120 + Math.cos(i / 13) * 60;
    const o = price;
    const c = price + drift + (Math.sin(i * 2.3) * 80);
    const h = Math.max(o, c) + Math.abs(Math.sin(i * 1.7)) * 60;
    const l = Math.min(o, c) - Math.abs(Math.cos(i * 1.3)) * 60;
    const v = 800 + Math.abs(Math.sin(i / 5)) * 600;
    candles.push({ t, o, h, l, c, v });
    price = c;
  }
  return candles;
}
