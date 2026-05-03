-- Phase 2: per-strategy circuit breaker + synthetic short audit flag
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS consecutive_losses int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_pause_reason text;

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS synthetic_short boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_strategies_user_status_regime
  ON public.strategies (user_id, status)
  WHERE status = 'approved';