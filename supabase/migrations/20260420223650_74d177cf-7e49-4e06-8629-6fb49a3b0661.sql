ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS tp1_price numeric,
  ADD COLUMN IF NOT EXISTS tp1_filled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS original_size numeric;