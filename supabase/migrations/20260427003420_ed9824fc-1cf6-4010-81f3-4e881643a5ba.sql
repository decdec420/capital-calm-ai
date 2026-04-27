-- Brain Trust intelligence cache. One row per (user, symbol) holding the latest
-- brief from three expert AI agents (Macro Strategist, Crypto Intel Analyst,
-- Pattern Recognition Specialist). Refreshed by cron every 4 hours.
CREATE TABLE IF NOT EXISTS public.market_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,

  -- Macro Strategist
  macro_bias text NOT NULL DEFAULT 'neutral',
  macro_confidence numeric NOT NULL DEFAULT 0.5,
  market_phase text NOT NULL DEFAULT 'unknown',
  trend_structure text NOT NULL DEFAULT 'unknown',
  nearest_support numeric,
  nearest_resistance numeric,
  key_level_notes text,
  macro_summary text NOT NULL DEFAULT '',

  -- Crypto Intelligence Analyst
  funding_rate_signal text NOT NULL DEFAULT 'neutral',
  funding_rate_pct numeric,
  fear_greed_score integer,
  fear_greed_label text,
  sentiment_summary text NOT NULL DEFAULT '',
  environment_rating text NOT NULL DEFAULT 'neutral',

  -- Pattern Recognition Specialist
  pattern_context text NOT NULL DEFAULT '',
  entry_quality_context text NOT NULL DEFAULT '',

  -- Meta
  generated_at timestamptz NOT NULL DEFAULT now(),
  candle_count_1h integer,
  candle_count_4h integer,
  candle_count_1d integer,

  UNIQUE (user_id, symbol)
);

ALTER TABLE public.market_intelligence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own intelligence select" ON public.market_intelligence
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "own intelligence insert" ON public.market_intelligence
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own intelligence update" ON public.market_intelligence
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "own intelligence delete" ON public.market_intelligence
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_market_intelligence_user_symbol
  ON public.market_intelligence(user_id, symbol);