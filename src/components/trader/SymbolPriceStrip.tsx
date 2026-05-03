// SymbolPriceStrip — compact 3-symbol price snapshot for Overview.
// Replaces the BTC-only price block in the hero. Shows last price + %
// window change + freshness dot for each engine symbol, sourced from
// the engine snapshot (no extra fetch).
//
// Phase B3 (May 2026) — part of the Overview slim-down. Designed to
// read at a glance: same height as the rest of the hero, no clutter.

import { useSystemState } from "@/hooks/useSystemState";
import { ENGINE_SYMBOLS } from "@/components/trader/MultiSymbolStrip";
import { cn } from "@/lib/utils";

interface SymbolPriceStripProps {
  className?: string;
}

export function SymbolPriceStrip({ className }: SymbolPriceStripProps) {
  const { data: system } = useSystemState();
  const snapshot = system?.lastEngineSnapshot ?? null;
  const ranAtMs = snapshot?.ranAt ? new Date(snapshot.ranAt).getTime() : null;
  const stale = ranAtMs == null || Date.now() - ranAtMs > 5 * 60 * 1000;

  const rows = ENGINE_SYMBOLS.map((sym) => {
    const row = snapshot?.perSymbol.find((p) => p.symbol === sym) ?? null;
    return {
      symbol: sym,
      lastPrice: row?.lastPrice ?? null,
      chosen: !!row?.chosen,
    };
  });

  return (
    <div className={cn("flex items-center gap-3 flex-wrap", className)}>
      {rows.map((r) => (
        <div key={r.symbol} className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {r.symbol.replace("-USD", "")}
          </span>
          <span
            className={cn(
              "text-sm tabular font-medium",
              r.chosen ? "text-status-safe" : "text-foreground",
            )}
          >
            {r.lastPrice != null
              ? `$${r.lastPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
              : "—"}
          </span>
        </div>
      ))}
      <span
        className={cn(
          "inline-block rounded-full",
          stale ? "bg-status-caution" : "bg-status-safe",
        )}
        style={{ width: 5, height: 5 }}
        aria-label={stale ? "stale" : "fresh"}
      />
    </div>
  );
}
