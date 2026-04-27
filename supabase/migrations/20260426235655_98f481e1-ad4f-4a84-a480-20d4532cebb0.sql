ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS friendly_summary TEXT;

ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS last_auto_promoted_at TIMESTAMP WITH TIME ZONE;