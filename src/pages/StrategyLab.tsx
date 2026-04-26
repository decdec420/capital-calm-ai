import { useEffect, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StrategyVersionCard } from "@/components/trader/StrategyVersionCard";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { EmptyState } from "@/components/trader/EmptyState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useStrategies, type NewStrategyInput } from "@/hooks/useStrategies";
import type { StrategyParam, StrategyStatus, StrategyVersion } from "@/lib/domain-types";
import { ArrowRight, Beaker, Check, FlaskConical, Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { fetchCandlesAndBacktest } from "@/lib/backtest";
import { ParamEditor } from "@/components/trader/ParamEditor";

export default function StrategyLab() {
  const { strategies, loading, create, update, remove } = useStrategies();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [backtestingId, setBacktestingId] = useState<string | null>(null);

  const candidate = strategies.find((s) => s.status === "candidate");
  const approved = strategies.find((s) => s.status === "approved");
  const editingStrategy = editingId ? strategies.find((s) => s.id === editingId) ?? null : null;

  useEffect(() => {
    if (!selectedId && strategies.length > 0) {
      setSelectedId(candidate?.id ?? strategies[0].id);
    }
  }, [strategies, candidate, selectedId]);

  const setStatus = async (id: string, status: StrategyStatus) => {
    try {
      // If promoting a candidate to approved, archive any existing approved
      if (status === "approved" && approved && approved.id !== id) {
        await update(approved.id, { status: "archived" });
      }
      await update(id, { status });
      toast.success(`Strategy moved to ${status}.`);
    } catch {
      toast.error("Couldn't update strategy.");
    }
  };

  const cloneFrom = (source: StrategyVersion): NewStrategyInput => {
    const v = source.version.replace(/v?(\d+)\.(\d+)(.*)/, (_m, a, b, suffix) => `v${a}.${Number(b) + 1}${suffix.includes("cand") ? suffix : "-cand"}`);
    return {
      name: source.name,
      version: v,
      status: "candidate",
      description: `Clone of ${source.version} — tweak params and test in paper.`,
      params: source.params,
      metrics: { expectancy: 0, winRate: 0, maxDrawdown: 0, sharpe: 0, trades: 0 },
    };
  };

  const runBacktest = async (s: StrategyVersion) => {
    setBacktestingId(s.id);
    const t = toast.loading(`Backtesting ${s.version} on BTC-USD 1h…`);
    try {
      const result = await fetchCandlesAndBacktest(s.params);
      if (result.metrics.trades === 0) {
        toast.warning(`${s.version}: zero signals on the sample. Loosen the cross filter.`, { id: t });
      } else {
        await update(s.id, { metrics: result.metrics });
        toast.success(
          `${s.version}: ${result.metrics.trades} trades · ${(result.metrics.winRate * 100).toFixed(0)}% win · ${result.metrics.expectancy.toFixed(2)}R expectancy`,
          { id: t },
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Backtest failed", { id: t });
    } finally {
      setBacktestingId(null);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Strategy Lab"
        title="Versions & promotion"
        description="Strategies move forward only when evidence justifies it."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New strategy
          </Button>
        }
      />

      {loading ? (
        <p className="text-xs text-muted-foreground italic">Loading…</p>
      ) : strategies.length === 0 ? (
        <EmptyState
          icon={<Beaker className="h-5 w-5" />}
          title="Lab is cold"
          description="Spin up your first strategy to start the experiment cycle."
          action={<Button size="sm" onClick={() => setNewOpen(true)}>Create strategy</Button>}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {strategies.map((s) => (
              <div key={s.id} className="relative group">
                <StrategyVersionCard strategy={s} selected={selectedId === s.id} onSelect={() => setSelectedId(s.id)} />
                <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs gap-1"
                    disabled={backtestingId === s.id}
                    onClick={(e) => { e.stopPropagation(); runBacktest(s); }}
                    title="Replay strategy on BTC-USD 1h candles"
                  >
                    {backtestingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                    Backtest
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={(e) => { e.stopPropagation(); setEditingId(s.id); }}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={(e) => { e.stopPropagation(); create(cloneFrom(s)).then(() => toast.success("Cloned as candidate.")); }}>
                    <RotateCcw className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={(e) => { e.stopPropagation(); remove(s.id).then(() => toast.success("Strategy removed.")); }}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {approved && candidate && (
            <div className="panel p-5 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Promotion review</div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-sm font-medium text-foreground">{approved.version}</span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">{candidate.version}</span>
                    <StatusBadge tone="candidate" size="sm" dot>candidate</StatusBadge>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="gap-1.5 text-status-blocked border-status-blocked/40 hover:bg-status-blocked/10 hover:text-status-blocked" onClick={() => setStatus(candidate.id, "archived")}>
                    <X className="h-3.5 w-3.5" /> Reject
                  </Button>
                  <Button size="sm" className="gap-1.5" onClick={() => setStatus(candidate.id, "approved")}>
                    <Check className="h-3.5 w-3.5" /> Promote
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <ParamDiff title={approved.version} params={approved.params} other={candidate.params} side="left" />
                <ParamDiff title={candidate.version} params={candidate.params} other={approved.params} side="right" />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 pt-4 border-t border-border">
                <DiffMetric label="Expectancy" a={approved.metrics.expectancy} b={candidate.metrics.expectancy} suffix="R" untested={candidate.metrics.trades === 0} baselineUntested={approved.metrics.trades === 0} />
                <DiffMetric label="Win rate" a={approved.metrics.winRate * 100} b={candidate.metrics.winRate * 100} suffix="%" untested={candidate.metrics.trades === 0} baselineUntested={approved.metrics.trades === 0} />
                <DiffMetric label="Max DD" a={approved.metrics.maxDrawdown * 100} b={candidate.metrics.maxDrawdown * 100} suffix="%" inverse untested={candidate.metrics.trades === 0} baselineUntested={approved.metrics.trades === 0} />
                <DiffMetric label="Sharpe" a={approved.metrics.sharpe} b={candidate.metrics.sharpe} untested={candidate.metrics.trades === 0} baselineUntested={approved.metrics.trades === 0} />
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Trades</div>
                  <div className="text-sm tabular text-foreground">
                    {candidate.metrics.trades === 0 ? "—" : candidate.metrics.trades}{" "}
                    <span className="text-muted-foreground">/ 50 needed</span>
                  </div>
                </div>
              </div>

              <div className="rounded-md bg-status-blocked/5 border border-status-blocked/20 p-3 flex items-start gap-3">
                <StatusBadge tone="blocked" size="sm" dot>gating</StatusBadge>
                <p className="text-xs text-muted-foreground">
                  Promotion requires ≥50 paper trades on the candidate (currently {candidate.metrics.trades}) and explicit operator approval.
                </p>
              </div>
            </div>
          )}
        </>
      )}

      <StrategyDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onSubmit={async (input) => {
          try {
            await create(input);
            toast.success("Strategy created.");
            setNewOpen(false);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't create strategy");
          }
        }}
      />

      <StrategyDialog
        open={!!editingStrategy}
        strategy={editingStrategy ?? undefined}
        onOpenChange={(o) => !o && setEditingId(null)}
        onSubmit={async (input) => {
          if (!editingStrategy) return;
          try {
            await update(editingStrategy.id, input);
            toast.success("Strategy updated.");
            setEditingId(null);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't update");
          }
        }}
      />
    </div>
  );
}

function ParamDiff({ title, params, other, side }: { title: string; params: StrategyParam[]; other: StrategyParam[]; side: "left" | "right" }) {
  const otherMap = new Map(other.map((p) => [p.key, p.value]));
  return (
    <div className="rounded-md border border-border bg-secondary/30 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">{title}</div>
      <div className="space-y-1.5">
        {params.map((p) => {
          const otherVal = otherMap.get(p.key);
          const changed = otherVal !== p.value;
          return (
            <div key={p.key} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground font-mono text-xs">{p.key}</span>
              <span className={`tabular ${changed && side === "right" ? "text-primary font-medium" : "text-foreground"}`}>
                {String(p.value)}{p.unit ?? ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffMetric({
  label,
  a,
  b,
  suffix = "",
  inverse = false,
  untested = false,
  baselineUntested = false,
}: {
  label: string;
  a: number;
  b: number;
  suffix?: string;
  inverse?: boolean;
  /** Candidate side has no backtest data yet — render the value cell as "—". */
  untested?: boolean;
  /** Approved side has no backtest data either — suppress the delta entirely. */
  baselineUntested?: boolean;
}) {
  if (untested) {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm tabular text-muted-foreground" title="Not yet measured — run a backtest">—</div>
      </div>
    );
  }
  const delta = b - a;
  const better = inverse ? delta < 0 : delta > 0;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular text-foreground">
        {b.toFixed(2)}{suffix}{" "}
        {baselineUntested ? (
          <span className="text-xs text-muted-foreground">(no baseline)</span>
        ) : (
          <span className={`text-xs ${better ? "text-status-safe" : delta === 0 ? "text-muted-foreground" : "text-status-blocked"}`}>
            ({delta >= 0 ? "+" : ""}{delta.toFixed(2)})
          </span>
        )}
      </div>
    </div>
  );
}

function StrategyDialog({
  open,
  onOpenChange,
  strategy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  strategy?: StrategyVersion;
  onSubmit: (input: NewStrategyInput) => void;
}) {
  const [name, setName] = useState(strategy?.name ?? "trend-rev");
  const [version, setVersion] = useState(strategy?.version ?? "v1.0-cand");
  const [status, setStatus] = useState<StrategyStatus>(strategy?.status ?? "candidate");
  const [description, setDescription] = useState(strategy?.description ?? "");
  const [params, setParams] = useState<StrategyParam[]>(strategy?.params ?? []);
  const [metricsText, setMetricsText] = useState(
    strategy ? JSON.stringify(strategy.metrics, null, 2) : `{\n  "expectancy": 0,\n  "winRate": 0,\n  "maxDrawdown": 0,\n  "sharpe": 0,\n  "trades": 0\n}`,
  );

  useEffect(() => {
    if (strategy) {
      setName(strategy.name);
      setVersion(strategy.version);
      setStatus(strategy.status);
      setDescription(strategy.description);
      setParams(strategy.params);
      setMetricsText(JSON.stringify(strategy.metrics, null, 2));
    }
  }, [strategy]);

  const submit = () => {
    let metrics: any;
    try {
      metrics = JSON.parse(metricsText);
    } catch {
      return toast.error("Metrics is not valid JSON.");
    }
    if (!name.trim() || !version.trim()) return toast.error("Name + version required.");
    onSubmit({ name, version, status, description, params, metrics });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{strategy ? "Edit strategy" : "New strategy"}</DialogTitle>
          <DialogDescription>Params and metrics are JSON. The bot consumes them as-is.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Version</Label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as StrategyStatus)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="candidate">Candidate</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Params</Label>
              <ParamEditor value={params} onChange={setParams} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Metrics (JSON)</Label>
              <Textarea value={metricsText} onChange={(e) => setMetricsText(e.target.value)} rows={8} className="font-mono text-xs" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit}>{strategy ? "Save" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
