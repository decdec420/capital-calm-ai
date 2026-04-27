import { useEffect, useMemo, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { EmptyState } from "@/components/trader/EmptyState";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useStrategies, type NewStrategyInput } from "@/hooks/useStrategies";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { StrategyParam, StrategyStatus, StrategyVersion, StrategyMetrics } from "@/lib/domain-types";
import {
  ArrowRight,
  Beaker,
  ChevronDown,
  Copy,
  FlaskConical,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { fetchCandlesAndBacktest } from "@/lib/backtest";
import { ParamEditor } from "@/components/trader/ParamEditor";
import { Link } from "react-router-dom";
import { ScalingReadinessPanel } from "@/components/trader/ScalingReadinessPanel";
import { displayNameFor, autoSummaryFromVersion } from "@/lib/strategy-naming";

const TRADES_TO_PROMOTE = 100;

export default function StrategyLab() {
  const {
    strategies,
    loading,
    create,
    update,
    remove,
    refetch,
    approved,
    candidates,
    inTesting,
    queued,
    archived,
    duplicateIds,
    moveTesting,
    removeDuplicates,
  } = useStrategies();
  const { session } = useAuth();

  const [newOpen, setNewOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [backtestingId, setBacktestingId] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [showArchive, setShowArchive] = useState(false);

  /** Map of strategyId → experiment title that promoted it (for the
   * "Promoted from experiment" line in the In Testing panel). */
  const [promotionMap, setPromotionMap] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = strategies.map((s) => s.id);
      if (ids.length === 0) {
        setPromotionMap({});
        return;
      }
      const { data } = await supabase
        .from("experiments")
        .select("id,title,strategy_id")
        .in("strategy_id", ids);
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const row of (data ?? []) as Array<{ title: string; strategy_id: string | null }>) {
        if (row.strategy_id) map[row.strategy_id] = row.title;
      }
      setPromotionMap(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [strategies]);

  const editingStrategy = editingId ? strategies.find((s) => s.id === editingId) ?? null : null;

  const setStatus = async (id: string, status: StrategyStatus) => {
    try {
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
    const v = source.version.replace(
      /v?(\d+)\.(\d+)(.*)/,
      (_m, a, b, suffix) => `v${a}.${Number(b) + 1}${suffix.includes("cand") ? suffix : "-cand"}`,
    );
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

  /** Manual trigger for the auto-promotion check. Calls the same edge
   * function the cron hits, but with the user's JWT so it only evaluates
   * this user. Refetches afterwards so the UI reflects any promotion. */
  const triggerEvaluate = async () => {
    setEvaluating(true);
    const t = toast.loading("Evaluating in-testing candidate…");
    try {
      const { data, error } = await supabase.functions.invoke("evaluate-candidate", {
        body: { source: "manual" },
        headers: session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : undefined,
      });
      if (error) throw error;
      const result = (data?.results?.[0] ?? {}) as Record<string, unknown>;
      if (result.promoted) toast.success(`Promoted ${result.promoted} to live.`, { id: t });
      else if (result.retired) toast.message(`Retired ${result.retired}. ${result.failReasons ?? ""}`, { id: t });
      else if (result.paused) toast.warning("Paused — drawdown concern. Check alerts.", { id: t });
      else if (result.skipped === "not_enough_trades")
        toast.message(`Need ${TRADES_TO_PROMOTE - Number(result.trades ?? 0)} more paper trades.`, { id: t });
      else if (result.skipped === "no_candidates") toast.message("No candidate to evaluate.", { id: t });
      else if (result.skipped === "no_approved_baseline") toast.message("No approved baseline to compare against.", { id: t });
      else toast.success("Check complete.", { id: t });
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Evaluation failed", { id: t });
    } finally {
      setEvaluating(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Strategy Lab"
        title="Pipeline"
        description="One strategy is trading. One is being tested. Everything else waits its turn. The bot only swaps after a clear win."
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
        <div className="space-y-6">
          {/* ─── 1. LIVE ────────────────────────────────────────────── */}
          <LivePanel
            approved={approved}
            promotionTitle={approved ? promotionMap[approved.id] : undefined}
            onClone={(s) => create(cloneFrom(s)).then(() => toast.success("Cloned as candidate."))}
            onEdit={(s) => setEditingId(s.id)}
            onBacktest={runBacktest}
            backtestingId={backtestingId}
          />

          {/* ─── Scaling readiness checklist (collapsed by default) ──── */}
          <ScalingReadinessPanel />

          {/* ─── 2. IN TESTING ──────────────────────────────────────── */}
          <InTestingPanel
            inTesting={inTesting}
            approved={approved}
            promotionTitle={inTesting ? promotionMap[inTesting.id] : undefined}
            onForcePromote={(id) => setStatus(id, "approved")}
            onRetire={(id) => setStatus(id, "archived")}
            onEdit={(s) => setEditingId(s.id)}
            onBacktest={runBacktest}
            backtestingId={backtestingId}
            onTriggerEvaluate={triggerEvaluate}
            evaluating={evaluating}
          />

          {/* ─── 3. QUEUE ────────────────────────────────────────────── */}
          {candidates.length >= 2 && (
            <QueuePanel
              queued={queued}
              duplicateIds={duplicateIds}
              promotionMap={promotionMap}
              onMoveToTesting={async (id) => {
                try {
                  await moveTesting(id);
                  toast.success("Moved to testing. Previous candidate is back in the queue.");
                } catch {
                  toast.error("Couldn't move candidate.");
                }
              }}
              onArchive={(id) => setStatus(id, "archived")}
              onRemoveDuplicates={async () => {
                try {
                  const n = await removeDuplicates();
                  if (n > 0) toast.success(`Archived ${n} duplicate candidate${n === 1 ? "" : "s"}.`);
                } catch {
                  toast.error("Couldn't archive duplicates.");
                }
              }}
            />
          )}

          {/* ─── 4. ARCHIVE ──────────────────────────────────────────── */}
          {archived.length > 0 && (
            <Collapsible open={showArchive} onOpenChange={setShowArchive}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="w-full flex items-center justify-between gap-2 text-left px-3 py-2 rounded-md hover:bg-secondary/40 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      Archive
                    </span>
                    <span className="text-xs text-muted-foreground">— {archived.length}</span>
                  </div>
                  <ChevronDown
                    className={`h-4 w-4 text-muted-foreground transition-transform ${showArchive ? "rotate-180" : ""}`}
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-1">
                {archived.map((s) => (
                  <ArchiveRow
                    key={s.id}
                    s={s}
                    promotionTitle={promotionMap[s.id]}
                    onDelete={() => remove(s.id).then(() => toast.success("Strategy removed."))}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
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

// ────────────────────────────────────────────────────────────────────────
// LIVE
// ────────────────────────────────────────────────────────────────────────

function LivePanel({
  approved,
  promotionTitle,
  onClone,
  onEdit,
  onBacktest,
  backtestingId,
}: {
  approved: StrategyVersion | null;
  promotionTitle?: string;
  onClone: (s: StrategyVersion) => void;
  onEdit: (s: StrategyVersion) => void;
  onBacktest: (s: StrategyVersion) => void;
  backtestingId: string | null;
}) {
  if (!approved) {
    return (
      <div className="panel p-5">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Now trading</div>
        <EmptyState
          icon={<ShieldCheck className="h-5 w-5" />}
          title="Nothing trading yet"
          description="Promote a candidate to choose what runs with real money."
        />
      </div>
    );
  }
  const m = approved.metrics;
  const friendly = displayNameFor(approved);
  return (
    <div className="panel p-5 space-y-4 border-status-safe/30">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1.5">
          <StatusBadge tone="safe" size="sm" dot>Now trading</StatusBadge>
          <div className="flex items-baseline gap-2 flex-wrap">
            <h2 className="text-xl font-semibold text-foreground">{friendly}</h2>
            <span className="text-xs text-muted-foreground font-mono">{approved.name} {approved.version}</span>
          </div>
          {approved.description && (
            <p className="text-sm text-muted-foreground max-w-xl">{approved.description}</p>
          )}
          {promotionTitle && (
            <p className="text-[11px] text-muted-foreground italic">
              Promoted from experiment:{" "}
              <Link to="/learning" className="text-primary hover:underline">
                {promotionTitle}
              </Link>
            </p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Live strategy actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onClone(approved)}>
              <Copy className="h-4 w-4 mr-2" /> Clone as candidate
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit(approved)}>
              <Pencil className="h-4 w-4 mr-2" /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={backtestingId === approved.id}
              onClick={() => onBacktest(approved)}
            >
              {backtestingId === approved.id ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FlaskConical className="h-4 w-4 mr-2" />
              )}
              Re-run backtest
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 pt-3 border-t border-border">
        <FriendlyMetric label="Avg profit per trade" sub="Expectancy" value={m.trades === 0 ? "—" : `${m.expectancy.toFixed(2)}R`} hint="How many R you make on an average trade. Above 0 = profitable." />
        <FriendlyMetric label="How often it wins" sub="Win rate" value={m.trades === 0 ? "—" : `${(m.winRate * 100).toFixed(0)}%`} hint="% of trades that closed in profit." />
        <FriendlyMetric label="Worst losing streak" sub="Max drawdown" value={m.trades === 0 ? "—" : `${(m.maxDrawdown * 100).toFixed(1)}%`} hint="Largest peak-to-trough drop. Closer to 0 is better." />
        <FriendlyMetric label="Smoothness" sub="Sharpe" value={m.trades === 0 ? "—" : m.sharpe.toFixed(2)} hint="How steady the returns are. Higher = less rollercoaster." />
        <FriendlyMetric label="Sample size" sub="Trades" value={m.trades === 0 ? "—" : String(m.trades)} hint="More trades = more confidence in the numbers above." />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// IN TESTING
// ────────────────────────────────────────────────────────────────────────

function InTestingPanel({
  inTesting,
  approved,
  promotionTitle,
  onForcePromote,
  onRetire,
  onEdit,
  onBacktest,
  backtestingId,
  onTriggerEvaluate,
  evaluating,
}: {
  inTesting: StrategyVersion | null;
  approved: StrategyVersion | null;
  promotionTitle?: string;
  onForcePromote: (id: string) => void;
  onRetire: (id: string) => void;
  onEdit: (s: StrategyVersion) => void;
  onBacktest: (s: StrategyVersion) => void;
  backtestingId: string | null;
  onTriggerEvaluate: () => void;
  evaluating: boolean;
}) {
  if (!inTesting) {
    return (
      <div className="panel p-5 space-y-3">
        <div className="flex items-center gap-2">
          <StatusBadge tone="candidate" size="sm" dot pulse>In testing</StatusBadge>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">empty slot</span>
        </div>
        <EmptyState
          icon={<Beaker className="h-5 w-5" />}
          title="Nothing in testing"
          description="Head to Learning to promote an experiment, or clone the live strategy from the menu above."
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/learning">Open Learning</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const m = inTesting.metrics;
  const trades = m.trades ?? 0;
  const progress = Math.min(100, (trades / TRADES_TO_PROMOTE) * 100);
  const remaining = Math.max(0, TRADES_TO_PROMOTE - trades);
  const canForcePromote = trades >= TRADES_TO_PROMOTE;

  // Param diff vs live — only the keys that changed
  const paramDiffs = useMemo(() => {
    if (!approved) return [];
    const baseMap = new Map(approved.params.map((p) => [p.key, p.value]));
    const diffs: Array<{ key: string; before: unknown; after: unknown }> = [];
    for (const p of inTesting.params) {
      const before = baseMap.get(p.key);
      if (before !== p.value) diffs.push({ key: p.key, before: before ?? "—", after: p.value });
    }
    // Also include keys removed from candidate
    for (const p of approved.params) {
      if (!inTesting.params.some((x) => x.key === p.key)) {
        diffs.push({ key: p.key, before: p.value, after: "—" });
      }
    }
    return diffs;
  }, [approved, inTesting]);

  const friendly = displayNameFor(inTesting);
  const baseValueForFirstDiff = paramDiffs[0]?.before;
  const summary =
    inTesting.friendlySummary ??
    autoSummaryFromVersion(inTesting.version, baseValueForFirstDiff) ??
    "Tweaked variant";

  return (
    <div className="panel p-5 space-y-4 border-status-candidate/30">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1.5">
          <StatusBadge tone="candidate" size="sm" dot pulse>Paper testing</StatusBadge>
          <div className="flex items-baseline gap-2 flex-wrap">
            <h2 className="text-xl font-semibold text-foreground">{summary}</h2>
            <span className="text-xs text-muted-foreground font-mono">{inTesting.name} {inTesting.version}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            Trying a tweak on <span className="text-foreground">{friendly}</span> — collecting paper trades to see if it actually does better.
          </p>
          {promotionTitle && (
            <p className="text-[11px] text-muted-foreground italic">
              Promoted from experiment:{" "}
              <Link to="/learning" className="text-primary hover:underline">
                {promotionTitle}
              </Link>
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => onRetire(inTesting.id)}
          >
            Retire early
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" aria-label="Candidate actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onTriggerEvaluate} disabled={evaluating}>
                {evaluating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                Run check now
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(inTesting)}>
                <Pencil className="h-4 w-4 mr-2" /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={backtestingId === inTesting.id}
                onClick={() => onBacktest(inTesting)}
              >
                {backtestingId === inTesting.id ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <FlaskConical className="h-4 w-4 mr-2" />
                )}
                Re-run backtest
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="block">
                      <DropdownMenuItem
                        disabled={!canForcePromote}
                        onClick={() => onForcePromote(inTesting.id)}
                      >
                        <ShieldCheck className="h-4 w-4 mr-2" /> Force promote to live
                      </DropdownMenuItem>
                    </span>
                  </TooltipTrigger>
                  {!canForcePromote && (
                    <TooltipContent side="left">
                      Need {remaining} more paper trade{remaining === 1 ? "" : "s"} (currently {trades}/{TRADES_TO_PROMOTE}).
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Metric row with deltas vs approved — friendly subtitles */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 pt-3 border-t border-border">
        <FriendlyDeltaMetric label="Avg profit per trade" sub="Expectancy" cur={m.expectancy} base={approved?.metrics.expectancy ?? null} suffix="R" untested={trades === 0} hint="How many R you make on an average trade." />
        <FriendlyDeltaMetric label="How often it wins" sub="Win rate" cur={m.winRate * 100} base={approved ? approved.metrics.winRate * 100 : null} suffix="%" untested={trades === 0} hint="% of trades that closed in profit." />
        <FriendlyDeltaMetric label="Worst losing streak" sub="Max drawdown" cur={m.maxDrawdown * 100} base={approved ? approved.metrics.maxDrawdown * 100 : null} suffix="%" inverse untested={trades === 0} hint="Closer to 0 is better." />
        <FriendlyDeltaMetric label="Smoothness" sub="Sharpe" cur={m.sharpe} base={approved?.metrics.sharpe ?? null} untested={trades === 0} hint="Higher = less rollercoaster." />
        <FriendlyMetric label="Sample size" sub="Trades" value={trades === 0 ? "—" : String(trades)} hint="More trades = more confidence in the numbers." />
      </div>

      {/* Promotion progress with friendlier label */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            Building evidence · {trades} of {TRADES_TO_PROMOTE} paper trades
          </span>
          <span className="text-muted-foreground tabular">
            {canForcePromote ? "Ready for review" : `${remaining} to go`}
          </span>
        </div>
        <Progress value={progress} className="h-2" />
      </div>

      {/* Param diff — collapsed by default */}
      {paramDiffs.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
            >
              <ChevronDown className="h-3 w-3" />
              See what changed ({paramDiffs.length})
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-1.5">
              {paramDiffs.map((d) => (
                <div key={d.key} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{d.key}</span>
                  <span className="tabular text-foreground">
                    <span className="text-muted-foreground">{String(d.before)}</span>{" "}
                    <ArrowRight className="inline h-3 w-3 text-muted-foreground mx-1" />{" "}
                    <span className="text-primary font-medium">{String(d.after)}</span>
                  </span>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Calmer auto-pilot banner */}
      <div className="rounded-md bg-primary/5 border border-primary/20 p-3 text-sm text-foreground/90 leading-relaxed">
        <span className="text-base mr-1.5">🤖</span>
        On auto-pilot — checking every 30 min. Only swaps the live strategy after <span className="text-foreground font-medium">{TRADES_TO_PROMOTE} paper trades</span> and a clear win, then waits a week before swapping again.
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// QUEUE
// ────────────────────────────────────────────────────────────────────────

function QueuePanel({
  queued,
  duplicateIds,
  promotionMap,
  onMoveToTesting,
  onArchive,
  onRemoveDuplicates,
}: {
  queued: StrategyVersion[];
  duplicateIds: Set<string>;
  promotionMap: Record<string, string>;
  onMoveToTesting: (id: string) => void;
  onArchive: (id: string) => void;
  onRemoveDuplicates: () => void;
}) {
  if (queued.length === 0) return null;
  const dupCount = queued.filter((q) => duplicateIds.has(q.id)).length;

  return (
    <div className="panel p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Queue</span>
          <span className="text-xs text-muted-foreground">— {queued.length} waiting</span>
        </div>
        {dupCount > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-7 text-xs"
            onClick={onRemoveDuplicates}
          >
            <Trash2 className="h-3 w-3" /> Remove {dupCount} duplicate{dupCount === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      <div className="divide-y divide-border">
        {queued.map((s) => (
          <QueueRow
            key={s.id}
            s={s}
            isDuplicate={duplicateIds.has(s.id)}
            promotionTitle={promotionMap[s.id]}
            onMoveToTesting={() => onMoveToTesting(s.id)}
            onArchive={() => onArchive(s.id)}
          />
        ))}
      </div>
    </div>
  );
}

function QueueRow({
  s,
  isDuplicate,
  promotionTitle,
  onMoveToTesting,
  onArchive,
}: {
  s: StrategyVersion;
  isDuplicate: boolean;
  promotionTitle?: string;
  onMoveToTesting: () => void;
  onArchive: () => void;
}) {
  // Cheap "what's different" summary — hide if we don't have anything useful
  const summary = useMemo(
    () => s.friendlySummary ?? autoSummaryFromVersion(s.version) ?? null,
    [s.friendlySummary, s.version],
  );

  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm flex-wrap">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-foreground font-medium truncate">{summary ?? displayNameFor(s)}</span>
        <span className="text-muted-foreground text-xs font-mono">{s.name} {s.version}</span>
        {isDuplicate && (
          <StatusBadge tone="caution" size="sm">duplicate</StatusBadge>
        )}
      </div>
      <div className="flex items-center gap-3">
        {promotionTitle && (
          <span className="text-[11px] text-muted-foreground italic truncate max-w-[180px]" title={promotionTitle}>
            {promotionTitle}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground tabular">
          {new Date(s.createdAt).toLocaleDateString()}
        </span>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onMoveToTesting}>
          Move to testing
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          onClick={onArchive}
          aria-label="Archive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// ARCHIVE
// ────────────────────────────────────────────────────────────────────────

function ArchiveRow({
  s,
  promotionTitle,
  onDelete,
}: {
  s: StrategyVersion;
  promotionTitle?: string;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 px-3 text-sm rounded-md hover:bg-secondary/40">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <span className="text-muted-foreground truncate">{s.name}</span>
        <span className="text-muted-foreground text-xs">{s.version}</span>
        {promotionTitle && (
          <span className="text-[11px] text-muted-foreground italic truncate">
            · {promotionTitle}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-muted-foreground tabular">
          {new Date(s.createdAt).toLocaleDateString()}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label="Delete permanently"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Small primitives
// ────────────────────────────────────────────────────────────────────────

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular text-foreground">{value}</div>
    </div>
  );
}

function DeltaMetric({
  label,
  cur,
  base,
  suffix = "",
  inverse = false,
  untested = false,
}: {
  label: string;
  cur: number;
  base: number | null;
  suffix?: string;
  /** True when "lower is better" (e.g. drawdown). */
  inverse?: boolean;
  untested?: boolean;
}) {
  if (untested) {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm tabular text-muted-foreground">—</div>
      </div>
    );
  }
  if (base == null || !Number.isFinite(base)) {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm tabular text-foreground">{cur.toFixed(2)}{suffix}</div>
      </div>
    );
  }
  const delta = cur - base;
  const better = inverse ? delta < 0 : delta > 0;
  const same = delta === 0;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular text-foreground">
        {cur.toFixed(2)}{suffix}{" "}
        <span className={`text-xs ${same ? "text-muted-foreground" : better ? "text-status-safe" : "text-status-blocked"}`}>
          ({delta >= 0 ? "+" : ""}{delta.toFixed(2)})
        </span>
      </div>
    </div>
  );
}

/** Plain-English metric: big friendly label on top, technical name + value below.
 *  Tooltip on hover gives the long explanation. */
function FriendlyMetric({
  label,
  sub,
  value,
  hint,
}: {
  label: string;
  sub: string;
  value: string;
  hint: string;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">
            <div className="text-xs text-muted-foreground leading-tight">{label}</div>
            <div className="text-base tabular text-foreground font-medium mt-0.5">{value}</div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-0.5">{sub}</div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[200px] text-xs">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Same as FriendlyMetric but shows a delta vs the live baseline. */
function FriendlyDeltaMetric({
  label,
  sub,
  cur,
  base,
  suffix = "",
  inverse = false,
  untested = false,
  hint,
}: {
  label: string;
  sub: string;
  cur: number;
  base: number | null;
  suffix?: string;
  inverse?: boolean;
  untested?: boolean;
  hint: string;
}) {
  let body: React.ReactNode;
  if (untested) {
    body = <div className="text-base tabular text-muted-foreground font-medium mt-0.5">—</div>;
  } else if (base == null || !Number.isFinite(base)) {
    body = (
      <div className="text-base tabular text-foreground font-medium mt-0.5">
        {cur.toFixed(2)}{suffix}
      </div>
    );
  } else {
    const delta = cur - base;
    const better = inverse ? delta < 0 : delta > 0;
    const same = delta === 0;
    body = (
      <div className="text-base tabular text-foreground font-medium mt-0.5">
        {cur.toFixed(2)}{suffix}{" "}
        <span className={`text-xs ${same ? "text-muted-foreground" : better ? "text-status-safe" : "text-status-blocked"}`}>
          ({delta >= 0 ? "+" : ""}{delta.toFixed(2)})
        </span>
      </div>
    );
  }
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="cursor-help">
            <div className="text-xs text-muted-foreground leading-tight">{label}</div>
            {body}
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-0.5">{sub}</div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px] text-xs">{hint} Number in parentheses is the change vs the live strategy.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
// ────────────────────────────────────────────────────────────────────────

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
  const [displayName, setDisplayName] = useState(strategy?.displayName ?? "");
  const [status, setStatus] = useState<StrategyStatus>(strategy?.status ?? "candidate");
  const [description, setDescription] = useState(strategy?.description ?? "");
  const [params, setParams] = useState<StrategyParam[]>(strategy?.params ?? []);
  const [metricsText, setMetricsText] = useState(
    strategy
      ? JSON.stringify(strategy.metrics, null, 2)
      : `{\n  "expectancy": 0,\n  "winRate": 0,\n  "maxDrawdown": 0,\n  "sharpe": 0,\n  "trades": 0\n}`,
  );

  useEffect(() => {
    if (strategy) {
      setName(strategy.name);
      setVersion(strategy.version);
      setDisplayName(strategy.displayName ?? "");
      setStatus(strategy.status);
      setDescription(strategy.description);
      setParams(strategy.params);
      setMetricsText(JSON.stringify(strategy.metrics, null, 2));
    }
  }, [strategy]);

  const submit = () => {
    let metrics: StrategyMetrics;
    try {
      metrics = JSON.parse(metricsText);
    } catch {
      return toast.error("Metrics is not valid JSON.");
    }
    if (!name.trim() || !version.trim()) return toast.error("Name + version required.");
    onSubmit({
      name,
      version,
      displayName: displayName.trim() ? displayName.trim() : null,
      status,
      description,
      params,
      metrics,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{strategy ? "Edit strategy" : "New strategy"}</DialogTitle>
          <DialogDescription>Params and metrics are JSON. The bot consumes them as-is.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">Display name (optional)</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Steady Trender"
            />
            <p className="text-[10px] text-muted-foreground">Friendly nickname shown in the UI. Leave blank to use the default.</p>
          </div>
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

// Suppress unused-import lint when RotateCcw is not used (kept for potential future actions).
void RotateCcw;
