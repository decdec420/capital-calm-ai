
# Trader OS — Personal AI Trading Operating System

A serious, calm, mission-control dashboard for disciplined crypto trading. Dark "warm amber / graphite" aesthetic. Full 9-section IA with realistic mock data and a working LLM Copilot via Lovable AI.

## Design system

- **Palette**: near-black graphite background (`#0B0A09` / deep warm neutrals), elevated panels in soft warm charcoal, hairline borders, muted text hierarchy
- **Accent**: warm amber (`hsl(38 92% 55%)`) reserved for primary actions and active states only
- **Status semantics**: muted emerald (safe), amber (caution), restrained crimson (blocked), steel blue (candidate), violet (live-disabled)
- **Typography**: clean sans hierarchy, generous spacing, tight letter spacing on metrics, tabular numerals for PnL
- **Surface**: subtle inner glow + 1px hairline borders, no glassy blur excess, no neon
- **Vibe**: Bloomberg-meets-Linear — quiet, decisive, high information density without clutter

## App shell

- **Left sidebar** (collapsible to icon strip, persistent): Overview · Market Intel · Trades · Journals · Strategy Lab · Risk Center · Learning · AI Copilot · Settings
- **Top bar** (always visible): system mode badge (RESEARCH / PAPER / LEARNING / LIVE), bot status dot, broker connection chip, kill-switch indicator, global alert bell, profile slot
- **Footer status strip**: latency, data feed health, last tick timestamp

## Pages

### 1. Overview (Mission Control)
Hero strip with current mode, regime, and risk posture. Grid of metric cards: account equity, daily PnL, today's trade count vs cap, daily loss vs cap, balance floor distance, current strategy version + candidate. Latest LLM brief panel, recent alerts feed, quick-action panel (pause bot, force flat, request brief). Kill-switch status panel prominently visible.

### 2. Market Intelligence
BTC candlestick area (mock OHLC) with MA overlays and signal markers. Regime badge + confidence score, volatility state, spread quality, time-of-day score, no-trade reason chips. LLM market summary card. Research observation feed.

### 3. Trades / Lifecycle
Open position card with entry/SL/TP/unrealized PnL/time-in-trade. Lifecycle timeline (candidate → entered → monitored → exited → archived). Past trades table with sort/filter by reason tag and outcome. Trade detail drawer with full event history and LLM postmortem.

### 4. Journals
Tabbed view: Research · Trades · Learning · Skips · Daily Summaries · Postmortems. Filterable timeline of structured event cards, raw/structured toggle, LLM explanation panel per entry.

### 5. Strategy Lab
Version cards (approved / candidate / archived) with parameter diff. Side-by-side comparison view. Key metrics (expectancy, win rate, max drawdown, Sharpe). Promotion workflow with explicit approve / reject / send-back-to-paper actions, all gated visually.

### 6. Risk Control Center
Grid of every guardrail with live status: max order size, daily loss cap, daily trade cap, spread filter, stale-data filter, position limit, balance floor, kill-switches. Live trading gating panel showing what's blocking promotion to live. Designed to feel serious and trustworthy.

### 7. Learning / Optimization
Learning mode status, experiment queue, recent parameter changes, accepted/rejected experiments. Charts for expectancy, drawdown, win rate over experiments. Strategy comparison. LLM-generated weekly insight summary card.

### 8. AI Copilot (real LLM)
Dedicated chat interface styled as an operator console — not a generic chatbot. Suggested operator prompts ("Why did the bot skip the last trade?", "Summarize today's conditions", "Should this candidate be promoted?"). Streaming responses with markdown. Backend edge function uses Lovable AI Gateway (`google/gemini-3-flash-preview`) with a system prompt that injects current mock system context (mode, regime, open position, recent skips, candidate strategy) so answers feel grounded in the OS state.

### 9. Settings / Integrations
Broker connection state (Paper / Robinhood shell), mode controls with live-mode safety confirmation flow, data source status, runtime config viewer (read-only), feature flags, LLM provider settings, API status, logging settings.

## Reusable components

StatusBadge · RegimeBadge · RiskBadge · MetricCard · PnLCard · AlertBanner · JournalEventCard · ReasonChip · StrategyVersionCard · CandidateComparisonTable · TradeLifecycleTimeline · AIInsightPanel · ActionPanel · KillSwitchPanel · GuardrailRow · SectionHeader · EmptyState

## Mock data layer

Realistic, typed mock data structured to mirror a future TS bot backend: `systemState`, `marketRegime`, `openPosition`, `tradeHistory`, `journalEntries`, `experiments`, `strategies` (with versions + params), `riskConfig`, `alerts`, `aiInsights`. Organized in `src/mocks/` so swapping to real APIs later is a one-file change per domain.

## Backend

- Lovable Cloud enabled
- One edge function: `copilot-chat` — streams from Lovable AI Gateway, injects system context, handles 429/402 with friendly toasts

## Out of scope for v1
Real broker connectivity, real market data, persistence of journals/trades, auth (single-user private app — no login screen needed in v1).
