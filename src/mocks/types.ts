// Domain types — modeled to match a future TS bot backend.

export type SystemMode = "research" | "paper" | "learning" | "live";
export type BotStatus = "running" | "paused" | "halted" | "starting";
export type ConnectionState = "connected" | "degraded" | "disconnected";

export type Regime = "trending_up" | "trending_down" | "range" | "chop" | "breakout";
export type VolatilityState = "low" | "normal" | "elevated" | "extreme";
export type SpreadQuality = "tight" | "normal" | "wide";

export type RiskLevel = "safe" | "caution" | "blocked";

export type StrategyStatus = "approved" | "candidate" | "archived";

export type TradeSide = "long" | "short";
export type TradeOutcome = "win" | "loss" | "breakeven" | "open";
export type TradePhase = "candidate" | "entered" | "monitored" | "exited" | "archived";

export type AlertSeverity = "info" | "warning" | "critical";

export interface SystemState {
  mode: SystemMode;
  bot: BotStatus;
  brokerConnection: ConnectionState;
  dataFeed: ConnectionState;
  killSwitchEngaged: boolean;
  liveTradingEnabled: boolean;
  uptimeHours: number;
  lastHeartbeat: string;
  latencyMs: number;
}

export interface AccountState {
  equity: number;
  cash: number;
  startOfDayEquity: number;
  balanceFloor: number;
  baseCurrency: string;
}

export interface MarketRegime {
  symbol: string;
  regime: Regime;
  confidence: number; // 0..1
  volatility: VolatilityState;
  spread: SpreadQuality;
  timeOfDayScore: number; // 0..1
  noTradeReasons: string[];
  summary: string;
}

export interface OpenPosition {
  id: string;
  symbol: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  openedAt: string;
  strategyVersion: string;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  outcome: TradeOutcome;
  reasonTags: string[];
  openedAt: string;
  closedAt: string;
  strategyVersion: string;
  notes?: string;
}

export type JournalKind = "research" | "trade" | "learning" | "skip" | "daily" | "postmortem";

export interface JournalEntry {
  id: string;
  kind: JournalKind;
  title: string;
  summary: string;
  timestamp: string;
  tags: string[];
  raw?: Record<string, unknown>;
  llmExplanation?: string;
}

export interface StrategyParam {
  key: string;
  value: number | string | boolean;
  unit?: string;
}

export interface StrategyVersion {
  id: string;
  name: string;
  version: string;
  status: StrategyStatus;
  createdAt: string;
  description: string;
  params: StrategyParam[];
  metrics: {
    expectancy: number;
    winRate: number;
    maxDrawdown: number;
    sharpe: number;
    trades: number;
  };
}

export interface RiskGuardrail {
  id: string;
  label: string;
  description: string;
  current: string;
  limit: string;
  level: RiskLevel;
  utilization: number; // 0..1
}

export interface Experiment {
  id: string;
  title: string;
  status: "queued" | "running" | "accepted" | "rejected";
  parameter: string;
  before: string;
  after: string;
  delta: string;
  createdAt: string;
  notes?: string;
}

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  timestamp: string;
}

export interface AIInsight {
  id: string;
  title: string;
  body: string;
  timestamp: string;
}

export interface Candle {
  t: number; // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
