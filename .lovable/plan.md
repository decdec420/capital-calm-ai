## Two-part plan

### Part 1: "Jessica" in the codebase — no code change

You're seeing it in file paths, edge function names, and audit logs. Per `docs/tool-inventory.md`, that's **intentional**:

- `supabase/functions/jessica/` — edge function path, deployed under that name
- `tool_calls.actor = 'jessica_autonomous'` — historical audit rows
- `system_events.actor` — same
- DB columns / migrations referencing the legacy ID

A CI guard (`src/test/persona-legacy-token-guard.test.ts`) already blocks "Jessica" from any UI-facing file. Renaming the technical layer would:
- Break replay of every historical `tool_calls` / `system_events` row
- Require a destructive migration on production audit data
- Force redeployment of the edge function under a new name (breaking any external webhooks/cron pointing at it)

**Recommendation: leave it.** The user-facing label is already Bobby everywhere it matters. If you want, I can add a one-line comment at the top of `supabase/functions/jessica/index.ts` explicitly noting "this function powers Bobby — name retained for audit-trail compatibility" so future-you doesn't wonder again.

### Part 2: Tighten the 3 expert prompts (keep all three, share more context)

**Goal:** reduce token cost and eliminate the chance of the three experts contradicting each other on shared facts (regime, S/R, news context), without collapsing the cadence tiers.

**Current state:** Each expert (`Hall`, `Dollar Bill`, `Mafee`) has its own ~150-line system prompt in `supabase/functions/market-intelligence/index.ts`. They duplicate:
- Crypto market preamble / desk context
- Output schema framing instructions
- Definitions of "regime", "phase", "environment_rating"
- General tone/voice rules

Mafee already gets Hall's S/R passed in, but Bill and Mafee don't see each other's prior outputs at all.

**Changes:**

1. **Extract a shared `BRAIN_TRUST_PREAMBLE` constant** (~30 lines) covering desk context, output discipline rules, and the shared vocabulary (regime / phase / environment_rating definitions). Prepend it to each expert's system prompt instead of duplicating.

2. **Add a `peerContext` block** passed into each expert call:
   - **Hall** receives: Bill's last `environment_rating` + headline news flags (so macro reasoning accounts for current sentiment)
   - **Bill** receives: Hall's last `phase` + S/R levels (so news framing knows the structural backdrop)
   - **Mafee** already receives Hall's S/R — also add Bill's `environment_rating` (so pattern reads weight risk-on vs risk-off)
   
   Format as a compact 4–6 line "Peer desk read (as of HH:MM)" block, not a full prompt dump.

3. **Trim each expert's system prompt** by removing the now-redundant preamble/schema sections. Estimated reduction: ~40% of input tokens per call.

4. **Keep cadence and freshness tiers exactly as-is** (Mafee 1m / Bill 5m / Hall 15m + S/R-break event trigger). No change to the staleness penalty in `signal-engine`.

5. **Keep all three model assignments** from the previous audit pass:
   - Mafee → `gemini-2.5-flash-lite`
   - Bill / Hall → `gemini-2.5-flash`

**Expected impact:**
- ~30–40% input-token reduction per expert call → roughly **$50–70/mo savings** on top of the model-tier optimization
- Fewer cross-expert contradictions (Mafee no longer flags a "perfect long" while Bill's last read was a CPI miss)
- No change to refresh cadence, no change to UI, no change to DB schema

### Files touched

- `supabase/functions/market-intelligence/index.ts` — extract shared preamble, trim 3 expert prompts, add peerContext to each call site, read prior peer outputs from the existing `prev` row already loaded at the top of `runBrainTrust`
- `supabase/functions/jessica/index.ts` — add a single header comment clarifying "Bobby (legacy actor ID retained)"

No DB migration. No frontend changes. No new env vars.