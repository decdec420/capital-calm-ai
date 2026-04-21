import { useMemo } from "react";
import { useSystemState } from "@/hooks/useSystemState";
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import { cn } from "@/lib/utils";
import type { Regime, SnapshotPerSymbol } from "@/lib/domain-types";

export const ENGINE_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"] as const;

interface MultiSymbolStripProps {
  className?: string;
  // Optional callback when a symbol row is clicked.
  onSelect?: (symbol: string) => void;
  selected?: string;
}

// Compact horizontal strip showing each tracked symbol's current regime,
// last price, and setup score — driven entirely by the engine's last
// persisted snapshot. No local recomputation.
export function MultiSymbolStrip({ className, onSelect, selected }: MultiSymbolStripProps) {
  const { data: system } = useSystemState();
  const snapshot = system?.lastEngineSnapshot ?? null;

  const rows = useMemo(() => {
    const perSymbol: SnapshotPerSymbol[] = snapshot?.perSymbol ?? [];
    // Sort: chosen first, then by setup score desc.
    const sorted = [...perSymbol].sort((a, b) => {
      if (a.chosen !== b.chosen) return a.chosen ? -1 : 1;
      return (b.setupScore ?? 0) - (a.setupScore ?? 0);
    });
    return sorted;
  }, [snapshot]);

  const ranAt = snapshot?.ranAt;
  const ranAgo = ranAt ? humanAgo(new Date(ranAt).getTime()) : null;

  return (
    <div className={cn("panel p-3", className)}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Engine watchlist · {rows.length || ENGINE_SYMBOLS.length} markets
        </div>
        <div className="text-[10px] text-muted-foreground">
          {ranAgo ? `engine snapshot · ${ranAgo}` : "no snapshot yet — run the engine"}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {ENGINE_SYMBOLS.map((s) => (
            <div
              key={s}
              className="rounded-md border border-dashed border-border bg-card/50 px-3 py-4 text-center"
            >
              <div className="text-sm font-medium text-foreground">{s}</div>
              <div className="text-[10px] text-muted-foreground mt-1">awaiting first tick…</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {rows.map((r) => {
            const isSelected = selected === r.symbol;
            const lockedOut = r.lockGate !== null;
            const regime = (r.regime as Regime) ?? "range";
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
                    : r.chosen
                      ? "border-status-safe/40 bg-status-safe/5"
                      : lockedOut
                        ? "border-status-blocked/30 bg-status-blocked/5"
                        : "border-border bg-card",
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-foreground">{r.symbol}</span>
                  {r.chosen && (
                    <span className="text-[9px] uppercase tracking-wider font-semibold text-status-safe">
                      chosen
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-muted-foreground tabular">
                    ${(r.lastPrice ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                  <RegimeBadge regime={regime} />
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex-1 h-1 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={cn(
                        "h-full transition-all",
                        r.setupScore >= 0.65
                          ? "bg-status-safe"
                          : r.setupScore >= 0.5
                            ? "bg-status-caution"
                            : "bg-muted-foreground/40",
                      )}
                      style={{ width: `${Math.min(100, (r.setupScore ?? 0) * 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground tabular w-7 text-right">
                    {(r.setupScore ?? 0).toFixed(2)}
                  </span>
                </div>
                {r.lockGate && (
                  <div className="mt-1.5 text-[10px] text-status-blocked/90 truncate" title={r.lockGate.message}>
                    {r.lockGate.code.replace(/_/g, " ").toLowerCase()}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function humanAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
