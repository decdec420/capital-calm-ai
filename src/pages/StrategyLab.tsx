import { useEffect, useMemo, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { EmptyState } from "@/components/trader/EmptyState";
import { Button } from "@/components/ui/button";

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
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { fetchCandlesAndBacktest } from "@/lib/backtest";
import { ParamEditor } from "@/components/trader/ParamEditor";
import { Link } from "react-router-dom";
import { ScalingReadinessPanel } from "@/components/trader/ScalingReadinessPanel";
import { PipelineFlowBanner } from "@/components/trader/PipelineFlowBanner";
import { StrategyGradeBadge } from "@/components/trader/StrategyGradeBadge";
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
    inTestingList,
    archived,
    duplicateIds,
    removeDuplicates,
  } = useStrategies();
  const { user, session } = useAuth();

  const [newOpen, setNewOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [backtestingId, setBacktestingId] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [showArchive, setShowArchive] = useState(false);

  /** Map of strategyId → experiment title that promoted it. */
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

  /** Auto-pilot heartbeat — when did the cron last run for this user. */
  const [lastEvaluatedAt, setLastEvaluatedAt] = useState<string | null>(null);
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      const { data } = await supabase
        .from("system_state")
        .select("last_evaluated_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      setLastEvaluatedAt((data as { last_evaluated_at: string | null } | null)?.last_evaluated_at ?? null);
    };
    load();
    const t = setInterval(load, 60_000); // refresh every minute so the "N min ago" stays fresh
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [user?.id]);

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
      displayName: source.displayName,
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

  /** Manual trigger for the auto-pilot. Now summarizes a multi-candidate response. */
  const triggerEvaluate = async () => {
    setEvaluating(true);
    const t = toast.loading(`Checking ${inTestingList.length} paper test${inTestingList.length === 1 ? "" : "s"}…`);
    try {
      const { data, error } = await supabase.functions.invoke("evaluate-candidate", {
        body: { source: "manual" },
        headers: session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : undefined,
      });
      if (error) throw error;
      const userBlock = (data?.results?.[0] ?? {}) as {
        results?: Array<{ outcome: string; candidate: string; trades?: number; need?: number }>;
        skipped?: string;
      };
      const perCand = userBlock.results ?? [];
      if (userBlock.skipped === "no_candidates") {
        toast.message("No paper tests running.", { id: t });
      } else if (userBlock.skipped === "no_approved_baseline") {
        toast.message("No approved baseline to compare against.", { id: t });
      } else if (perCand.length === 0) {
        toast.success("Check complete.", { id: t });
      } else {
        const promoted = perCand.find((r) => r.outcome === "promoted");
        const retired = perCand.filter((r) => r.outcome === "retired").length;
        const paused = perCand.filter((r) => r.outcome === "paused").length;
        const collecting = perCand.filter((r) => r.outcome === "skipped").length;
        const parts: string[] = [];
        if (promoted) parts.push(`Promoted ${promoted.candidate} to live`);
        if (retired > 0) parts.push(`${retired} retired`);
        if (paused > 0) parts.push(`${paused} need review`);
        if (collecting > 0) parts.push(`${collecting} still collecting trades`);
        const msg = parts.length > 0 ? parts.join(" · ") : "Check complete.";
        if (promoted) toast.success(msg, { id: t });
        else if (paused > 0) toast.warning(msg, { id: t });
        else toast.message(msg, { id: t });
      }
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Evaluation failed", { id: t });
    } finally {
      setEvaluating(false);
    }
  };

  const dupCount = inTestingList.filter((s) => duplicateIds.has(s.id)).length;

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Strategy Lab"
        title="Pipeline"
        description="One strategy is trading. Any number can paper-test in parallel. The bot only swaps the live one after a clear win."
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> New strategy
          </Button>
        }
      />

      {/* Feature 4: Backtest-first UX loop — shows the 5-stage pipeline */}
      <PipelineFlowBanner
        activeStage={
          strategies.length === 0          ? 0           // no strategies → "Idea" stage
          : !approved                       ? 3           // candidates only → "Paper test"
          : inTestingList.length > 0        ? 3           // candidates in paper → "Paper test"
          : 4                                             // approved, no candidates → "Live"
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

          {/* ─── Account-wide scaling readiness ─────────────────────── */}
          <ScalingReadinessPanel />

          {/* ─── 2. IN TESTING (multi) ──────────────────────────────── */}
          <InTestingListPanel
            list={inTestingList}
            approved={approved}
            promotionMap={promotionMap}
            duplicateIds={duplicateIds}
            dupCount={dupCount}
            evaluating={evaluating}
            onTriggerEvaluate={triggerEvaluate}
            lastEvaluatedAt={lastEvaluatedAt}
            onForcePromote={(id) => setStatus(id, "approved")}
            onRetire={(id) => setStatus(id, "archived")}
            onEdit={(s) => setEditingId(s.id)}
            onBacktest={runBacktest}
            backtestingId={backtestingId}
            onRemoveDuplicates={async () => {
              try {
                const n = await removeDuplicates();
                if (n > 0) toast.success(`Archived ${n} duplicate${n === 1 ? "" : "s"}.`);
              } catch {
                toast.error("Couldn't archive duplicates.");
              }
            }}
          />

          {/* ─── 3. ARCHIVE ──────────────────────────────────────────── */}
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
            <StrategyGradeBadge metrics={approved.metrics} size="sm" />
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
// IN TESTING (multi)
// ────────────────────────────────────────────────────────────────────────

function InTestingListPanel({
  list,
  approved,
  promotionMap,
  duplicateIds,
  dupCount,
  evaluating,
  onTriggerEvaluate,
  lastEvaluatedAt,
  onForcePromote,
  onRetire,
  onEdit,
  onBacktest,
  backtestingId,
  onRemoveDuplicates,
}: {
  list: StrategyVersion[];
  approved: StrategyVersion | null;
  promotionMap: Record<string, string>;
  duplicateIds: Set<string>;
  dupCount: number;
  evaluating: boolean;
  onTriggerEvaluate: () => void;
  lastEvaluatedAt: string | null;
  onForcePromote: (id: string) => void;
  onRetire: (id: string) => void;
  onEdit: (s: StrategyVersion) => void;
  onBacktest: (s: StrategyVersion) => void;
  backtestingId: string | null;
  onRemoveDuplicates: () => void;
}) {
  if (list.length === 0) {
    return (
      <div className="panel p-5 space-y-3">
        <div className="flex items-center gap-2">
          <StatusBadge tone="candidate" size="sm" dot pulse>In testing</StatusBadge>
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">no paper tests</span>
        </div>
        <EmptyState
          icon={<Beaker className="h-5 w-5" />}
          title="Nothing being tested"
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

  return (
    <div className="panel p-5 space-y-4 border-status-candidate/30">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge tone="candidate" size="sm" dot pulse>Paper testing</StatusBadge>
            <span className="text-xs text-muted-foreground">
              {list.length} running in parallel
            </span>
          </div>
          <p className="text-sm text-muted-foreground max-w-xl">
            Each candidate is collecting its own paper trades. The auto-pilot evaluates every one independently and only promotes the winner.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dupCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 text-xs"
              onClick={onRemoveDuplicates}
            >
              <Trash2 className="h-3 w-3" /> Remove {dupCount} duplicate{dupCount === 1 ? "" : "s"}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8"
            onClick={onTriggerEvaluate}
            disabled={evaluating}
          >
            {evaluating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Run check now
          </Button>
        </div>
      </div>

      {/* Auto-pilot banner — adapts to count and shows last-check heartbeat */}
      <AutoPilotBanner count={list.length} lastEvaluatedAt={lastEvaluatedAt} />

      {/* Per-candidate rows */}
      <div className="divide-y divide-border">
        {list.map((s) => (
          <CandidateRow
            key={s.id}
            s={s}
            approved={approved}
            promotionTitle={promotionMap[s.id]}
            isDuplicate={duplicateIds.has(s.id)}
            backtestingId={backtestingId}
            onForcePromote={() => onForcePromote(s.id)}
            onRetire={() => onRetire(s.id)}
            onEdit={() => onEdit(s)}
            onBacktest={() => onBacktest(s)}
          />
        ))}
      </div>
    </div>
  );
}

function AutoPilotBanner({
  count,
  lastEvaluatedAt,
}: {
  count: number;
  lastEvaluatedAt: string | null;
}) {
  if (count === 0) return null;
  const heartbeat = formatHeartbeat(lastEvaluatedAt);
  const next = nextCheckLabel(lastEvaluatedAt);
  return (
    <div className="rounded-md bg-primary/5 border border-primary/20 p-3 text-sm text-foreground/90 leading-relaxed space-y-1">
      <div>
        <span className="text-base mr-1.5">🤖</span>
        <span className="font-medium">Auto-pilot active</span> — checking{" "}
        <span className="text-foreground font-medium">all {count} paper test{count === 1 ? "" : "s"}</span>{" "}
        every 30 min. Promotes one to live if it clearly beats the current strategy after{" "}
        <span className="text-foreground font-medium">{TRADES_TO_PROMOTE} trades</span>, then waits a week before swapping again.
      </div>
      {(heartbeat || next) && (
        <div className="text-[11px] text-muted-foreground tabular">
          {heartbeat && <>Last check: {heartbeat}</>}
          {heartbeat && next && <span className="mx-1.5">·</span>}
          {next && <>Next: {next}</>}
        </div>
      )}
    </div>
  );
}

function formatHeartbeat(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function nextCheckLabel(iso: string | null): string | null {
  if (!iso) return null;
  const last = new Date(iso).getTime();
  if (!Number.isFinite(last)) return null;
  const next = last + 30 * 60_000;
  const remaining = next - Date.now();
  if (remaining <= 0) return "any moment";
  const min = Math.ceil(remaining / 60_000);
  return `in ${min} min`;
}

function CandidateRow({
  s,
  approved,
  promotionTitle,
  isDuplicate,
  backtestingId,
  onForcePromote,
  onRetire,
  onEdit,
  onBacktest,
}: {
  s: StrategyVersion;
  approved: StrategyVersion | null;
  promotionTitle?: string;
  isDuplicate: boolean;
  backtestingId: string | null;
  onForcePromote: () => void;
  onRetire: () => void;
  onEdit: () => void;
  onBacktest: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const m = s.metrics;
  const trades = m.trades ?? 0;
  const remaining = Math.max(0, TRADES_TO_PROMOTE - trades);
  const canForcePromote = trades >= TRADES_TO_PROMOTE;

  const friendly = displayNameFor(s);
  const paramDiffs = useMemo(() => {
    if (!approved) return [];
    const baseMap = new Map(approved.params.map((p) => [p.key, p.value]));
    const diffs: Array<{ key: string; before: unknown; after: unknown }> = [];
    for (const p of s.params) {
      const before = baseMap.get(p.key);
      if (before !== p.value) diffs.push({ key: p.key, before: before ?? "—", after: p.value });
    }
    for (const p of approved.params) {
      if (!s.params.some((x) => x.key === p.key)) {
        diffs.push({ key: p.key, before: p.value, after: "—" });
      }
    }
    return diffs;
  }, [approved, s.params]);

  const baseValueForFirstDiff = paramDiffs[0]?.before;
  const summary = s.friendlySummary ?? autoSummaryFromVersion(s.version, baseValueForFirstDiff) ?? "Tweaked variant";

  return (
    <div className="py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-medium text-foreground truncate">{summary}</span>
            <span className="text-[11px] text-muted-foreground font-mono">{s.name} {s.version}</span>
            {isDuplicate && <StatusBadge tone="caution" size="sm">duplicate</StatusBadge>}
            <StrategyGradeBadge metrics={s.metrics} size="sm" />
          </div>
          <p className="text-xs text-muted-foreground">
            Variant of <span className="text-foreground">{friendly}</span>
            {promotionTitle && (
              <>
                {" · from "}
                <Link to="/learning" className="text-primary hover:underline">
                  {promotionTitle}
                </Link>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? "Hide details" : "Show details"}
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
            {expanded ? "Less" : "Details"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Candidate actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil className="h-4 w-4 mr-2" /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={backtestingId === s.id}
                onClick={onBacktest}
              >
                {backtestingId === s.id ? (
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
                      <DropdownMenuItem disabled={!canForcePromote} onClick={onForcePromote}>
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
              <DropdownMenuItem onClick={onRetire} className="text-destructive focus:text-destructive">
                <Trash2 className="h-4 w-4 mr-2" /> Retire
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Headline deltas always visible */}
      <div className="mt-2.5 grid grid-cols-1 md:grid-cols-[auto_auto] gap-3 items-center justify-end">
        <CompactDelta
          label="Profit/trade"
          cur={m.expectancy}
          base={approved?.metrics.expectancy ?? null}
          suffix="R"
          untested={trades === 0}
        />
        <CompactDelta
          label="Win rate"
          cur={m.winRate * 100}
          base={approved ? approved.metrics.winRate * 100 : null}
          suffix="%"
          untested={trades === 0}
        />
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 pt-3 border-t border-border">
            <FriendlyDeltaMetric label="Avg profit per trade" sub="Expectancy" cur={m.expectancy} base={approved?.metrics.expectancy ?? null} suffix="R" untested={trades === 0} hint="How many R you make on an average trade." />
            <FriendlyDeltaMetric label="How often it wins" sub="Win rate" cur={m.winRate * 100} base={approved ? approved.metrics.winRate * 100 : null} suffix="%" untested={trades === 0} hint="% of trades that closed in profit." />
            <FriendlyDeltaMetric label="Worst losing streak" sub="Max drawdown" cur={m.maxDrawdown * 100} base={approved ? approved.metrics.maxDrawdown * 100 : null} suffix="%" inverse untested={trades === 0} hint="Closer to 0 is better." />
            <FriendlyDeltaMetric label="Smoothness" sub="Sharpe" cur={m.sharpe} base={approved?.metrics.sharpe ?? null} untested={trades === 0} hint="Higher = less rollercoaster." />
            <FriendlyMetric label="Sample size" sub="Trades" value={trades === 0 ? "—" : String(trades)} hint="More trades = more confidence in the numbers." />
          </div>
          {paramDiffs.length > 0 && (
            <div className="rounded-md border border-border bg-secondary/30 p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">What changed</div>
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
          )}
        </div>
      )}
    </div>
  );
}

function CompactDelta({
  label,
  cur,
  base,
  suffix = "",
  untested = false,
}: {
  label: string;
  cur: number;
  base: number | null;
  suffix?: string;
  untested?: boolean;
}) {
  if (untested) {
    return (
      <div className="text-right min-w-[78px]">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm tabular text-muted-foreground">—</div>
      </div>
    );
  }
  if (base == null || !Number.isFinite(base)) {
    return (
      <div className="text-right min-w-[78px]">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="text-sm tabular text-foreground">{cur.toFixed(2)}{suffix}</div>
      </div>
    );
  }
  const delta = cur - base;
  const better = delta > 0;
  const same = delta === 0;
  return (
    <div className="text-right min-w-[78px]">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-sm tabular text-foreground">
        {cur.toFixed(2)}{suffix}{" "}
        <span className={`text-[10px] ${same ? "text-muted-foreground" : better ? "text-status-safe" : "text-status-blocked"}`}>
          ({delta >= 0 ? "+" : ""}{delta.toFixed(2)})
        </span>
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
        <span className="text-muted-foreground truncate">{displayNameFor(s)}</span>
        <span className="text-muted-foreground text-xs font-mono">{s.name} {s.version}</span>
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

/** Plain-English metric tile. */
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

