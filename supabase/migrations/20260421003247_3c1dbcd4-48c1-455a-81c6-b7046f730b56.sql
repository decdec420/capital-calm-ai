-- 1) system_state: persisted snapshot from the most recent engine tick
ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS last_engine_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2) trade_signals: persisted strategy identity + lifecycle
ALTER TABLE public.trade_signals
  ADD COLUMN IF NOT EXISTS strategy_id uuid,
  ADD COLUMN IF NOT EXISTS lifecycle_phase text NOT NULL DEFAULT 'proposed',
  ADD COLUMN IF NOT EXISTS lifecycle_transitions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill lifecycle_phase from existing status so old rows render correctly
UPDATE public.trade_signals
SET lifecycle_phase = CASE
  WHEN status = 'pending'  THEN 'proposed'
  WHEN status = 'approved' THEN 'approved'
  WHEN status = 'executed' THEN 'executed'
  WHEN status = 'rejected' THEN 'rejected'
  WHEN status = 'expired'  THEN 'expired'
  WHEN status = 'halted'   THEN 'rejected'
  ELSE 'proposed'
END
WHERE lifecycle_phase = 'proposed' AND status <> 'pending';

CREATE INDEX IF NOT EXISTS idx_trade_signals_strategy_id ON public.trade_signals(strategy_id);
CREATE INDEX IF NOT EXISTS idx_trade_signals_lifecycle ON public.trade_signals(lifecycle_phase);

-- 3) trades: persisted strategy id (string version already exists) + lifecycle
ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS strategy_id uuid,
  ADD COLUMN IF NOT EXISTS lifecycle_phase text NOT NULL DEFAULT 'entered',
  ADD COLUMN IF NOT EXISTS lifecycle_transitions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill: closed trades become 'exited', tp1_filled but still open is 'tp1_hit'
UPDATE public.trades
SET lifecycle_phase = CASE
  WHEN status = 'closed' THEN 'exited'
  WHEN tp1_filled = true AND status = 'open' THEN 'tp1_hit'
  ELSE 'entered'
END
WHERE lifecycle_phase = 'entered';

CREATE INDEX IF NOT EXISTS idx_trades_strategy_id ON public.trades(strategy_id);
CREATE INDEX IF NOT EXISTS idx_trades_lifecycle ON public.trades(lifecycle_phase);

-- 4) guardrails: typed kind so UI can render proper icon + copy per guardrail
ALTER TABLE public.guardrails
  ADD COLUMN IF NOT EXISTS guardrail_type text NOT NULL DEFAULT 'generic';

-- Backfill guardrail_type by matching the existing label set seeded in handle_new_user()
UPDATE public.guardrails SET guardrail_type = 'size_cap'      WHERE label = 'Max order size'   AND guardrail_type = 'generic';
UPDATE public.guardrails SET guardrail_type = 'daily_loss'    WHERE label = 'Daily loss cap'   AND guardrail_type = 'generic';
UPDATE public.guardrails SET guardrail_type = 'trade_count'   WHERE label = 'Daily trade cap'  AND guardrail_type = 'generic';
UPDATE public.guardrails SET guardrail_type = 'balance_floor' WHERE label = 'Balance floor'    AND guardrail_type = 'generic';
UPDATE public.guardrails SET guardrail_type = 'spread'        WHERE label = 'Spread filter'    AND guardrail_type = 'generic';
UPDATE public.guardrails SET guardrail_type = 'stale_data'    WHERE label = 'Stale data'       AND guardrail_type = 'generic';
UPDATE public.guardrails SET guardrail_type = 'drawdown'      WHERE label = 'Drawdown'         AND guardrail_type = 'generic';
UPDATE public.guardrails SET guardrail_type = 'latency'       WHERE label = 'Latency'          AND guardrail_type = 'generic';