-- Symbol-isolate copilot memory.
-- Different symbols (BTC vs ETH vs SOL) have very different volatility and
-- behavior; a learning that says "stop_atr_mult increase = noise" on BTC
-- should not block the same exploration on SOL.

-- 1. Add the column. Backfill historical rows with a sentinel ("ALL") so
--    legacy entries still match against any symbol if the AI consults them.
ALTER TABLE public.copilot_memory
  ADD COLUMN IF NOT EXISTS symbol text NOT NULL DEFAULT 'ALL';

-- 2. Replace the old per-(user, parameter, direction) unique with a new
--    per-(user, parameter, direction, symbol) unique so the upsert can
--    keep distinct rows per symbol.
ALTER TABLE public.copilot_memory
  DROP CONSTRAINT IF EXISTS copilot_memory_user_id_parameter_direction_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'copilot_memory_user_param_dir_symbol_key'
  ) THEN
    ALTER TABLE public.copilot_memory
      ADD CONSTRAINT copilot_memory_user_param_dir_symbol_key
      UNIQUE (user_id, parameter, direction, symbol);
  END IF;
END $$;

-- 3. Update the upsert RPC to take p_symbol and key on it.
CREATE OR REPLACE FUNCTION public.upsert_copilot_memory(
  p_user_id uuid,
  p_parameter text,
  p_direction text,
  p_from_value numeric,
  p_to_value numeric,
  p_outcome text,
  p_exp_delta numeric,
  p_win_rate_delta numeric,
  p_sharpe_delta numeric,
  p_drawdown_delta numeric,
  p_retry_after timestamp with time zone,
  p_experiment_id uuid DEFAULT NULL::uuid,
  p_symbol text DEFAULT 'ALL'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.copilot_memory (
    user_id, parameter, direction, symbol,
    from_value, to_value,
    outcome, exp_delta, win_rate_delta, sharpe_delta, drawdown_delta,
    retry_after, experiment_id, attempt_count, last_tried_at
  ) VALUES (
    p_user_id, p_parameter, p_direction, COALESCE(p_symbol, 'ALL'),
    p_from_value, p_to_value,
    p_outcome, p_exp_delta, p_win_rate_delta, p_sharpe_delta, p_drawdown_delta,
    p_retry_after, p_experiment_id, 1, now()
  )
  ON CONFLICT (user_id, parameter, direction, symbol) DO UPDATE SET
    attempt_count = public.copilot_memory.attempt_count + 1,
    last_tried_at = now(),
    from_value = EXCLUDED.from_value,
    to_value = EXCLUDED.to_value,
    outcome = EXCLUDED.outcome,
    exp_delta = EXCLUDED.exp_delta,
    win_rate_delta = EXCLUDED.win_rate_delta,
    sharpe_delta = EXCLUDED.sharpe_delta,
    drawdown_delta = EXCLUDED.drawdown_delta,
    retry_after = EXCLUDED.retry_after,
    experiment_id = COALESCE(EXCLUDED.experiment_id, public.copilot_memory.experiment_id),
    updated_at = now();
END;
$function$;

-- 4. Add a symbol column to experiments so we know which symbol an
--    experiment was run on, and the proposer can symbol-scope its
--    suggestions. Defaults to 'BTC-USD' (current behavior).
ALTER TABLE public.experiments
  ADD COLUMN IF NOT EXISTS symbol text NOT NULL DEFAULT 'BTC-USD';
