## Current state — every AI role and its model

Found in `supabase/functions/_shared/ai-provenance.ts` (`MODEL_REGISTRY`) and per-function constants:


| Role / Agent               | Function            | Model today                                 | Supported?                                    | Right size?           |
| -------------------------- | ------------------- | ------------------------------------------- | --------------------------------------------- | --------------------- |
| Taylor (Technical Analyst) | signal-engine       | `google/gemini-3-flash-preview`             | ✅                                             | ✅ default             |
| Bobby (Risk Manager)       | signal-engine       | `anthropic/claude-sonnet-4-6`               | ❌ not in Lovable AI list                      | needs heavy reasoning |
| Bobby Orchestration        | (registry only)     | `google/gemini-2.0-flash-001`               | ❌ retired (same bug we just fixed in Jessica) | —                     |
| Jessica (Heartbeat)        | jessica             | `google/gemini-2.5-flash`                   | ✅                                             | ✅                     |
| Hall                       | hall                | `anthropic/claude-sonnet-4-6`               | ❌                                             | overkill              |
| Hall (registry)            | market-intelligence | `google/gemini-2.5-flash`                   | ✅                                             | ✅                     |
| Bill                       | market-intelligence | `google/gemini-2.5-flash`                   | ✅                                             | ✅                     |
| Mafee                      | market-intelligence | `google/gemini-2.5-flash-lite`              | ✅                                             | ✅ cheapest            |
| Chuck                      | chuck               | `anthropic/claude-sonnet-4-6`               | ❌                                             | —                     |
| Wendy (Trade Coach)        | post-trade-learn    | `anthropic/claude-sonnet-4-6`               | ❌                                             | needs reasoning       |
| Spyros                     | katrina             | `google/gemini-2.5-flash`                   | ✅                                             | ✅                     |
| Daily Brief                | daily-brief         | `google/gemini-2.5-flash`                   | ✅                                             | ✅                     |
| Market Brief               | market-brief        | `google/gemini-2.5-flash-lite`              | ✅                                             | ✅ cheapest            |
| Signal Explain             | signal-explain      | `google/gemini-3-flash-preview` (hardcoded) | ✅                                             | ✅                     |
| Journal Explain            | journal-explain     | `google/gemini-3-flash-preview` (hardcoded) | ✅                                             | ✅                     |
| Copilot Chat               | copilot-chat        | `google/gemini-3-flash-preview` (hardcoded) | ✅                                             | ✅                     |
| Propose Experiment         | propose-experiment  | `google/gemini-3-flash-preview` (hardcoded) | ✅                                             | ✅                     |


### Problems

1. **Five roles use `anthropic/claude-sonnet-4-6**` — Anthropic is not in Lovable AI Gateway's documented supported model list. These calls will fail (or silently degrade) the moment the route is exercised. No recent successful logs from `chuck`, `post-trade-learn`, or the `risk_manager` path in `signal-engine` confirm this is silently broken.
2. `**MODEL_REGISTRY.BOBBY_ORCHESTRATION = "google/gemini-2.0-flash-001"**` — same retired model that broke Jessica. Currently unused at call-sites but provenance tags using it will be wrong; it's a landmine.
3. **Inconsistency**: four functions hardcode the model string instead of using `MODEL_REGISTRY`, so future changes drift.
4. **Cheapest-fit review**: Mafee and Market Brief are already on `flash-lite` (cheapest). Hall/Bill on `2.5-flash` is reasonable but could move to the newer `3-flash-preview` for parity at similar cost. Heavy-reasoning roles (Bobby risk, Wendy coach, Chuck) need a real reasoner.

## Proposed changes

### 1. Replace Anthropic with supported models


| Role                      | Proposed model                  | Why                                                            |
| ------------------------- | ------------------------------- | -------------------------------------------------------------- |
| Bobby (risk manager)      | `google/gemini-3.1-pro-preview` | Strong next-gen reasoning, needed for portfolio risk decisions |
| Wendy (trade coach)       | `google/gemini-3.1-pro-preview` | Post-trade analysis benefits from deeper reasoning             |
| Chuck                     | `google/gemini-3-flash-preview` | Standard agent work, cheaper than pro                          |
| Hall (in `hall/index.ts`) | `google/gemini-2.5-flash`       | Matches existing registry value                                |


If you prefer OpenAI for the pro tier, swap `google/gemini-3.1-pro-preview` → `openai/gpt-5` (more expensive). I'll default to Gemini pro for cost.

### 2. Fix `MODEL_REGISTRY.BOBBY_ORCHESTRATION`

Set to `google/gemini-3-flash-preview` (same family as Taylor; orchestration doesn't need pro).

### 3. Centralize model selection

Make the four hardcoded call-sites (`signal-explain`, `journal-explain`, `copilot-chat`, `propose-experiment`) read from `MODEL_REGISTRY` so we have one source of truth.

### 4. Final registry after changes

```text
TAYLOR              google/gemini-3-flash-preview
BOBBY               google/gemini-3.1-pro-preview   (was anthropic)
HALL                google/gemini-2.5-flash
BILL                google/gemini-2.5-flash
MAFEE               google/gemini-2.5-flash-lite     (cheapest, unchanged)
WENDY               google/gemini-3.1-pro-preview   (was anthropic)
EXPERIMENT          google/gemini-3-flash-preview
DAILY_BRIEF         google/gemini-2.5-flash
JOURNAL_EXPLAIN     google/gemini-3-flash-preview
MARKET_BRIEF        google/gemini-2.5-flash-lite     (cheapest, unchanged)
SIGNAL_EXPLAIN      google/gemini-3-flash-preview
WAGS                google/gemini-3-flash-preview
BOBBY_ORCHESTRATION google/gemini-3-flash-preview   (was retired 2.0)
```

Per-function constants (`CHUCK_MODEL`, `HALL_MODEL`, `RISK_MANAGER_MODEL`, `TRADE_COACH_MODEL`, `JESSICA_MODEL`, `SPYROS_MODEL`, `BRIEF_MODEL`) updated to match.

## Related API/health issues surfaced while auditing (not AI-model bugs, flagging only)

These showed up in current logs — outside the model audit, but you asked "are the APIs all good?":

- `activate-doctrine-changes`: throws `ReferenceError: cors is not defined` at line 109 — function is broken on every invocation.
- `market-intelligence`: every upsert fails with `Could not find the 'ai_provenance' column of 'market_intelligence'` — DB column missing, no intelligence is being persisted.
- `signal-engine`: `Could not find the table 'public.decision_memory'` — decision memory writes silently dropped.
- `jessica`: Coinbase health probe returns 401 — broker credentials issue (not AI).

Want me to fold any of these into the same pass, or address only the model audit now?   
FOLD these in and take care of these too.

## Files to edit (model audit only)

- `supabase/functions/_shared/ai-provenance.ts` — registry values
- `supabase/functions/signal-engine/index.ts` — `RISK_MANAGER_MODEL`
- `supabase/functions/post-trade-learn/index.ts` — `TRADE_COACH_MODEL`
- `supabase/functions/chuck/index.ts` — `CHUCK_MODEL`
- `supabase/functions/hall/index.ts` — `HALL_MODEL`
- `supabase/functions/signal-explain/index.ts` — use `MODEL_REGISTRY.SIGNAL_EXPLAIN`
- `supabase/functions/journal-explain/index.ts` — use `MODEL_REGISTRY.JOURNAL_EXPLAIN`
- `supabase/functions/copilot-chat/index.ts` — use registry (new key `COPILOT`)
- `supabase/functions/propose-experiment/index.ts` — use `MODEL_REGISTRY.EXPERIMENT`