I checked the live data and the UI is right to be suspicious: these systems are using different clocks.

Current state:
- `market_intelligence.recent_momentum_at` is fresh for BTC/ETH/SOL, about 0–1 minutes old.
- The engine snapshot is stale/incorrect because its last tick recorded `momentum1h: null`, `momentum4h: null`, so it blocked with `BRAIN_TRUST_MOMENTUM_STALE`.
- Wags is reading `agent_health.brain_trust`, which is an old failed row from Apr 29 with `Stale 9999m`. That row has not been cleared even though Brain Trust is now producing fresh momentum.
- Bobby’s health writer only refreshes `agent_health.brain_trust` after a Coinbase health probe; that probe is currently returning 401, so Bobby exits before updating health. Result: Wags keeps repeating the old failure.

Plan:

1. Make Brain Trust update its own health row
- In `supabase/functions/market-intelligence/index.ts`, after a successful run/upsert, write `agent_health` for `brain_trust` as healthy.
- Use the actual short-horizon momentum freshness (`recent_momentum_at`, `recent_momentum_1h`, `recent_momentum_4h`) rather than the macro `generated_at` timestamp.
- If an individual symbol fails to produce momentum, record a degraded/failed health row with a clear error.

2. Fix Wags’ health context so stale failed rows do not override fresh market data
- In `supabase/functions/copilot-chat/index.ts`, load a server-authoritative Brain Trust snapshot from `market_intelligence` alongside `agent_health`.
- If all tracked symbols have fresh momentum, override/supplement the old `agent_health.brain_trust` row as healthy in Wags’ context.
- Add explicit context fields like `brainTrustMomentumFresh`, `freshestMomentumAt`, and per-symbol momentum ages so Wags can answer “is Brain Trust working?” accurately.

3. Align the Copilot page timestamps with the engine gate
- In `src/pages/Copilot.tsx`, stop using only `generated_at` for the top “Brain Trust · 11m ago” strip.
- Track both:
  - Brain Trust macro brief age from `generated_at`
  - Mafee/momentum age from `recent_momentum_at`
- Display the more relevant momentum freshness in the agent strip, since that is what the engine blocks on.

4. Align Market Intelligence wording with actual cadence
- In `src/components/trader/MarketIntelligencePanel.tsx`, change the copy so it doesn’t imply the whole Brain Trust only refreshes every 4h.
- Suggested wording: “Three AI experts · macro refreshed on schedule · momentum refreshes continuously.”
- Keep the existing per-symbol “Momentum fresh/stale” badges.

5. Fix the engine’s read of Brain Trust success metadata
- In `supabase/functions/signal-engine/index.ts`, remove/select only real columns from `market_intelligence`.
- The function currently selects `last_updated`, which does not exist. That makes `lastBrainTrustSuccessAt` null in gate metadata and contributes to misleading diagnostics.
- Use `recent_momentum_at` for momentum success time and `generated_at` for macro success time.

6. Optional but recommended: make “Run full pipeline” refresh the screen state after both stages
- After Brain Trust and engine complete, reload market intelligence, agent health, and system state so the UI does not show the prior tick’s stale gate while the database is already fresh.

Expected result:
- If Brain Trust momentum is fresh, Wags will say it is working.
- The agent strip will not show “Brain Trust failed” due to a stale Apr 29 health row.
- The engine’s stale-momentum block should clear on the next engine tick after fresh momentum is available.
- If there is a real upstream failure, the UI/Wags will say exactly which layer is stale: macro brief, momentum read, engine snapshot, or Bobby/Coinbase.