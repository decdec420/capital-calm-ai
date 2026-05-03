-- Phase 5: Live execution plumbing
CREATE TABLE IF NOT EXISTS public.broker_fills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  trade_id        uuid REFERENCES public.trades(id) ON DELETE SET NULL,
  symbol          text NOT NULL,
  side            text NOT NULL CHECK (side IN ('BUY','SELL')),
  fill_kind       text NOT NULL CHECK (fill_kind IN ('entry','tp1','tp2','tp3','stop','manual_close','rebalance')),
  client_order_id text NOT NULL,
  broker_order_id text,
  fill_price      numeric NOT NULL,
  base_size       numeric NOT NULL,
  quote_size      numeric NOT NULL,
  fees_usd        numeric NOT NULL DEFAULT 0,
  proposed_price  numeric,
  slippage_pct    numeric,
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_broker_fills_user_created
  ON public.broker_fills (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_broker_fills_trade
  ON public.broker_fills (trade_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_broker_fills_client_order
  ON public.broker_fills (user_id, client_order_id, fill_kind);

ALTER TABLE public.broker_fills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own broker_fills select" ON public.broker_fills;
CREATE POLICY "own broker_fills select"
  ON public.broker_fills FOR SELECT
  USING (auth.uid() = user_id);

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS entry_fees_usd      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exit_fees_usd       numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS entry_slippage_pct  numeric,
  ADD COLUMN IF NOT EXISTS effective_pnl       numeric,
  ADD COLUMN IF NOT EXISTS partial_fill        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requested_size      numeric;

ALTER TABLE public.doctrine_settings
  ADD COLUMN IF NOT EXISTS prefer_maker_orders boolean NOT NULL DEFAULT false;

ALTER TABLE public.doctrine_symbol_overrides
  ADD COLUMN IF NOT EXISTS prefer_maker_orders boolean;

CREATE OR REPLACE VIEW public.live_execution_stats_v
WITH (security_invoker = true)
AS
SELECT
  user_id,
  COUNT(*)                                                  AS fill_count,
  COALESCE(SUM(fees_usd) / NULLIF(SUM(quote_size), 0), 0)   AS avg_fee_pct_per_side,
  COALESCE(AVG(ABS(slippage_pct)) FILTER (WHERE slippage_pct IS NOT NULL), 0)
                                                            AS avg_slippage_pct_per_side,
  MAX(created_at)                                           AS last_fill_at
FROM public.broker_fills
WHERE created_at > now() - interval '30 days'
  AND quote_size > 0
GROUP BY user_id;

GRANT SELECT ON public.live_execution_stats_v TO authenticated, anon;