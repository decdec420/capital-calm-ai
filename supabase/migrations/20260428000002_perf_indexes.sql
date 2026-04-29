-- ============================================================
-- Performance indexes — HIGH-3 from the 2026-04-28 audit
-- ============================================================
-- Four query patterns hit on every UI load and every engine tick
-- were doing sequential scans. These partial/covering indexes
-- eliminate those scans.
--
-- 1. trades   — user timeline view (Dashboard, TradeHistory)
-- 2. signals  — pending signal gate check (signal-engine, UI)
-- 3. market_intelligence — latest snapshot per (user, symbol)
-- 4. trades   — GIN index for reason_tags array filtering
-- ============================================================

-- 1. Trade history per user ordered by time (covering index for timeline queries)
CREATE INDEX IF NOT EXISTS idx_trades_user_created
  ON public.trades (user_id, opened_at DESC);

-- 2. Pending signals per user (signal-engine gate + Signals page)
CREATE INDEX IF NOT EXISTS idx_trade_signals_user_pending
  ON public.trade_signals (user_id, created_at DESC)
  WHERE status = 'pending';

-- 3. Latest market-intelligence snapshot per user + symbol (engine reads this on every tick)
CREATE INDEX IF NOT EXISTS idx_market_intel_user_symbol
  ON public.market_intelligence (user_id, symbol, created_at DESC);

-- 4. GIN index for reason_tags array filtering (TradeHistory tag filter, analytics)
CREATE INDEX IF NOT EXISTS idx_trades_reason_tags_gin
  ON public.trades USING GIN (reason_tags);
