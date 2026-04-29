-- ============================================================
-- Two-phase write: broker_pending + broker_failed trade statuses
-- ============================================================
-- Part of the CRIT-1 ghost-trade fix.
--
-- Background:
--   The old auto-execute pattern called placeMarketBuy() and then inserted
--   the trades row. If the INSERT failed after a successful broker fill we
--   had a real Coinbase position with no DB record (ghost trade).
--
--   The new pattern pre-inserts a 'broker_pending' row before touching the
--   broker, then promotes it to 'open' on fill or 'broker_failed' on error.
--   A periodic reconciliation job can query broker_pending rows and cross-
--   check them against Coinbase order status.
--
-- This migration:
--   1. Adds a CHECK constraint documenting the full set of allowed statuses.
--   2. Adds partial indexes for the reconciliation sweep queries.
--   3. Adds a table comment for maintainers.
-- ============================================================

-- 1. Status constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'trades_status_chk'
  ) THEN
    ALTER TABLE public.trades
      ADD CONSTRAINT trades_status_chk
      CHECK (status IN (
        'broker_pending',
        'broker_failed',
        'open',
        'closing',
        'closed',
        'cancelled'
      ));
  END IF;
END $$;

-- 2. Indexes for reconciliation sweep
CREATE INDEX IF NOT EXISTS idx_trades_user_broker_pending
  ON public.trades (user_id, created_at DESC)
  WHERE status = 'broker_pending';

CREATE INDEX IF NOT EXISTS idx_trades_broker_failed
  ON public.trades (user_id, created_at DESC)
  WHERE status = 'broker_failed';

-- 3. Table comment
COMMENT ON TABLE public.trades IS
  'Positions opened by the trading engine. Two-phase write lifecycle: '
  'broker_pending (pre-inserted before broker call) → open (fill confirmed) '
  'or broker_failed (broker error; kept for reconciliation). '
  'See supabase/functions/signal-engine/index.ts auto-execute block.';
