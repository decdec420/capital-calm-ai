import { useMemo } from "react";
import { useMultiCandles } from "@/hooks/useMultiCandles";
import { computeRegime } from "@/lib/regime";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { cn } from "@/lib/utils";

export const ENGINE_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;

interface MultiSymbolStripProps {
  className?: string;
  // Optional callback when a symbol row is clicked.
  onSelect?: (symbol: string) => void;
  selected?: string;
}

// Compact horizontal strip showing each tracked symbol's current regime,
// last price, and setup score. This is the operator's "scope view" — at
// a glance you see which market the engine is most likely to act on next.
export function MultiSymbolStrip({ className, onSelect, selected }: MultiSymbolStripProps) {
  const { data, loading } = useMultiCandles(ENGINE_SYMBOLS as unknown as string[]);

  const rows = useMemo(() => {
    return ENGINE_SYMBOLS.map((symbol) => {
      const candles = data[symbol] ?? [];
      const regime = computeRegime(symbol, candles);
      const last = candles[candles.length - 1]?.c ?? 0;
      const first = candles[0]?.c ?? last;
      const change = first > 0 ? ((last - first) / first) * 100 : 0;
      return { symbol, regime, last, change, count: candles.length };
    }).sort((a, b) => b.regime.setupScore - a.regime.setupScore);
  }, [data]);

  return (
    <div className={cn("panel p-3", className)}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Engine watchlist · {ENGINE_SYMBOLS.length} markets
        </div>
        <div className="text-[10px] text-muted-foreground">
          Sorted by setup score · {loading ? "loading…" : "live"}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {rows.map((r) => {
          const isSelected = selected === r.symbol;
          const isTopPick = rows[0]?.symbol === r.symbol && r.regime.setupScore >= 0.5;
          return (
            <button
              key={r.symbol}
              type="button"
              onClick={() => onSelect?.(r.symbol)}
              className={cn(
                "text-left rounded-md border px-3 py-2.5 transition-colors",
                "hover:border-primary/40 hover:bg-accent/50",
                isSelected
                  ? "border-primary/50 bg-primary/5"
                  : isTopPick
                    ? "border-status-safe/40 bg-status-safe/5"
                    : "border-border bg-card",
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-foreground">{r.symbol}</span>
                <span
                  className={cn(
                    "text-xs tabular",
                    r.change >= 0 ? "text-status-safe" : "text-status-blocked",
                  )}
                >
                  {r.change >= 0 ? "+" : ""}
                  {r.change.toFixed(2)}%
                </span>
              </div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-muted-foreground tabular">
                  ${r.last.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                <RegimeBadge regime={r.regime.regime} />
              </div>
              <div className="flex items-center gap-1.5">
                <div className="flex-1 h-1 rounded-full bg-secondary overflow-hidden">
                  <div
                    className={cn(
                      "h-full transition-all",
                      r.regime.setupScore >= 0.65
                        ? "bg-status-safe"
                        : r.regime.setupScore >= 0.5
                          ? "bg-status-caution"
                          : "bg-muted-foreground/40",
                    )}
                    style={{ width: `${Math.min(100, r.regime.setupScore * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground tabular w-7 text-right">
                  {r.regime.setupScore.toFixed(2)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
