-- Add broker order ID columns to trades table.
-- These are populated in live mode so every real-money position has an
-- auditable Coinbase order reference. Null in paper mode.
--
-- broker_order_id:       Coinbase order ID for the opening trade (BUY)
-- broker_close_order_id: Coinbase order ID for the closing trade (SELL)

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS broker_order_id      text,
  ADD COLUMN IF NOT EXISTS broker_close_order_id text;

COMMENT ON COLUMN public.trades.broker_order_id IS
  'Coinbase Advanced Trade order ID for the opening BUY. Null in paper mode.';

COMMENT ON COLUMN public.trades.broker_close_order_id IS
  'Coinbase Advanced Trade order ID for the closing SELL. Null in paper mode or while open.';
