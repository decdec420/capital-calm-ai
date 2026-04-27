// Domain types — shared across pages, hooks, and components.
// Mirrors the shape of the Lovable Cloud (Supabase) tables but uses
// camelCase + dates as strings so it's easy to consume in React.

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
export type TradeStatus = "open" | "closed";
export type TradePhase = "candidate" | "entered" | "monitored" | "exited" | "archived";

export type AlertSeverity = "info" | "warning" | "critical";

// Lifecycle phases — backend is source of truth. Two enums, one per entity.
export type SignalLifecyclePhase =
  | "proposed"
  | "approved"
  | "rejected"
  | "expired"
  | "executed";

export type TradeLifecyclePhase =
  | "entered"
  | "monitored"
  | "tp1_hit"
  | "exited"
  | "archived";

export interface LifecycleTransition {
  phase: string;
  at: string;
  by?: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

// Typed guardrail kinds (matches backend `guardrail_type` column).
export type GuardrailType =
  | "size_cap"
  | "daily_loss"
  | "trade_count"
  | "balance_floor"
  | "spread"
  | "stale_data"
  | "drawdown"
  | "latency"
  | "generic";

// Structured gate reason emitted by the engine. UI switches on `code` for
// icon + tone; `message` is the operator-readable line.
export type GateSeverity = "halt" | "block" | "skip";

export type GateReasonCode =
  | "KILL_SWITCH"
  | "BOT_PAUSED"
  | "DAILY_LOSS_CAP"
  | "TRADE_COUNT_CAP"
  | "BALANCE_FLOOR"
  | "OPEN_POSITION"
  | "PENDING_SIGNAL"
  | "CHOP_REGIME"
  | "RANGE_REGIME"
  | "LOW_SETUP_SCORE"
  | "STALE_DATA"
  | "AI_SKIP"
  | "AI_ERROR"
  | "INSERT_ERROR"
  | "NO_SYSTEM_STATE"
  | "COOLDOWN"
  | string;

export interface GateReason {
  code: GateReasonCode;
  severity: GateSeverity;
  message: string;
  meta?: { symbol?: string; [k: string]: unknown };
}

// Per-symbol snapshot row written by the engine on every tick.
export interface SnapshotPerSymbol {
  symbol: string;
  regime: Regime | "unknown";
  confidence: number;
  setupScore: number;
  volatility: VolatilityState | string;
  todScore: number;
  lastPrice: number;
  pullback: boolean;
  chosen: boolean;
  lockGate: GateReason | null;
}

export interface EngineSnapshot {
  ranAt: string;
  gateReasons: GateReason[];
  perSymbol: SnapshotPerSymbol[];
  chosenSymbol: string | null;
}

export type JournalKind = "research" | "trade" | "learning" | "skip" | "daily" | "postmortem";

export type ExperimentStatus = "queued" | "running" | "accepted" | "rejected" | "needs_review";

export type ExperimentProposedBy = "user" | "copilot" | "coach";

export interface ExperimentBacktestSide {
  metrics: StrategyMetrics;
  pnlRStdev: number;
}
/** Out-of-sample slice — last 30% of candles, run after the full backtest. */
export interface ExperimentBacktestOutOfSample {
  before: { metrics: StrategyMetrics };
  after: { metrics: StrategyMetrics };
  expDelta: number;
  candleCount: number;
}
export interface ExperimentBacktestResult {
  before: ExperimentBacktestSide;
  after: ExperimentBacktestSide;
  deltas: { expectancy: number; winRate: number; sharpe?: number; drawdown?: number };
  candleCount: number;
  significantSample: boolean;
  significantDelta: boolean;
  /** Improvement passes the 0.05R minimum bar. */
  meetsMinBar?: boolean;
  /** Drawdown got worse by >5pp. */
  drawdownWorsened?: boolean;
  outOfSample?: ExperimentBacktestOutOfSample;
  ranAt: string;
  error?: string;
}

/** Persistent record of what the copilot has tried, mirroring `copilot_memory`. */
export interface CopilotMemoryRow {
  id: string;
  parameter: string;
  direction: "increase" | "decrease";
  symbol: string;
  fromValue: number;
  toValue: number;
  outcome: "accepted" | "rejected" | "noise";
  expDelta: number | null;
  winRateDelta: number | null;
  sharpeDelta: number | null;
  drawdownDelta: number | null;
  attemptCount: number;
  lastTriedAt: string;
  retryAfter: string | null;
  experimentId: string | null;
}

export interface SystemState {
  id: string;
  mode: SystemMode;
  bot: BotStatus;
  brokerConnection: ConnectionState;
  dataFeed: ConnectionState;
  killSwitchEngaged: boolean;
  liveTradingEnabled: boolean;
  uptimeHours: number;
  lastHeartbeat: string;
  latencyMs: number;
  autonomyLevel: "manual" | "assisted" | "autonomous";
  lastEngineSnapshot: EngineSnapshot | null;
  /** Set the first time the operator signs the live-money acknowledgment.
   * Required to be non-null before live_trading_enabled can flip true. */
  liveMoneyAcknowledgedAt: string | null;
  /** Virtual paper-trading balance in USD; powers % position sizing. */
  paperAccountBalance: number;
  /** True once strategy params are wired into the live signal engine. */
  paramsWiredLive: boolean;
  /** When set in the future, signal engine will not propose new trades. */
  tradingPausedUntil: string | null;
  /** Active trading profile — controls per-order/daily caps and scan cadence. */
  activeProfile: "sentinel" | "active" | "aggressive";
  /** Jessica's most recent autonomous decision summary (set by the jessica edge fn). */
  lastJessicaDecision: {
    ran_at: string;
    actions: number;
    decision: string;
    action_log?: Array<{ tool: string; success?: boolean }>;
  } | null;
}

export interface AccountState {
  id: string;
  equity: number;
  cash: number;
  startOfDayEquity: number;
  balanceFloor: number;
  baseCurrency: string;
  /** Max total notional ($USD) the engine may auto-execute in a single
   * UTC day. Default $2.00 (= 2 trades × MAX_ORDER_USD). */
  dailyAutoExecuteCapUsd: number;
}

export interface MarketRegime {
  symbol: string;
  regime: Regime;
  confidence: number; // 0..1
  volatility: VolatilityState;
  spread: SpreadQuality;
  timeOfDayScore: number; // 0..1
  setupScore: number; // 0..1
  noTradeReasons: string[];
  summary: string;
}

export interface Trade {
  id: string;
  symbol: string;
  side: TradeSide;
  size: number;
  originalSize: number | null;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  tp1Price: number | null;
  tp1Filled: boolean;
  currentPrice: number | null;
  pnl: number | null;
  pnlPct: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  status: TradeStatus;
  outcome: TradeOutcome | null;
  reasonTags: string[];
  strategyVersion: string;
  strategyId: string | null;
  lifecyclePhase: TradeLifecyclePhase;
  lifecycleTransitions: LifecycleTransition[];
  notes: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface JournalEntry {
  id: string;
  kind: JournalKind;
  title: string;
  summary: string;
  timestamp: string; // = created_at
  tags: string[];
  raw?: Record<string, unknown> | null;
  llmExplanation?: string | null;
}

export interface StrategyParam {
  key: string;
  /** Optional human label for UI / tests. */
  label?: string;
  value: number | string | boolean;
  unit?: string;
}

export interface StrategyMetrics {
  expectancy: number;
  winRate: number;
  maxDrawdown: number;
  sharpe: number;
  trades: number;
  /** Gross profit / gross loss (in R). 999 sentinel = no losses. */
  profitFactor?: number;
  /** Average winning trade in R. */
  avgWin?: number;
  /** Average losing trade in R (positive number). */
  avgLoss?: number;
}

export interface StrategyVersion {
  id: string;
  name: string;
  version: string;
  /** Friendly nickname surfaced in the UI (e.g. "Steady Trender"). Falls back to `name` when null. */
  displayName: string | null;
  /** One-line plain-English summary (e.g. "Wider stops experiment"). Optional. */
  friendlySummary: string | null;
  status: StrategyStatus;
  createdAt: string;
  description: string;
  params: StrategyParam[];
  metrics: StrategyMetrics;
}

export interface RiskGuardrail {
  id: string;
  label: string;
  description: string;
  current: string;
  limit: string;
  level: RiskLevel;
  utilization: number; // 0..1
  sortOrder: number;
  guardrailType: GuardrailType;
}

export interface Experiment {
  id: string;
  title: string;
  status: ExperimentStatus;
  parameter: string;
  before: string;
  after: string;
  delta: string;
  createdAt: string;
  notes?: string | null;
  proposedBy: ExperimentProposedBy;
  hypothesis?: string | null;
  backtestResult?: ExperimentBacktestResult | null;
  strategyId?: string | null;
  autoResolved: boolean;
  needsReview: boolean;
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

export type AutonomyLevel = "manual" | "assisted" | "autonomous";

export type SignalStatus = "pending" | "approved" | "rejected" | "expired" | "executed" | "halted";
export type SignalDecidedBy = "user" | "auto" | "expired" | "system";

export interface TradeSignal {
  id: string;
  symbol: string;
  side: TradeSide;
  confidence: number; // 0..1
  setupScore: number; // 0..1
  regime: string;
  proposedEntry: number;
  proposedStop: number | null;
  proposedTarget: number | null;
  sizeUsd: number;
  sizePct: number;
  aiReasoning: string;
  aiModel: string;
  contextSnapshot: Record<string, unknown>;
  status: SignalStatus;
  decidedBy: SignalDecidedBy | null;
  decisionReason: string | null;
  executedTradeId: string | null;
  strategyId: string | null;
  strategyVersion: string | null;
  lifecyclePhase: SignalLifecyclePhase;
  lifecycleTransitions: LifecycleTransition[];
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
}
