-- ============================================================
-- Add 'limit_not_filled' to trades status constraint
-- ------------------------------------------------------------
-- Limit IOC orders (vwap-revert mean-reversion in range regime)
-- pre-insert a broker_pending row before placing the order.
-- If the limit IOC cancels (price moved past our level), we
-- update the row to 'limit_not_filled' so operators can see
-- the attempted fade vs a genuine broker failure (broker_failed).
--
-- Requires dropping and recreating the CHECK constraint since
-- PostgreSQL has no ALTER CONSTRAINT ... MODIFY syntax.
-- ============================================================

ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_status_chk;

ALTER TABLE public.trades
  ADD CONSTRAINT trades_status_chk
  CHECK (status IN (
    'broker_pending',
    'broker_failed',
    'limit_not_filled',
    'open',
    'closing',
    'closed',
    'cancelled'
  ));

COMMENT ON TABLE public.trades IS
  'Positions opened by the trading engine. Two-phase write lifecycle: '
  'broker_pending → open (fill confirmed) | broker_failed (broker error) | '
  'limit_not_filled (limit IOC not filled, no position opened) | '
  'closing → closed (position exited). '
  'See supabase/functions/signal-engine/index.ts auto-execute block.';
