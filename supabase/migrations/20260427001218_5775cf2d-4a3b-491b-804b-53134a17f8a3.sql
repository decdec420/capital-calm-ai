ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS last_evaluated_at TIMESTAMPTZ;