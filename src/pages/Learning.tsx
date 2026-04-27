import { useEffect, useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useExperiments, type NewExperimentInput } from "@/hooks/useExperiments";
import type { Experiment, CopilotMemoryRow, StrategyMetrics, ExperimentBacktestResult } from "@/lib/domain-types";
import { supabase } from "@/integrations/supabase/client";
import { Brain, Check, ChevronDown, FlaskConical, GraduationCap, MoreHorizontal, Plus, Sparkles, Trash2, X, Rocket, AlertTriangle, Scale, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type KatrinaReview = {
  brief_text: string;
  reviewed_at: string;
  win_rate_trend: "improving" | "stable" | "declining" | null;
  trades_analyzed: number;
  promote_ids: string[] | null;
  kill_ids: string[] | null;
  continue_ids: string[] | null;
};

const statusTone: Record<Experiment["status"], "neutral" | "candidate" | "safe" | "blocked" | "caution"> = {
  queued: "neutral",
  running: "candidate",
  accepted: "safe",
  rejected: "blocked",
  needs_review: "caution",
};

const memOutcomeTone: Record<CopilotMemoryRow["outcome"], "safe" | "blocked" | "neutral"> = {
  accepted: "safe",
  rejected: "blocked",
  noise: "neutral",
};

export default function Learning() {
  const {
    loading, create, setStatus, remove, promoteToStrategy,
    counts, needsReview, inFlight, accepted, promoted, recentlyAutoResolved,
    memory, memoryCount, clearMemory,
  } = useExperiments();
  const [newOpen, setNewOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showPromoted, setShowPromoted] = useState(false);
  const [katrinaReview, setKatrinaReview] = useState<KatrinaReview | null>(null);
  const [katrinaRunning, setKatrinaRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("strategy_reviews")
      .select("brief_text, reviewed_at, win_rate_trend, trades_analyzed, promote_ids, kill_ids, continue_ids")
      .order("reviewed_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setKatrinaReview(data as KatrinaReview);
      });
    return () => { cancelled = true; };
  }, []);

  const runKatrinaNow = async () => {
    if (katrinaRunning) return;
    setKatrinaRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("katrina", {
        body: { trigger: "manual" },
      });
      if (error) throw error;
      if (data?.skipped) {
        toast.info(data.reason ?? "Not enough trades yet for a review.");
      } else if (data?.error) {
        toast.error(data.error);
      } else {
        toast.success("Katrina updated her review.");
        const { data: fresh } = await supabase
          .from("strategy_reviews")
          .select("brief_text, reviewed_at, win_rate_trend, trades_analyzed, promote_ids, kill_ids, continue_ids")
          .order("reviewed_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (fresh) setKatrinaReview(fresh as KatrinaReview);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not run Katrina.");
    } finally {
      setKatrinaRunning(false);
    }
  };

  const heroLine = (() => {
    const bits: string[] = [];
    if (inFlight.length > 0) bits.push(`Running ${inFlight.length}`);
    if (counts.needsReview > 0) bits.push(`${counts.needsReview} need${counts.needsReview === 1 ? "s" : ""} your call`);
    if (counts.autoResolved > 0) bits.push(`${counts.autoResolved} auto-resolved`);
    return bits.length > 0 ? bits.join(" · ") : "Idle. Copilot will propose something on its next pass.";
  })();

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Learning · Copilot R&D"
        title="The lab runs itself"
        description="Copilot proposes parameter tweaks, backtests them, remembers what worked, and only bothers you when the numbers don't shout."
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge tone="accent" dot pulse>
              <Brain className="h-3 w-3" /> learning mode active
            </StatusBadge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-popover border-border">
                <DropdownMenuItem onClick={() => setNewOpen(true)} className="gap-2 cursor-pointer">
                  <Plus className="h-3.5 w-3.5" /> Suggest experiment manually
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      {/* HERO */}
      <div className="panel p-5 bg-gradient-to-br from-primary/5 via-card to-card border-primary/20">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3 min-w-0">
            <div className="h-10 w-10 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">Copilot R&D</div>
              <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed max-w-xl">
                {heroLine}. Backtests run silently every 15 minutes. Clear winners and losers self-resolve — borderline cases land in your review pile below.
              </p>
            </div>
          </div>
          <div className="flex gap-3 text-right shrink-0">
            <CountStat label="Running" value={inFlight.length} />
            <CountStat label="Needs you" value={counts.needsReview} tone="caution" />
            <CountStat label="Accepted" value={counts.accepted} tone="safe" />
            <CountStat label="Rejected" value={counts.rejected} tone="blocked" />
            <CountStat label="Learned" value={memoryCount} tone="accent" />
          </div>
        </div>
      </div>

      {/* KATRINA — Strategy Review */}
      <KatrinaPanel review={katrinaReview} onRun={runKatrinaNow} running={katrinaRunning} />

      {/* NEEDS REVIEW */}
      {needsReview.length > 0 && (
        <div className="panel">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-status-caution font-semibold">Needs your call</span>
              <StatusBadge tone="caution" size="sm">{needsReview.length}</StatusBadge>
            </div>
            <span className="text-xs text-muted-foreground">Borderline backtests — your judgement, not the machine's.</span>
          </div>
          <div className="divide-y divide-border">
            {needsReview.map((e) => (
              <ExperimentRow key={e.id} exp={e}
                onAccept={() => setStatus(e.id, "accepted").then(() => toast.success("Accepted."))}
                onReject={() => setStatus(e.id, "rejected").then(() => toast.success("Rejected."))}
                onPromote={() => promoteToStrategy(e.id).then((v) => toast.success(`Promoted as candidate ${v}`)).catch((err) => toast.error(err.message))}
                onRemove={() => remove(e.id).then(() => toast.success("Removed."))}
              />
            ))}
          </div>
        </div>
      )}

      {/* COPILOT MEMORY — what the AI has learned, collapsed by default */}
      <Collapsible open={showMemory} onOpenChange={setShowMemory}>
        <div className="panel">
          <CollapsibleTrigger asChild>
            <button className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-accent/40 transition-colors">
              <div className="flex items-center gap-2">
                <Brain className="h-3.5 w-3.5 text-primary" />
                <span className="text-[11px] uppercase tracking-wider text-foreground font-semibold">Copilot memory</span>
                <StatusBadge tone="accent" size="sm">{memoryCount}</StatusBadge>
              </div>
              <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", showMemory && "rotate-180")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {memory.length === 0 ? (
              <p className="text-xs text-muted-foreground italic p-6 text-center">
                Empty. Copilot hasn't tried anything yet — the first proposal hasn't run a backtest.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-4 py-2 font-medium">Parameter</th>
                      <th className="text-left px-2 py-2 font-medium">Symbol</th>
                      <th className="text-left px-2 py-2 font-medium">Direction</th>
                      <th className="text-right px-2 py-2 font-medium">Tries</th>
                      <th className="text-left px-2 py-2 font-medium">Last outcome</th>
                      <th className="text-right px-2 py-2 font-medium">Exp Δ</th>
                      <th className="text-left px-2 py-2 font-medium">Cooldown until</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {memory.map((m) => {
                      const onCooldown = m.retryAfter && new Date(m.retryAfter) > new Date();
                      return (
                        <tr key={m.id} className="hover:bg-accent/20">
                          <td className="px-4 py-2 font-mono text-foreground">{m.parameter}</td>
                          <td className="px-2 py-2">
                            <StatusBadge tone="neutral" size="sm">{m.symbol}</StatusBadge>
                          </td>
                          <td className="px-2 py-2 text-muted-foreground capitalize">{m.direction}</td>
                          <td className="px-2 py-2 text-right tabular text-foreground">{m.attemptCount}</td>
                          <td className="px-2 py-2">
                            <StatusBadge tone={memOutcomeTone[m.outcome]} size="sm">{m.outcome}</StatusBadge>
                          </td>
                          <td className={cn("px-2 py-2 text-right tabular", (m.expDelta ?? 0) > 0 ? "text-status-safe" : (m.expDelta ?? 0) < 0 ? "text-status-blocked" : "text-muted-foreground")}>
                            {m.expDelta != null ? `${m.expDelta >= 0 ? "+" : ""}${m.expDelta.toFixed(3)}R` : "—"}
                          </td>
                          <td className="px-2 py-2 tabular text-muted-foreground">
                            {onCooldown ? new Date(m.retryAfter!).toLocaleDateString() : <span className="text-status-safe">free</span>}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-muted-foreground hover:text-status-blocked"
                              onClick={() => clearMemory(m.parameter).then(() => toast.success(`Memory cleared for ${m.parameter}`))}>
                              Clear
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* IN FLIGHT */}
      {inFlight.length > 0 && (
        <div className="panel">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">In flight</span>
            <span className="text-xs text-muted-foreground tabular">{inFlight.length}</span>
          </div>
          <div className="divide-y divide-border">
            {inFlight.map((e) => (
              <ExperimentRow key={e.id} exp={e}
                onRemove={() => remove(e.id).then(() => toast.success("Removed."))}
              />
            ))}
          </div>
        </div>
      )}

      {/* ACCEPTED */}
      {accepted.length > 0 && (
        <div className="panel">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-status-safe font-semibold">Accepted · ready to ship</span>
              <StatusBadge tone="safe" size="sm">{accepted.length}</StatusBadge>
            </div>
            <span className="text-xs text-muted-foreground">Promote to spin up a candidate strategy version.</span>
          </div>
          <div className="divide-y divide-border">
            {accepted.map((e) => (
              <ExperimentRow key={e.id} exp={e} showChecklist
                onPromote={() => promoteToStrategy(e.id).then((v) => toast.success(`Promoted as candidate ${v}`)).catch((err) => toast.error(err.message))}
                onRemove={() => remove(e.id).then(() => toast.success("Removed."))}
              />
            ))}
          </div>
        </div>
      )}

      {/* PROMOTED — already shipped as a candidate strategy version */}
      {promoted.length > 0 && (
        <Collapsible open={showPromoted} onOpenChange={setShowPromoted}>
          <div className="panel">
            <CollapsibleTrigger asChild>
              <button className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-accent/40 transition-colors">
                <div className="flex items-center gap-2">
                  <Rocket className="h-3.5 w-3.5 text-primary" />
                  <span className="text-[11px] uppercase tracking-wider text-primary font-semibold">Promoted to candidate</span>
                  <StatusBadge tone="accent" size="sm">{promoted.length}</StatusBadge>
                </div>
                <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", showPromoted && "rotate-180")} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="divide-y divide-border">
                {promoted.map((e) => (
                  <ExperimentRow key={e.id} exp={e} isPromoted
                    onRemove={() => remove(e.id).then(() => toast.success("Removed."))}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}

      {/* AUTO-RESOLVED */}
      <Collapsible open={showResolved} onOpenChange={setShowResolved}>
        <div className="panel">
          <CollapsibleTrigger asChild>
            <button className="w-full px-4 py-3 border-b border-border flex items-center justify-between hover:bg-accent/40 transition-colors">
              <div className="flex items-center gap-2">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Recently auto-resolved</span>
                <span className="text-xs text-muted-foreground tabular">{recentlyAutoResolved.length}</span>
              </div>
              <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", showResolved && "rotate-180")} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {loading ? (
              <p className="text-xs text-muted-foreground italic p-6">Loading…</p>
            ) : recentlyAutoResolved.length === 0 ? (
              <p className="text-xs text-muted-foreground italic p-6 text-center">Nothing settled by the machine yet. Patience.</p>
            ) : (
              <div className="divide-y divide-border">
                {recentlyAutoResolved.map((e) => (
                  <ExperimentRow key={e.id} exp={e}
                    onPromote={e.status === "accepted" ? () => promoteToStrategy(e.id).then((v) => toast.success(`Promoted as candidate ${v}`)).catch((err) => toast.error(err.message)) : undefined}
                    onRemove={() => remove(e.id).then(() => toast.success("Removed."))}
                  />
                ))}
              </div>
            )}
          </CollapsibleContent>
        </div>
      </Collapsible>

      {!loading && inFlight.length === 0 && needsReview.length === 0 && recentlyAutoResolved.length === 0 && memoryCount === 0 && (
        <div className="panel p-8 text-center">
          <div className="h-12 w-12 rounded-md bg-secondary text-muted-foreground flex items-center justify-center mx-auto mb-3">
            <FlaskConical className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-foreground">Nothing in the lab yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Copilot proposes experiments every few hours once you've got an approved strategy and a few closed trades for it to learn from. Or queue one yourself from the menu above.
          </p>
        </div>
      )}

      <ExperimentDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onSubmit={async (input) => {
          try {
            await create(input);
            toast.success("Experiment queued. Copilot will backtest it shortly.");
            setNewOpen(false);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't queue");
          }
        }}
      />
    </div>
  );
}

function CountStat({ label, value, tone }: { label: string; value: number; tone?: "safe" | "caution" | "blocked" | "accent" }) {
  const toneClass = tone === "safe" ? "text-status-safe" : tone === "caution" ? "text-status-caution" : tone === "blocked" ? "text-status-blocked" : tone === "accent" ? "text-primary" : "text-foreground";
  return (
    <div>
      <div className={cn("text-2xl font-semibold tabular leading-none", toneClass)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function ExperimentRow({
  exp,
  onAccept,
  onReject,
  onPromote,
  onRemove,
  showChecklist,
  isPromoted,
}: {
  exp: Experiment;
  onAccept?: () => void;
  onReject?: () => void;
  onPromote?: () => void;
  onRemove?: () => void;
  showChecklist?: boolean;
  isPromoted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isCopilot = exp.proposedBy === "copilot";
  const isCoach = exp.proposedBy === "coach";
  const bt = exp.backtestResult;

  return (
    <div className="px-4 py-3 group">
      <div className="flex items-center gap-3 flex-wrap">
        <StatusBadge tone={statusTone[exp.status]} size="sm" dot>{exp.status.replace("_", " ")}</StatusBadge>
        {isPromoted && (
          <StatusBadge tone="accent" size="sm">
            <Rocket className="h-2.5 w-2.5" /> promoted
          </StatusBadge>
        )}
        {isCopilot && (
          <StatusBadge tone="accent" size="sm">
            <Sparkles className="h-2.5 w-2.5" /> copilot
          </StatusBadge>
        )}
        {isCoach && (
          <StatusBadge tone="accent" size="sm">
            <GraduationCap className="h-2.5 w-2.5" /> coach
          </StatusBadge>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{exp.title}</div>
          <div className="text-xs text-muted-foreground font-mono">
            {exp.parameter}: <span className="text-foreground/80">{exp.before}</span> → <span className="text-primary">{exp.after}</span>{" "}
            {exp.delta && <span className="text-muted-foreground">({exp.delta})</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {onAccept && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1 text-status-safe" onClick={onAccept}>
              <Check className="h-3 w-3" /> Accept
            </Button>
          )}
          {onReject && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1 text-status-blocked" onClick={onReject}>
              <X className="h-3 w-3" /> Reject
            </Button>
          )}
          {onPromote && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1 text-primary" onClick={onPromote}>
              <Rocket className="h-3 w-3" /> Promote
            </Button>
          )}
          {onRemove && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={onRemove}>
              <Trash2 className="h-3 w-3 text-muted-foreground" />
            </Button>
          )}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground tabular shrink-0">
          {new Date(exp.createdAt).toLocaleDateString()}
        </span>
      </div>

      {(exp.hypothesis || bt || exp.notes) && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <button className="text-[11px] text-muted-foreground hover:text-foreground transition-colors mt-2 inline-flex items-center gap-1">
              <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
              {isCopilot ? "Why Copilot tried this" : "Details"}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 ml-4 space-y-3 text-xs border-l-2 border-border pl-3">
              {exp.hypothesis && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Hypothesis</div>
                  <p className="text-foreground/90 leading-relaxed whitespace-pre-wrap">{exp.hypothesis}</p>
                </div>
              )}
              {exp.notes && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Notes</div>
                  <p className="text-foreground/90 italic">{exp.notes}</p>
                </div>
              )}
              {bt && !bt.error && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Backtest</div>
                  <div className="grid grid-cols-2 gap-3 font-mono">
                    <BacktestSide label="Before" m={bt.before.metrics} />
                    <BacktestSide label="After" m={bt.after.metrics} />
                  </div>
                  {bt.outOfSample && <OutOfSampleRow oos={bt.outOfSample} />}
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Sample: {bt.significantSample ? "✓ enough trades" : "× not enough trades"} · Delta: {bt.significantDelta ? "✓ above noise" : "× within noise"} · {bt.candleCount} candles
                  </p>
                </div>
              )}
              {showChecklist && bt && !bt.error && <PromotionChecklist bt={bt} />}
              {bt?.error && <p className="text-xs text-status-blocked italic">Backtest error: {bt.error}</p>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function BacktestSide({ label, m }: { label: string; m: StrategyMetrics }) {
  return (
    <div className="text-[11px] space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div>exp <span className="text-foreground tabular">{m.expectancy.toFixed(3)}R</span></div>
      <div>win <span className="text-foreground tabular">{(m.winRate * 100).toFixed(1)}%</span></div>
      <div>sharpe <span className="text-foreground tabular">{m.sharpe.toFixed(2)}</span></div>
      <div>maxDD <span className="text-foreground tabular">{(m.maxDrawdown * 100).toFixed(1)}%</span></div>
      {m.profitFactor != null && <div>PF <span className="text-foreground tabular">{m.profitFactor === 999 ? "∞" : m.profitFactor.toFixed(2)}</span></div>}
      {m.avgWin != null && <div>avg win <span className="text-foreground tabular">{m.avgWin.toFixed(2)}R</span></div>}
      {m.avgLoss != null && <div>avg loss <span className="text-foreground tabular">{m.avgLoss.toFixed(2)}R</span></div>}
      <div>n <span className="text-foreground tabular">{m.trades}</span></div>
    </div>
  );
}

function OutOfSampleRow({ oos }: { oos: NonNullable<ExperimentBacktestResult["outOfSample"]> }) {
  const positive = oos.expDelta > 0;
  const cautionFlag = oos.expDelta < 0;
  return (
    <div className={cn(
      "mt-2 rounded-md border px-2.5 py-1.5 flex items-center justify-between gap-3",
      cautionFlag ? "border-status-caution/30 bg-status-caution/5" : "border-border bg-muted/20",
    )}>
      <div className="flex items-center gap-1.5">
        {cautionFlag && <AlertTriangle className="h-3 w-3 text-status-caution" />}
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Out-of-sample check</span>
      </div>
      <div className="text-[11px] tabular font-mono">
        <span className={positive ? "text-status-safe" : cautionFlag ? "text-status-caution" : "text-muted-foreground"}>
          exp Δ {oos.expDelta >= 0 ? "+" : ""}{oos.expDelta.toFixed(3)}R
        </span>
        <span className="text-muted-foreground"> · {oos.candleCount} candles</span>
      </div>
    </div>
  );
}

function PromotionChecklist({ bt }: { bt: ExperimentBacktestResult }) {
  const after = bt.after.metrics;
  const items = [
    { label: "In-sample expectancy delta ≥ 0.05R", pass: (bt.deltas?.expectancy ?? 0) >= 0.05 },
    { label: "Out-of-sample delta positive", pass: (bt.outOfSample?.expDelta ?? 0) > 0 },
    { label: "Max drawdown stable or improved", pass: !bt.drawdownWorsened },
    { label: "Profit factor ≥ 1.0 after change", pass: (after.profitFactor ?? 0) >= 1 },
    { label: "Sample size ≥ 30 trades", pass: !!bt.significantSample },
  ];
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Promotion checklist</div>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <li key={it.label} className={cn("flex items-center gap-2 text-[11px]", it.pass ? "text-status-safe" : "text-status-caution")}>
            {it.pass ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            <span className={it.pass ? "text-foreground/80" : "text-muted-foreground"}>{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExperimentDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (input: NewExperimentInput) => void;
}) {
  const [title, setTitle] = useState("");
  const [parameter, setParameter] = useState("");
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setTitle(""); setParameter(""); setBefore(""); setAfter(""); setNotes("");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle>Suggest an experiment</DialogTitle>
          <DialogDescription>
            One numeric parameter at a time. Copilot will backtest it on the next run-experiment pass.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Tighten stop_atr_mult" /></Field>
          <Field label="Parameter"><Input value={parameter} onChange={(e) => setParameter(e.target.value)} placeholder="e.g. stop_atr_mult" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Before"><Input value={before} onChange={(e) => setBefore(e.target.value)} placeholder="1.5" /></Field>
            <Field label="After"><Input value={after} onChange={(e) => setAfter(e.target.value)} placeholder="1.3" /></Field>
          </div>
          <Field label="Hypothesis (optional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Why might this help?" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => {
              if (!title.trim() || !parameter.trim()) return toast.error("Title and parameter required.");
              if (!Number.isFinite(Number(before)) || !Number.isFinite(Number(after))) {
                return toast.error("Before & after must be numeric so we can backtest.");
              }
              onSubmit({ title, parameter, before, after, notes });
            }}
          >
            Queue
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

function KatrinaPanel({
  review,
  onRun,
  running,
}: {
  review: KatrinaReview | null;
  onRun: () => void;
  running: boolean;
}) {
  const trend = review?.win_rate_trend ?? "stable";
  const trendIcon = trend === "improving"
    ? <TrendingUp className="h-3 w-3" />
    : trend === "declining"
      ? <TrendingDown className="h-3 w-3" />
      : <Minus className="h-3 w-3" />;
  const trendTone: "safe" | "blocked" | "neutral" =
    trend === "improving" ? "safe" : trend === "declining" ? "blocked" : "neutral";

  const promoteCount = review?.promote_ids?.length ?? 0;
  const killCount = review?.kill_ids?.length ?? 0;
  const continueCount = review?.continue_ids?.length ?? 0;

  return (
    <div className="panel p-5 bg-gradient-to-br from-accent/10 via-card to-card border-accent/20">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="h-10 w-10 rounded-md bg-accent/20 text-foreground flex items-center justify-center shrink-0">
            <Scale className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-foreground">Katrina's Review</span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Strategy Lab</span>
            </div>
            {review ? (
              <>
                <p className="text-sm text-foreground/90 mt-2 leading-relaxed">
                  {review.brief_text}
                </p>
                <div className="flex items-center gap-3 mt-3 flex-wrap text-xs">
                  <StatusBadge tone={trendTone} size="sm">
                    {trendIcon} {trend}
                  </StatusBadge>
                  <span className="text-muted-foreground tabular">
                    {new Date(review.reviewed_at).toLocaleDateString("default", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    {review.trades_analyzed} trade{review.trades_analyzed === 1 ? "" : "s"} analyzed
                  </span>
                  {promoteCount > 0 && (
                    <span className="text-status-safe">↑ {promoteCount} ready to promote</span>
                  )}
                  {killCount > 0 && (
                    <span className="text-status-blocked">✗ {killCount} recommended to close</span>
                  )}
                  {continueCount > 0 && (
                    <span className="text-muted-foreground">→ {continueCount} keep running</span>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed max-w-xl">
                Katrina's first review runs Sunday at 08:00 UTC, or after your 10th closed trade — whichever comes first. You can also run her now if you have at least 3 closed trades in the last 30 days.
              </p>
            )}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onRun} disabled={running} className="shrink-0">
          {running ? "Reviewing…" : review ? "Run new review" : "Run now"}
        </Button>
      </div>
    </div>
  );
}
