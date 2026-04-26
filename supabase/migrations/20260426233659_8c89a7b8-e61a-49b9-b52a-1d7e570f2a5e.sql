ALTER TABLE public.system_state
ADD COLUMN IF NOT EXISTS params_wired_live boolean NOT NULL DEFAULT true;
