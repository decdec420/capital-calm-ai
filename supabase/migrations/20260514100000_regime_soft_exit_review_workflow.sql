-- ============================================================
-- PR #55 — Regime soft-exit simulation review workflow
-- ------------------------------------------------------------
-- Adds metadata-only review fields for REGIME_CHANGE_SOFT_EXIT simulation
-- records. The RPC below updates only decision_memory_simulations review
-- metadata. It does not close trades, call brokers, mutate stops/targets,
-- doctrine, strategies, or signals.
-- ============================================================

ALTER TABLE public.decision_memory_simulations
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS review_note text NULL;

ALTER TABLE public.decision_memory_simulations
  DROP CONSTRAINT IF EXISTS decision_memory_simulations_review_status_check;

ALTER TABLE public.decision_memory_simulations
  ADD CONSTRAINT decision_memory_simulations_review_status_check
    CHECK (review_status IN ('unreviewed', 'acknowledged', 'reviewed', 'dismissed'));

CREATE INDEX IF NOT EXISTS idx_dms_regime_soft_exit_review_status
  ON public.decision_memory_simulations (user_id, review_status, created_at DESC)
  WHERE simulation_type = 'REGIME_CHANGE_SOFT_EXIT';

CREATE OR REPLACE FUNCTION public.review_regime_soft_exit_simulation(
  p_simulation_id uuid,
  p_action text,
  p_review_note text DEFAULT NULL
)
RETURNS public.decision_memory_simulations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_row public.decision_memory_simulations;
BEGIN
  IF p_action = 'acknowledge' THEN
    v_status := 'acknowledged';
  ELSIF p_action = 'mark_reviewed' THEN
    v_status := 'reviewed';
  ELSIF p_action = 'dismiss' THEN
    v_status := 'dismissed';
  ELSE
    RAISE EXCEPTION 'Invalid soft-exit review action: %', p_action;
  END IF;

  UPDATE public.decision_memory_simulations
     SET review_status = v_status,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_note = NULLIF(p_review_note, ''),
         updated_at = now()
   WHERE id = p_simulation_id
     AND user_id = auth.uid()
     AND simulation_type = 'REGIME_CHANGE_SOFT_EXIT'
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Regime soft-exit simulation not found or not owned by current user';
  END IF;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.review_regime_soft_exit_simulation(uuid, text, text) TO authenticated;

COMMENT ON COLUMN public.decision_memory_simulations.review_status IS
  'Metadata-only operator review status for simulation artifacts. Does not imply execution.';
COMMENT ON COLUMN public.decision_memory_simulations.reviewed_at IS
  'When an operator last reviewed this simulation artifact.';
COMMENT ON COLUMN public.decision_memory_simulations.reviewed_by IS
  'Operator user id that last reviewed this simulation artifact.';
COMMENT ON COLUMN public.decision_memory_simulations.review_note IS
  'Optional operator note for simulation review; no trading side effects.';
COMMENT ON FUNCTION public.review_regime_soft_exit_simulation(uuid, text, text) IS
  'Metadata-only review action for REGIME_CHANGE_SOFT_EXIT simulations. Updates only review fields on decision_memory_simulations; never mutates trades, stops, take-profits, doctrine, strategies, signals, or broker execution.';
