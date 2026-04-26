-- 1. copilot_memory table
CREATE TABLE public.copilot_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  parameter text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('increase', 'decrease')),
  from_value numeric NOT NULL,
  to_value numeric NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'noise')),
  exp_delta numeric,
  win_rate_delta numeric,
  sharpe_delta numeric,
  drawdown_delta numeric,
  attempt_count integer NOT NULL DEFAULT 1,
  last_tried_at timestamptz NOT NULL DEFAULT now(),
  retry_after timestamptz,
  experiment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, parameter, direction)
);

ALTER TABLE public.copilot_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own copilot_memory select" ON public.copilot_memory
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own copilot_memory insert" ON public.copilot_memory
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own copilot_memory update" ON public.copilot_memory
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own copilot_memory delete" ON public.copilot_memory
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX idx_copilot_memory_user
  ON public.copilot_memory(user_id, parameter, direction);

CREATE TRIGGER set_copilot_memory_updated_at
  BEFORE UPDATE ON public.copilot_memory
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. upsert_copilot_memory RPC
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
  p_retry_after timestamptz,
  p_experiment_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.copilot_memory (
    user_id, parameter, direction, from_value, to_value,
    outcome, exp_delta, win_rate_delta, sharpe_delta, drawdown_delta,
    retry_after, experiment_id, attempt_count, last_tried_at
  ) VALUES (
    p_user_id, p_parameter, p_direction, p_from_value, p_to_value,
    p_outcome, p_exp_delta, p_win_rate_delta, p_sharpe_delta, p_drawdown_delta,
    p_retry_after, p_experiment_id, 1, now()
  )
  ON CONFLICT (user_id, parameter, direction) DO UPDATE SET
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
$$;