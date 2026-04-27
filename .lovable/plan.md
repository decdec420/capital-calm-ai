# Fix Copilot Layout in Fullscreen

## The problem
The Copilot page locks its three columns to `[180px _ 1fr _ 180px]` at the `lg` breakpoint (≥1024px). At any larger size (the fullscreen screenshot is ~1500px wide), the side columns stay at 180px and everything inside them gets squeezed:

- Left column: "Engine watchlist · 3 markets" header wraps to 3 lines; the BTC/ETH/SOL cards collapse to a vertical stack instead of using the 3-column grid they were designed for.
- "Last engine tick" header collides with its timestamp.
- Right column: "Autonomy" label overlaps "paper-only until live armed"; the Manual/Assisted/Autonomous segmented toggle is too narrow for its labels; the green/orange status banner wraps awkwardly.

The center chat panel is fine — the bug is purely in the side rails and how their contents flex.

## What I'll change

### 1. Copilot page grid (`src/pages/Copilot.tsx`)
Replace the rigid `lg:grid-cols-[180px_1fr_180px]` with a tiered, fluid layout:

- `< md` (≤768px): single column, stacked (already works).
- `md` (768–1279px): single column, but the chat keeps its tall height and the side panels sit above/below.
- `xl` (≥1280px): three columns at `[260px_1fr_280px]` — wide enough that the symbol cards, engine-tick row, autonomy toggle, and "What Max sees" panel all breathe.
- `2xl` (≥1536px): three columns at `[300px_1fr_320px]` — fullscreen on a 15"+ display.

This eliminates the squeeze while keeping the chat the dominant column.

### 2. MultiSymbolStrip (`src/components/trader/MultiSymbolStrip.tsx`)
- Header row uses `flex-wrap gap-2` so the title and "snapshot · Xm ago" don't collide when the column is narrow.
- Symbol grid drops the `md:grid-cols-3` (which only made sense in the old wide center layout) and uses `grid-cols-1` everywhere — three small cards stacked vertically reads cleanly in a side rail and the cards are no longer squished.

### 3. AutonomyToggle (`src/components/trader/AutonomyToggle.tsx`)
- Top row becomes `flex-wrap` so "Autonomy" and the "paper-only until live armed" / "LIVE — real money" tag stack on a new line when the column is narrow instead of overlapping.
- Segmented buttons: drop the inline `(paper)` / `(LIVE)` qualifier from the buttons themselves (it's already shown in the header) so each button just shows its label and never truncates.
- The "All clear signals execute automatically" callout: shorten to "Auto-executes within doctrine limits" so it never wraps to 3 lines.

### 4. "Last engine tick" panel (in Copilot.tsx)
Wrap the header `flex` with `flex-wrap gap-y-1` so the timestamp falls to a second line gracefully if the column is narrow, instead of wrapping the title.

### 5. "What Max sees" context panel (in Copilot.tsx)
Already uses `flex justify-between` per row — add `min-w-0` and `truncate` to the value cells so very long engine-pick text stays on one line, and keep the panel readable at the new 280–320px width.

## What I'm NOT changing
- The center chat panel — its `min(72vh, 760px)` height and overflow logic are correct.
- The Risk Center page — that one's fine in fullscreen, the screenshot only flagged Copilot.
- The signal bridge banner at the top — it spans full width and already responds well.
- The sidebar — it's controlled by the global `AppLayout` and isn't part of this bug.

## Verification
After the changes I'll spot-check the file structure and run the existing test suite (`bunx vitest run`) to make sure nothing breaks. Tests cover doctrine/risk/sizing logic, not layout, so they should all stay green.
