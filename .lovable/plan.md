

## UX audit — glaring issues & where to fix them

I went through Overview, Trades, Risk Center, Market Intel, Journals, the TopBar and the sidebar with a designer's eye. Here's the honest list, ranked by how loud the smell is.

### Top offenders (the ones you actually feel)

**1. Metric cards on Overview are dead-ends.** Equity, Daily PnL, Trades today, Loss vs cap, Floor distance, Live mode — every one of these begs for a click. Today they do nothing. You stare at "+$142.10" and there's no way to ask "from what?". This is the #1 thing dragging the product backwards.

**2. The "Open position" card on Overview duplicates Trades and isn't clickable.** It says "Open trade →" in tiny text in the corner. The whole card should be the link, or better, expand inline.

**3. TopBar status chips are read-only labels for things that have full pages behind them.** "bot running", "kill-switch", broker connection — these should be entry points, not stickers.

**4. Pending signal banner is the only thing on the page that links well.** Use it as the pattern for everything else.

**5. Recent alerts** dismiss on hover-X only, no "view all" link, no severity filter. Alerts that matter (blocked / critical) look the same as info.

**6. Risk Center has three summary tiles** (Overall posture / Blocked / Caution) that aren't filters. Click "Blocked: 2" → should filter the grid to those two. Right now nothing happens.

**7. Market Intel is an island.** "TOD score 72%" and "Setup score 0.41" — no way to jump to the journal entry, signal, or setting that produced the threshold.

**8. Sidebar Settings** is now alone at the bottom but visually weak — no avatar/email next to it. Settings + sign-out + theme toggle is a typical "user shelf"; right now sign-out lives in the TopBar avatar dropdown and Settings is in the sidebar. Pick one home.

### What I'd actually build (in order)

#### A. Make the Overview metrics clickable — the big win
Each `MetricCard` becomes optionally interactive, opening a right-side `Sheet` (matching the Trade detail pattern already in `Trades.tsx`) with a real breakdown.

| Card | Click reveals |
|---|---|
| Equity | Sparkline of equity over last 30 days, cash vs open positions split, link to Trades |
| Daily PnL | Realized vs unrealized split, list of today's closed trades w/ PnL, biggest winner/loser |
| Trades today | Mini list of today's trades (open + closed), link to Trades page |
| Loss vs cap | Burn-down bar, today's losing trades, link to Risk Center loss-cap guardrail |
| Floor distance | Equity vs floor visualisation, link to Risk Center |
| Live mode | Direct link to Settings → Mode controls + a one-line "what would change" |

Add a subtle affordance (cursor + tiny `↗` icon on hover) so it's discoverable without being noisy.

#### B. Wire up Overview's "Open position" panel
Whole card becomes a link to `/trades`. Drop the "Open trade →" pill. Add a "Close at market" button inline so the most common action lives where the eye already is.

#### C. TopBar chips become entry points
- `bot running/halted` chip → links to Risk Center (where the kill-switch lives)
- broker connection → links to Settings → Connections
- `kill-switch` chip (when engaged) → links to Risk Center, scrolled to kill-switch section

These get a hover state (`hover:bg-accent`) so they read as buttons.

#### D. Risk Center summary tiles become filters
Click "Blocked: 2" → grid filters to blocked guardrails, tile gets a selected state, a small "Clear filter" pill appears. Same for Caution and Overall.

#### E. Recent alerts panel upgrades
- Whole row clickable → opens a side-sheet with full message, timestamp, source, and (where available) a deep-link (e.g. "guardrail tripped" → Risk Center, "trade closed" → that trade)
- Header gets a small severity dot summary: `2 critical · 1 warning`
- "View all" link at the bottom going to a dedicated alerts feed (or Journals filtered by `kind=alert` if we don't want a new page)

#### F. Market Intel cross-links
- "No-trade reasons" chips become links to the relevant Risk Center guardrail or Settings threshold
- Regime card gets a "View past regime journal entries →" link
- Research/skip entries on this page already use `JournalEventCard` — make titles clickable to the Journals page filtered to that entry

#### G. Sidebar bottom: real user shelf
Replace the lone Settings link with a small block:
```text
┌──────────────────────────┐
│ [AB]  Alex Brown      ⚙  │  ← avatar + name + settings cog
│       alex@acme.com      │
└──────────────────────────┘
```
Click anywhere → opens a popover with: Settings, Theme, Sign out. Removes the duplication between TopBar avatar dropdown and sidebar Settings. Collapsed sidebar shows just the avatar.

### Out of scope for this round (call out, don't build yet)
- A proper "Equity over time" chart needs historical snapshots we may not be storing — sparkline can use whatever we have, real chart is a follow-up
- Command palette (Cmd+K) — natural next step after this, but separate
- Mobile bottom-nav — Overview is desktop-first today and this audit kept it that way

### Technical notes
- Reuse the existing `Sheet` component from `src/components/ui/sheet.tsx` (already used in Trades) for all the metric drilldowns — keeps the visual language consistent
- Extend `MetricCard` with an optional `onClick` + `href` prop; render a button/Link wrapper only when one is supplied so non-interactive cards stay non-interactive
- For TopBar chips, wrap `StatusBadge` in `<Link>` and add `hover:opacity-80 transition-opacity` — no new component needed
- Risk Center filter state lives in the page component; tiles toggle a `filter: 'all' | 'blocked' | 'caution'` local state

### Suggested execution order (one PR each, low risk)
1. MetricCard becomes clickable + Equity & Daily PnL drilldown sheets (highest impact, biggest "ahh")
2. TopBar chips → links + Open position card → link
3. Recent alerts → clickable rows + view-all
4. Risk Center summary tiles → filters
5. Sidebar user shelf
6. Market Intel cross-links
7. Remaining metric drilldowns (Trades today, Loss vs cap, Floor distance, Live mode)

Ship in that order and the product feels markedly more "alive" after step 1 alone.

