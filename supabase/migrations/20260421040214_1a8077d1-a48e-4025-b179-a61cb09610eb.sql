ALTER TABLE public.experiments
  ADD COLUMN IF NOT EXISTS proposed_by text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS hypothesis text,
  ADD COLUMN IF NOT EXISTS backtest_result jsonb,
  ADD COLUMN IF NOT EXISTS strategy_id uuid,
  ADD COLUMN IF NOT EXISTS auto_resolved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_experiments_user_status
  ON public.experiments (user_id, status);

CREATE INDEX IF NOT EXISTS idx_experiments_user_needs_review
  ON public.experiments (user_id, needs_review)
  WHERE needs_review = true;