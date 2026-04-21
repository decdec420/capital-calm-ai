import { useState } from "react";
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
import type { Experiment } from "@/lib/domain-types";
import { Brain, Check, ChevronDown, FlaskConical, MoreHorizontal, Plus, Sparkles, Trash2, X, Rocket } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const statusTone: Record<Experiment["status"], "neutral" | "candidate" | "safe" | "blocked" | "caution"> = {
  queued: "neutral",
  running: "candidate",
  accepted: "safe",
  rejected: "blocked",
  needs_review: "caution",
};

export default function Learning() {
  const { loading, create, setStatus, remove, promoteToStrategy, counts, needsReview, inFlight, recentlyAutoResolved } = useExperiments();
  const [newOpen, setNewOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

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
        description="Copilot proposes parameter tweaks, backtests them, and only bothers you when the numbers don't shout. You ship what survives."
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

      {/* HERO — what the lab is doing right now */}
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
          </div>
        </div>
      </div>

      {/* NEEDS REVIEW — only when non-empty */}
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
              <ExperimentRow key={e.id} exp={e} onAccept={() => setStatus(e.id, "accepted").then(() => toast.success("Accepted."))}
                onReject={() => setStatus(e.id, "rejected").then(() => toast.success("Rejected."))}
                onPromote={() => promoteToStrategy(e.id).then((v) => toast.success(`Promoted as candidate ${v}`)).catch((err) => toast.error(err.message))}
                onRemove={() => remove(e.id).then(() => toast.success("Removed."))}
              />
            ))}
          </div>
        </div>
      )}

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

      {/* AUTO-RESOLVED — collapsed by default */}
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

      {/* Empty state */}
      {!loading && inFlight.length === 0 && needsReview.length === 0 && recentlyAutoResolved.length === 0 && (
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

function CountStat({ label, value, tone }: { label: string; value: number; tone?: "safe" | "caution" | "blocked" }) {
  const toneClass = tone === "safe" ? "text-status-safe" : tone === "caution" ? "text-status-caution" : tone === "blocked" ? "text-status-blocked" : "text-foreground";
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
}: {
  exp: Experiment;
  onAccept?: () => void;
  onReject?: () => void;
  onPromote?: () => void;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isCopilot = exp.proposedBy === "copilot";
  const bt = exp.backtestResult;

  return (
    <div className="px-4 py-3 group">
      <div className="flex items-center gap-3 flex-wrap">
        <StatusBadge tone={statusTone[exp.status] as any} size="sm" dot>{exp.status.replace("_", " ")}</StatusBadge>
        {isCopilot && (
          <StatusBadge tone="accent" size="sm">
            <Sparkles className="h-2.5 w-2.5" /> copilot
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
            <div className="mt-2 ml-4 space-y-2 text-xs border-l-2 border-border pl-3">
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
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Sample: {bt.significantSample ? "✓ enough trades" : "× not enough trades"} · Delta: {bt.significantDelta ? "✓ above noise" : "× within noise"} · {bt.candleCount} candles
                  </p>
                </div>
              )}
              {bt?.error && <p className="text-xs text-status-blocked italic">Backtest error: {bt.error}</p>}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function BacktestSide({ label, m }: { label: string; m: { expectancy: number; winRate: number; trades: number; sharpe: number; maxDrawdown: number } }) {
  return (
    <div className="text-[11px] space-y-0.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div>exp <span className="text-foreground tabular">{m.expectancy.toFixed(3)}R</span></div>
      <div>win <span className="text-foreground tabular">{(m.winRate * 100).toFixed(1)}%</span></div>
      <div>sharpe <span className="text-foreground tabular">{m.sharpe.toFixed(2)}</span></div>
      <div>maxDD <span className="text-foreground tabular">{(m.maxDrawdown * 100).toFixed(1)}%</span></div>
      <div>n <span className="text-foreground tabular">{m.trades}</span></div>
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
          setTitle("");
          setParameter("");
          setBefore("");
          setAfter("");
          setNotes("");
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
