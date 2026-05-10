-- =============================================================================
-- Add replay_packet JSONB column to trade_signals
-- =============================================================================
-- Context: PR #35 — Persist replayable decision packets for every
--   signal/proposal/trade decision so future sessions can reconstruct
--   exactly why a trade was approved, vetoed, or skipped.
--
-- Schema rules enforced here and in the application layer:
--   - replay_packet stores ONLY non-sensitive metadata (see decision-replay.ts).
--   - Raw Coinbase credentials, authorization headers, and private API keys
--     are NEVER stored in this column.
--   - Full prompt text is NEVER stored — only a version tag + input hash.
--   - Column is nullable: legacy signals have NULL; new signals always have
--     a packet written immediately after INSERT.
--
-- Storage target rationale:
--   trade_signals already contains the canonical decision record (status,
--   confidence, ai_reasoning, context_snapshot). Adding replay_packet here
--   keeps all decision audit data in one row — no JOIN needed. system_events
--   is an append-only audit log not suited for per-signal structured replay;
--   journal_entries is narrative/human-readable and not the right shape.
-- =============================================================================

ALTER TABLE public.trade_signals
  ADD COLUMN IF NOT EXISTS replay_packet JSONB DEFAULT NULL;

-- Index to allow future queries like "all vetoed signals in the last 7 days"
-- or "all signals with coach penalty applied".
-- Partial index: only index rows that actually have a packet.
CREATE INDEX IF NOT EXISTS idx_trade_signals_replay_packet
  ON public.trade_signals USING GIN (replay_packet)
  WHERE replay_packet IS NOT NULL;

COMMENT ON COLUMN public.trade_signals.replay_packet IS
  'Replayable decision packet (DecisionReplayPacket v1). '
  'Contains non-sensitive metadata: market context, doctrine snapshot, '
  'risk gate summary, AI model metadata (no credentials), and decision outcome. '
  'Written by signal-engine immediately after INSERT. '
  'Never contains raw API keys, broker credentials, or full prompt text.';
