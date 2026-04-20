import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { TradeLifecycleTimeline } from "@/components/trader/TradeLifecycleTimeline";
import { ReasonChip } from "@/components/trader/ReasonChip";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { closedTrades, openPosition } from "@/mocks/data";
import type { ClosedTrade } from "@/mocks/types";
import { Button } from "@/components/ui/button";

export default function Trades() {
  const [selected, setSelected] = useState<ClosedTrade | null>(null);

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader eyebrow="Lifecycle" title="Trades" description="Open position, full lifecycle, and history." />

      {openPosition && (
        <div className="panel p-5 space-y-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Open position</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-lg font-semibold text-foreground">{openPosition.symbol}</span>
                <StatusBadge tone={openPosition.side === "long" ? "safe" : "caution"} size="sm">
                  {openPosition.side}
                </StatusBadge>
                <span className="text-xs text-muted-foreground">{openPosition.strategyVersion}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm">Move stop</Button>
              <Button variant="outline" size="sm">Close 50%</Button>
              <Button size="sm" variant="destructive">Force flat</Button>
            </div>
          </div>

          <TradeLifecycleTimeline current="monitored" />

          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 pt-4 border-t border-border">
            <Cell label="Size" value={`${openPosition.size.toFixed(4)} BTC`} />
            <Cell label="Entry" value={`$${openPosition.entryPrice.toFixed(2)}`} />
            <Cell label="Current" value={`$${openPosition.currentPrice.toFixed(2)}`} />
            <Cell label="Stop" value={`$${openPosition.stopLoss.toFixed(2)}`} tone="blocked" />
            <Cell label="Take profit" value={`$${openPosition.takeProfit.toFixed(2)}`} tone="safe" />
            <Cell
              label="Unrealized"
              value={`${openPosition.unrealizedPnl >= 0 ? "+" : ""}$${openPosition.unrealizedPnl.toFixed(2)}`}
              tone={openPosition.unrealizedPnl >= 0 ? "safe" : "blocked"}
            />
          </div>
        </div>
      )}

      <div className="panel">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Trade history</span>
          <span className="text-xs text-muted-foreground tabular">{closedTrades.length} trades</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border">
              <TableHead className="text-[10px] uppercase tracking-wider">Time</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Side</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Entry</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Exit</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">PnL</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Outcome</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Reasons</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Strategy</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {closedTrades.map((t) => (
              <TableRow key={t.id} onClick={() => setSelected(t)} className="cursor-pointer border-border">
                <TableCell className="text-xs text-muted-foreground tabular">
                  {new Date(t.closedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </TableCell>
                <TableCell>
                  <StatusBadge tone={t.side === "long" ? "safe" : "caution"} size="sm">
                    {t.side}
                  </StatusBadge>
                </TableCell>
                <TableCell className="tabular text-sm">${t.entryPrice.toFixed(2)}</TableCell>
                <TableCell className="tabular text-sm">${t.exitPrice.toFixed(2)}</TableCell>
                <TableCell className={`tabular text-sm font-medium ${t.pnl > 0 ? "text-status-safe" : t.pnl < 0 ? "text-status-blocked" : "text-muted-foreground"}`}>
                  {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)} ({t.pnlPct.toFixed(2)}%)
                </TableCell>
                <TableCell>
                  <StatusBadge
                    tone={t.outcome === "win" ? "safe" : t.outcome === "loss" ? "blocked" : "neutral"}
                    size="sm"
                  >
                    {t.outcome}
                  </StatusBadge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {t.reasonTags.map((r) => (
                      <ReasonChip key={r} label={r} />
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{t.strategyVersion}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="bg-card border-border w-full sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  Trade {selected.id}
                  <StatusBadge tone={selected.outcome === "win" ? "safe" : selected.outcome === "loss" ? "blocked" : "neutral"} size="sm">
                    {selected.outcome}
                  </StatusBadge>
                </SheetTitle>
                <SheetDescription>{selected.strategyVersion}</SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-4">
                <TradeLifecycleTimeline current="archived" />
                <div className="grid grid-cols-2 gap-3">
                  <Cell label="Side" value={selected.side.toUpperCase()} />
                  <Cell label="Size" value={`${selected.size.toFixed(4)} BTC`} />
                  <Cell label="Entry" value={`$${selected.entryPrice.toFixed(2)}`} />
                  <Cell label="Exit" value={`$${selected.exitPrice.toFixed(2)}`} />
                  <Cell label="PnL" value={`${selected.pnl >= 0 ? "+" : ""}$${selected.pnl.toFixed(2)}`} tone={selected.pnl >= 0 ? "safe" : "blocked"} />
                  <Cell label="PnL %" value={`${selected.pnlPct.toFixed(2)}%`} />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Reason tags</div>
                  <div className="flex flex-wrap gap-1.5">
                    {selected.reasonTags.map((r) => (
                      <ReasonChip key={r} label={r} />
                    ))}
                  </div>
                </div>
                <div className="rounded-md bg-secondary/50 border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wider text-primary/80 mb-1">Copilot postmortem</div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {selected.outcome === "win"
                      ? "Setup behaved as expected. Entry timing aligned with momentum confirmation. Hold thesis remained valid through TP1."
                      : selected.outcome === "loss"
                        ? "Entry triggered on a marginal setup score. Market reversed within the first 4 candles. Consider tightening the score threshold."
                        : "Trade exited at breakeven after stop trail crossed entry. No edge captured but no capital lost."}
                  </p>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Cell({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "safe" | "blocked" }) {
  const color = tone === "safe" ? "text-status-safe" : tone === "blocked" ? "text-status-blocked" : "text-foreground";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm tabular ${color}`}>{value}</div>
    </div>
  );
}
