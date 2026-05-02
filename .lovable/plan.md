I found the mismatch: the database and function logs now show Brain Trust is healthy and fresh, but Wags is being pulled back by old assistant messages in the same conversation that repeatedly said “9999m / Unauthorized.” The current chat function sends those stale messages back to the model before the fresh server context, so the model is treating the old failure as current truth.

Plan:

1. Make Wags trust live backend state over prior chat history
   - Update `supabase/functions/copilot-chat/index.ts` so the system prompt explicitly says: current `brainTrust` and `agentHealth` context overrides older conversation messages.
   - Add a direct rule: if `brainTrust.momentumFresh === true`, Wags must not report Brain Trust as failed/stale/9999m, even if earlier messages said that.
   - Include the actual last Brain Trust freshness age and per-symbol ages in plain language so Wags has an easy current fact to quote.

2. Stop stale failure messages from poisoning the model
   - When loading history in `copilot-chat`, keep normal conversation context but filter or annotate old assistant messages that contain obsolete Brain Trust failure phrases like `9999m`, `Unauthorized`, or `flying blind` when live Brain Trust is fresh.
   - This preserves useful history while preventing yesterday’s outage from overriding today’s live state.

3. Tighten health source-of-truth in the UI context
   - Update `src/pages/Copilot.tsx` so `buildContext()` includes current Brain Trust freshness derived from `market_intelligence` timestamps, not just the older health strip state.
   - This gives Wags the same freshness truth the screen shows.

4. Patch the Bobby/Jessica false-auth-noise separately
   - In `supabase/functions/jessica/index.ts`, move the Brain Trust health check before the Coinbase broker probe, or make the probe report `broker_health` instead of blocking agent health updates.
   - Reason: Bobby’s Coinbase probe is still logging HTTP 401, but that is broker connectivity, not Brain Trust health. Wags should not translate that into “Brain Trust unauthorized.”

5. Verify live behavior
   - Query `agent_health` and `market_intelligence` after the change to confirm Brain Trust reads healthy/fresh.
   - Ask Wags “is brain trust running? when was last run?” and confirm it answers with the fresh timestamp instead of the old 9999m outage.

Expected result: Wags should say something like “Yes — Brain Trust is healthy; latest momentum is about 2 minutes old across BTC/ETH/SOL,” while still separately mentioning broker/Bobby auth issues only if they are actually relevant.