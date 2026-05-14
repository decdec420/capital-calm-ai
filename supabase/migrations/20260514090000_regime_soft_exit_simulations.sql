-- ============================================================
-- PR #54 — Regime-change soft-exit simulation records
-- ------------------------------------------------------------
-- Storage is simulation-only. These rows are review/learning artifacts and do
-- not trigger execution, broker calls, trade closes, stop updates, take-profit
-- updates, doctrine changes, strategy changes, or signal approval.
-- ============================================================

ALTER TABLE public.decision_memory_simulations
  DROP CONSTRAINT IF EXISTS chk_dms_simulation_type;

ALTER TABLE public.decision_memory_simulations
  ADD CONSTRAINT chk_dms_simulation_type
    CHECK (simulation_type IN (
      'TAKEN_IF_NOT_BLOCKED',
      'SKIP_BASELINE',
      'REGIME_CHANGE_SOFT_EXIT'
    ));

CREATE INDEX IF NOT EXISTS idx_dms_regime_soft_exit_recent
  ON public.decision_memory_simulations (user_id, symbol, created_at DESC)
  WHERE simulation_type = 'REGIME_CHANGE_SOFT_EXIT';

CREATE INDEX IF NOT EXISTS idx_dms_regime_soft_exit_trade_regime
  ON public.decision_memory_simulations (
    user_id,
    ((input_snapshot->>'tradeId')),
    ((input_snapshot->>'currentRegime')),
    created_at DESC
  )
  WHERE simulation_type = 'REGIME_CHANGE_SOFT_EXIT';

COMMENT ON CONSTRAINT chk_dms_simulation_type ON public.decision_memory_simulations IS
  'Allowed simulation types. REGIME_CHANGE_SOFT_EXIT is dry-run only: execution_allowed=false, no broker calls, no trade/stop/take-profit/doctrine/strategy mutation.';

COMMENT ON INDEX public.idx_dms_regime_soft_exit_recent IS
  'Recent regime-change soft-exit simulations for operator review. Simulation only; no execution side effects.';

COMMENT ON INDEX public.idx_dms_regime_soft_exit_trade_regime IS
  'Dedupe support for one REGIME_CHANGE_SOFT_EXIT simulation per trade/current-regime window. Simulation only; no execution side effects.';
