ALTER TABLE public.system_state
  ADD COLUMN IF NOT EXISTS paper_account_balance numeric NOT NULL DEFAULT 1000.00,
  ADD COLUMN IF NOT EXISTS trading_paused_until timestamptz NULL;

-- params_wired_live already exists (default true). Ensure it is present and re-document.
ALTER TABLE public.system_state
  ALTER COLUMN params_wired_live SET DEFAULT false;

COMMENT ON COLUMN public.system_state.paper_account_balance IS
  'Virtual paper trading balance in USD. Starts at $1000. Updated on every paper trade close.';
COMMENT ON COLUMN public.system_state.params_wired_live IS
  'True once strategy params are wired into the live signal engine.';
COMMENT ON COLUMN public.system_state.trading_paused_until IS
  'When set, no new trades proposed until this timestamp passes.';