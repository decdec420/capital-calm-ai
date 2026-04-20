

## Wire Trader OS to live data

Goodbye `src/mocks/data.ts`. Every page gets real prices, real per-user persistence, and real AI — all behind your auth. New users land on a clean slate with one starter strategy and the default guardrails so the app is immediately usable.

### What you'll get

**1. Real BTC-USD prices**
- `PriceChart` and `marketRegime` swap mock candles for live Coinbase public API data (`/products/BTC-USD/candles`, no key needed).
- A `useCandles(symbol, granularity)` hook polls every 30s and recomputes regime (trending/range/chop), volatility, and a setup score from the actual candles.
- The Overview hero, MarketIntel page, and StrategyLab all read from this single source.

**2. Per-user persistence in Lovable Cloud**
Eight new tables, all RLS-locked to `auth.uid()`, every page reads/writes the operator's own data:

| Table | Drives |
|---|---|
| `account_state` | Equity, cash, daily PnL, balance floor (one row per user) |
| `system_state` | Bot mode, status, kill-switch, live-trading gate (one row per user) |
| `strategies` | Strategy Lab cards, versions, params (jsonb), metrics (jsonb) |
| `trades` | Trades page table + open position (status: open/closed) |
| `journal_entries` | Journals page (kind, title, summary, tags, llm_explanation) |
| `guardrails` | Risk Center rows (label, current, limit, level, utilization) |
| `experiments` | Strategy Lab experiment list |
| `alerts` | Overview alert banner stack |

**3. Auto-seed on signup**
The existing `handle_new_user` trigger gets extended to also seed:
- 1 row in `account_state` ($10,000 paper equity, $9,500 floor)
- 1 row in `system_state` (paper mode, bot paused)
- 1 strategy: `trend-rev v1.3` approved, with the same params from the mock
- 8 default guardrails (max order size, daily loss cap, spread filter, etc.)

Trades, journals, experiments, alerts all start empty — pages render the existing `EmptyState` component with a punchy copy line and a "create" CTA.

**4. Full CRUD across the board**
Every entity gets create/edit/delete forms behind dialogs:
- **Trades** — "Log trade" dialog (symbol, side, size, entry, stop, TP, strategy). Open trades have "Close trade" → fills exit price + outcome.
- **Journals** — "New entry" dialog with kind selector, tags input, optional "Generate LLM explanation" button.
- **Strategies** — "New version" dialog (clone params from selected version, edit jsonb params), promote/archive actions hit the row's `status` column.
- **Guardrails** — Inline edit dialog for limit + level.
- **Experiments** — "Queue experiment" dialog, status transitions (queued → running → accepted/rejected).
- **Alerts** — Auto-created by other actions (trade closed, guardrail tripped); manual dismiss removes them.
- **Account/System state** — edited from Settings → Workspace (paper equity, floor, kill-switch toggle, mode selector).

**5. Real AI insights via Lovable AI**
- New `market-brief` edge function: takes recent candles + open trades + recent journals, returns a brief via `google/gemini-3-flash-preview`. Powers the Overview AIInsightPanel.
- New `journal-explain` edge function: takes a journal entry, returns the `llm_explanation` field. Triggered from the "Generate explanation" button.
- The existing `copilot-chat` function stays as-is.
- Both new functions handle 429/402 with toasts.

**6. Real-time updates**
`trades`, `alerts`, `account_state` get added to the realtime publication so the Overview page reacts instantly when a trade closes or an alert fires (handy when you eventually plug in a real bot).

### Pages that change

- `Overview` — live equity, live regime badge, live alerts, real AI brief
- `Trades` — real trade history, log/close dialogs, real open position
- `Journals` — real entries, new entry dialog, AI-explain button
- `StrategyLab` — real versions, new-version dialog, promote/archive buttons
- `RiskCenter` — real guardrails, edit dialog
- `MarketIntel` — live candles, live regime
- `Settings` → Workspace — adds "Account state" + "System controls" cards
- `Copilot` — unchanged (already live)
- `Learning` — reads from `experiments` table

`src/mocks/data.ts` gets deleted. `src/mocks/types.ts` stays as the shared TypeScript domain types (renamed to `src/lib/domain-types.ts`).

### Technical details

**Data layer:** A `src/hooks/` folder gets `useTrades`, `useJournals`, `useStrategies`, `useGuardrails`, `useExperiments`, `useAlerts`, `useAccountState`, `useSystemState`, `useCandles`. Each returns `{ data, loading, error, refetch }` and (for Supabase-backed ones) subscribes to realtime changes. React Query is not added — plain `useEffect` + supabase client to keep the bundle lean.

**Migrations:** One migration creates all 8 tables with RLS (`auth.uid() = user_id` for SELECT/INSERT/UPDATE/DELETE), an `update_updated_at_column` trigger on each, and an updated `handle_new_user` function that seeds the starter rows in a single transaction.

**Edge functions:**
- `market-brief` (verify_jwt = true): reads request user's recent trades/journals via service-role client, calls Lovable AI Gateway with a system prompt tuned for terse trader-style briefs.
- `journal-explain` (verify_jwt = true): same pattern, scoped to one entry id, writes the result back to `journal_entries.llm_explanation`.

**Coinbase candles:** fetched directly from the browser (no edge function needed — public CORS-enabled endpoint). Cached in component state, refreshed every 30s.

**Backwards-compat shim:** since types live in `src/mocks/types.ts` and many components import from there, I'll move them to `src/lib/domain-types.ts` and update the ~12 affected imports in one pass.

### What's NOT in this pass

- No real broker integration (no actual orders sent anywhere — paper-only by design, matches the existing UI gating).
- No bot telemetry (latency/uptime in the StatusFooter stays as a friendly placeholder showing "paper mode" instead of fake numbers).
- Email branding stays on Lovable defaults — I'll remind you when you add a custom domain.

