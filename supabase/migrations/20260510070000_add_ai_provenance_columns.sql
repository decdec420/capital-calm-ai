-- =============================================================================
-- PR #45 — Add ai_provenance jsonb to AI-producing tables
-- =============================================================================
-- Adds a nullable ai_provenance jsonb column to:
--   1. market_intelligence — one row per (user, symbol); updated every Brain Trust run
--   2. daily_briefs        — one row per (user, brief_date)
--   3. strategy_learning_recommendations — deterministic provenance (provider="none")
--
-- The column stores an AiProvenance object (see _shared/ai-provenance.ts):
--   { decisionType, provider, model, promptId, promptVersion, schemaVersion,
--     validator, validationStatus, validationErrorCount, fallbackUsed,
--     fallbackReason?, inputHash, outputHash?, createdAt, artifactIds? }
--
-- Security invariants:
--   - NEVER store API keys, bearer tokens, auth headers, or raw prompts.
--   - Only store IDs, version tags, model names, hashes, and validation status.
-- =============================================================================

ALTER TABLE public.market_intelligence
  ADD COLUMN IF NOT EXISTS ai_provenance jsonb NULL;

COMMENT ON COLUMN public.market_intelligence.ai_provenance IS
  'AiProvenance record for the most recent Brain Trust run. '
  'Never contains API keys, tokens, or raw prompt text. '
  'Null when no AI run has completed for this row yet.';

ALTER TABLE public.daily_briefs
  ADD COLUMN IF NOT EXISTS ai_provenance jsonb NULL;

COMMENT ON COLUMN public.daily_briefs.ai_provenance IS
  'AiProvenance record for the AI that generated this brief. '
  'Never contains API keys, tokens, or raw prompt text.';

ALTER TABLE public.strategy_learning_recommendations
  ADD COLUMN IF NOT EXISTS ai_provenance jsonb NULL;

COMMENT ON COLUMN public.strategy_learning_recommendations.ai_provenance IS
  'Provenance for this recommendation. provider="none" because recommendations '
  'are generated deterministically from enriched simulation data — no AI model call. '
  'validationStatus="skipped" for the same reason.';
