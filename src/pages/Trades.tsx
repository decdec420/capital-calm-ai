import { useMemo, useState, type ReactNode } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { TradeLifecycleTimeline } from "@/components/trader/TradeLifecycleTimeline";
import { ReasonChip } from "@/components/trader/ReasonChip";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { DirectionBasisChip } from "@/components/trader/DirectionBasisChip";
import { EmptyState } from "@/components/trader/EmptyState";
import { TagInput } from "@/components/trader/TagInput";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { NumberStepper } from "@/components/trader/NumberStepper";
import { useTrades, type NewTradeInput } from "@/hooks/useTrades";
import { useStrategies } from "@/hooks/useStrategies";
import { useCandles } from "@/hooks/useCandles";
import { useSystemState } from "@/hooks/useSystemState";
import { BrokerStatusInline } from "@/components/trader/BrokerStatusInline";
import { Plus, TrendingUp, X } from "lucide-react";
import type { Trade, TradeSide } from "@/lib/domain-types";
import { formatBaseQty, formatUsd } from "@/lib/utils";
import { toast } from "sonner";

export default function Trades() {
  const { open, closed, create, close, remove, loading } = useTrades();
  const { strategies } = useStrategies();
  const { candles } = useCandles();
  const { data: system } = useSystemState();
  const [selected, setSelected] = useState<Trade | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [closeFor, setCloseFor] = useState<Trade | null>(null);
  

  const lastPrice = candles[candles.length - 1]?.c ?? 0;
  const openPosition = open[0];

  const livePnL = useMemo(() => {
    if (!openPosition || !lastPrice) return { pnl: 0, pct: 0 };
    const sideMult = openPosition.side === "long" ? 1 : -1;
    const pnl = (lastPrice - openPosition.entryPrice) * openPosition.size * sideMult;
    const pct = ((lastPrice - openPosition.entryPrice) / openPosition.entryPrice) * 100 * sideMult;
    return { pnl, pct };
  }, [openPosition, lastPrice]);

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Lifecycle"
        title="Trades"
        description="Open position, full lifecycle, and history."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setLogOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Log trade
          </Button>
        }
      />

      {system && (
        <BrokerStatusInline
          connection={system.brokerConnection}
          liveArmed={system.liveTradingEnabled}
        />
      )}

      {openPosition ? (
        <div className="panel p-5 space-y-5">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Open position</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-lg font-semibold text-foreground">{openPosition.symbol}</span>
                <StatusBadge tone={openPosition.side === "long" ? "safe" : "caution"} size="sm">
                  {openPosition.side}
                </StatusBadge>
                <span className="text-xs text-muted-foreground">{openPosition.strategyVersion || "—"}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setCloseFor(openPosition)}>Close at market</Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" variant="destructive">Discard</Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="bg-card border-border">
                  <AlertDialogHeader>
                    <AlertDialogTitle>Discard this trade?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes the position record. No broker order is sent — this only deletes it from your log. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div className="text-sm text-status-caution border border-status-caution/30 bg-status-caution/10 rounded-md p-3">
                    Make sure you have already closed this position on the exchange if it was a live trade.
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={async () => {
                        try {
                          await remove(openPosition.id);
                          toast.success("Trade discarded.");
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : "Couldn't discard trade");
                        }
                      }}
                    >
                      Yes, discard position
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>

          <TradeLifecycleTimeline
            current={openPosition.lifecyclePhase}
            transitions={openPosition.lifecycleTransitions}
          />


          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 pt-4 border-t border-border">
            <Cell
              label="Size"
              value={`${formatBaseQty(openPosition.size)} · ${formatUsd(openPosition.size * (lastPrice || openPosition.entryPrice))}`}
            />
            <Cell label="Entry" value={`$${openPosition.entryPrice.toFixed(2)}`} />
            <Cell label="Last" value={lastPrice ? `$${lastPrice.toFixed(2)}` : "—"} />
            <Cell label="Stop" value={openPosition.stopLoss !== null ? `$${openPosition.stopLoss.toFixed(2)}` : "—"} tone="blocked" />
            <Cell label="Take profit" value={openPosition.takeProfit !== null ? `$${openPosition.takeProfit.toFixed(2)}` : "—"} tone="safe" />
            <Cell
              label="Unrealized"
              value={`${livePnL.pnl >= 0 ? "+" : ""}$${livePnL.pnl.toFixed(2)} (${livePnL.pct.toFixed(2)}%)`}
              tone={livePnL.pnl >= 0 ? "safe" : "blocked"}
            />
          </div>
        </div>
      ) : (
        !loading && (
          <EmptyState
            icon={<TrendingUp className="h-5 w-5" />}
            title="No open position"
            description="Quiet hands beat hot hands. Log a trade when there's an actual edge."
            action={<Button size="sm" onClick={() => setLogOpen(true)}>Log a trade</Button>}
          />
        )
      )}

      <div className="panel">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Trade history</span>
          <span className="text-xs text-muted-foreground tabular">{closed.length} trades</span>
        </div>
        {closed.length === 0 ? (
          <div className="p-6">
            <p className="text-sm text-muted-foreground italic text-center">
              No closed trades yet. The history will fill itself in once you start firing.
            </p>
          </div>
        ) : (
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
              {closed.map((t) => (
                <TableRow key={t.id} onClick={() => setSelected(t)} className="cursor-pointer border-border">
                  <TableCell className="text-xs text-muted-foreground tabular">
                    {t.closedAt && new Date(t.closedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <StatusBadge tone={t.side === "long" ? "safe" : "caution"} size="sm">
                        {t.side}
                      </StatusBadge>
                      <DirectionBasisChip basis={t.directionBasis} />
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-sm">${t.entryPrice.toFixed(2)}</TableCell>
                  <TableCell className="tabular text-sm">{t.exitPrice !== null ? `$${t.exitPrice.toFixed(2)}` : "—"}</TableCell>
                  <TableCell className={`tabular text-sm font-medium ${(t.pnl ?? 0) > 0 ? "text-status-safe" : (t.pnl ?? 0) < 0 ? "text-status-blocked" : "text-muted-foreground"}`}>
                    {(t.pnl ?? 0) >= 0 ? "+" : ""}${(t.pnl ?? 0).toFixed(2)} ({(t.pnlPct ?? 0).toFixed(2)}%)
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
        )}
      </div>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="bg-card border-border w-full sm:max-w-lg overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  Trade #{selected.id.slice(0, 6)}
                  <StatusBadge tone={selected.outcome === "win" ? "safe" : selected.outcome === "loss" ? "blocked" : "neutral"} size="sm">
                    {selected.outcome}
                  </StatusBadge>
                </SheetTitle>
                <SheetDescription>{selected.strategyVersion || "no strategy tagged"}</SheetDescription>
              </SheetHeader>
              <div className="mt-6 space-y-4">
                <TradeLifecycleTimeline
                  current={selected.lifecyclePhase}
                  transitions={selected.lifecycleTransitions}
                />

                <div className="grid grid-cols-2 gap-3">
                  <Cell
                    label="Side"
                    value={selected.side.toUpperCase()}
                    extra={<DirectionBasisChip basis={selected.directionBasis} />}
                  />
                  <Cell
                    label="Size"
                    value={`${formatBaseQty(selected.size)} · ${formatUsd(selected.size * (selected.exitPrice ?? selected.entryPrice))}`}
                  />
                  <Cell label="Entry" value={`$${selected.entryPrice.toFixed(2)}`} />
                  <Cell label="Exit" value={selected.exitPrice !== null ? `$${selected.exitPrice.toFixed(2)}` : "—"} />
                  <Cell label="PnL" value={`${(selected.pnl ?? 0) >= 0 ? "+" : ""}$${(selected.pnl ?? 0).toFixed(2)}`} tone={(selected.pnl ?? 0) >= 0 ? "safe" : "blocked"} />
                  <Cell label="PnL %" value={`${(selected.pnlPct ?? 0).toFixed(2)}%`} />
                </div>
                {selected.reasonTags.length > 0 && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Reason tags</div>
                    <div className="flex flex-wrap gap-1.5">
                      {selected.reasonTags.map((r) => (
                        <ReasonChip key={r} label={r} />
                      ))}
                    </div>
                  </div>
                )}
                {selected.notes && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Notes</div>
                    <p className="text-sm text-foreground">{selected.notes}</p>
                  </div>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-status-blocked border-status-blocked/30 hover:bg-status-blocked/10 hover:text-status-blocked"
                  onClick={async () => {
                    await remove(selected.id);
                    toast.success("Trade deleted.");
                    setSelected(null);
                  }}
                >
                  Delete trade
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <LogTradeDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        defaultPrice={lastPrice}
        strategies={strategies.map((s) => `${s.name} ${s.version}`)}
        onSubmit={async (input) => {
          try {
            await create(input);
            toast.success("Trade logged. Stay disciplined.");
            setLogOpen(false);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't log trade");
          }
        }}
      />

      <CloseTradeDialog
        trade={closeFor}
        defaultPrice={lastPrice}
        onClose={() => setCloseFor(null)}
        onSubmit={async (id, input) => {
          try {
            await close(id, input);
            toast.success("Trade closed. Logged automatically.");
            setCloseFor(null);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't close trade");
          }
        }}
      />

    </div>
  );
}

function Cell({ label, value, tone = "default", extra }: { label: string; value: string; tone?: "default" | "safe" | "blocked"; extra?: ReactNode }) {
  const color = tone === "safe" ? "text-status-safe" : tone === "blocked" ? "text-status-blocked" : "text-foreground";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm tabular ${color} flex items-center gap-1.5 flex-wrap`}>
        <span>{value}</span>
        {extra}
      </div>
    </div>
  );
}

function LogTradeDialog({
  open,
  onOpenChange,
  defaultPrice,
  strategies,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultPrice: number;
  strategies: string[];
  onSubmit: (input: NewTradeInput) => void;
}) {
  const [symbol, setSymbol] = useState("BTC-USD");
  const [side, setSide] = useState<TradeSide>("long");
  const [size, setSize] = useState("0.01");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [tp, setTp] = useState("");
  const [strategy, setStrategy] = useState<string>(strategies[0] ?? "trend-rev v1.3");
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState("");

  const handleOpen = (o: boolean) => {
    if (o && !entry && defaultPrice) setEntry(defaultPrice.toFixed(2));
    onOpenChange(o);
  };

  const submit = () => {
    if (!entry || !size) return toast.error("Entry and size required.");
    onSubmit({
      symbol,
      side,
      size: Number(size),
      entryPrice: Number(entry),
      stopLoss: stop ? Number(stop) : null,
      takeProfit: tp ? Number(tp) : null,
      strategyVersion: strategy,
      reasonTags: tags,
      notes: notes || null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle>Log a trade</DialogTitle>
          <DialogDescription>Paper trade only. No orders are sent anywhere.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Symbol"><Input value={symbol} onChange={(e) => setSymbol(e.target.value)} /></Field>
            <Field label="Side">
              <Select value={side} onValueChange={(v) => setSide(v as TradeSide)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="long">Long</SelectItem>
                  <SelectItem value="short">Short</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Size"><NumberStepper value={size} onChange={setSize} step={0.001} shiftMultiplier={10} min={0} precision={4} /></Field>
            <Field label="Entry"><NumberStepper value={entry} onChange={setEntry} step={1} shiftMultiplier={10} min={0} precision={2} prefix="$" /></Field>
            <Field label="Stop loss"><NumberStepper value={stop} onChange={setStop} step={1} shiftMultiplier={10} min={0} precision={2} prefix="$" placeholder="optional" /></Field>
            <Field label="Take profit"><NumberStepper value={tp} onChange={setTp} step={1} shiftMultiplier={10} min={0} precision={2} prefix="$" placeholder="optional" /></Field>
          </div>
          <Field label="Strategy">
            <Select value={strategy} onValueChange={setStrategy}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {strategies.length === 0 && <SelectItem value="—">none</SelectItem>}
                {strategies.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Reason tags"><TagInput value={tags} onChange={setTags} placeholder="e.g. trend-confirm, tod-good" /></Field>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional thesis" rows={2} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit}>Log trade</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CloseTradeDialog({
  trade,
  defaultPrice,
  onClose,
  onSubmit,
}: {
  trade: Trade | null;
  defaultPrice: number;
  onClose: () => void;
  onSubmit: (id: string, input: { reason: string }) => void;
}) {
  const [reason, setReason] = useState("");

  // Reset on open
  useMemo(() => {
    if (trade) {
      setReason("");
    }
  }, [trade]);

  return (
    <Dialog open={!!trade} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle>Close trade</DialogTitle>
          <DialogDescription>
            {trade ? `${trade.side.toUpperCase()} ${trade.symbol} @ $${trade.entryPrice.toFixed(2)}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
            Exit price is fetched live from Coinbase spot (~${defaultPrice.toFixed(2)}) when you confirm.
            The server computes realized PnL and updates your cash balance.
          </div>
          <Field label="Reason (optional)">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Thesis broken, locking in the gain"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => {
              if (!trade) return;
              onSubmit(trade.id, { reason: reason || "Operator closed" });
            }}
          >
            Close at market
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
