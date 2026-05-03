// Compact multi-symbol price strip for the Overview hero.
// Shows last price, regime, confidence and freshness for every
// whitelisted symbol the engine has snapshotted.
import { RegimeBadge } from "@/components/trader/RegimeBadge";
import type { SnapshotPerSymbol, Regime } from "@/lib/domain-types";
import { useRelativeTime, isStale } from "@/hooks/useRelativeTime";

interface Props {
  perSymbol: SnapshotPerSymbol[];
  ranAt: string | null;
}

export function SymbolStrip({ perSymbol, ranAt }: Props) {
  const ts = ranAt ? new Date(ranAt).getTime() : null;
  const label = useRelativeTime(ts);
  const stale = isStale(ts, 5 * 60 * 1000); // 5min stale threshold

  if (!perSymbol.length) {
    return (
      <div className="panel p-4 text-xs text-muted-foreground">
        Engine hasn't ticked yet — prices appear after the first scan.
      </div>
    );
  }

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Tracked symbols
        </span>
        <span
          className={`inline-flex items-center gap-1 font-mono text-[10px] ${
            stale ? "text-status-caution" : "text-muted-foreground"
          }`}
        >
          <span
            className={`inline-block rounded-full ${stale ? "bg-status-caution" : "bg-muted-foreground"}`}
            style={{ width: 5, height: 5 }}
          />
          tick {label}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {perSymbol.map((s) => (
          <SymbolCell key={s.symbol} snap={s} />
        ))}
      </div>
    </div>
  );
}

function SymbolCell({ snap }: { snap: SnapshotPerSymbol }) {
  const regime = (snap.regime === "unknown" ? "ranging" : snap.regime) as Regime;
  const price = snap.lastPrice;
  return (
    <div
      className={`rounded-md border px-3 py-2.5 transition-colors ${
        snap.chosen ? "border-primary/40 bg-primary/5" : "border-border/60 bg-card/40"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-foreground tabular">{snap.symbol}</span>
        {snap.chosen && (
          <span className="text-[9px] uppercase tracking-wider text-primary font-semibold">
            chosen
          </span>
        )}
      </div>
      <div className="text-base tabular text-foreground mb-1">
        ${price > 0 ? price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
      </div>
      <div className="flex items-center justify-between gap-2">
        <RegimeBadge regime={regime} confidence={snap.confidence} />
        <span className="text-[10px] text-muted-foreground tabular">
          setup {(snap.setupScore * 100).toFixed(0)}
        </span>
      </div>
    </div>
  );
}
