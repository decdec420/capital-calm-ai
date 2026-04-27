import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { GuardrailRow } from "@/components/trader/GuardrailRow";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { EmptyState } from "@/components/trader/EmptyState";
import { KillSwitchDialog } from "@/components/trader/KillSwitchDialog";
import { GateReasonList } from "@/components/trader/GateReasonRow";
import { PerTradeStopPanel } from "@/components/trader/PerTradeStopPanel";
import { DoctrineGuardrailGrid } from "@/components/trader/DoctrineGuardrailGrid";
import { ProfilePicker } from "@/components/trader/ProfilePicker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberStepper } from "@/components/trader/NumberStepper";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, ShieldAlert, ShieldCheck, Trash2, X, Zap } from "lucide-react";
import { useGuardrails, type NewGuardrailInput } from "@/hooks/useGuardrails";
import { useSystemState } from "@/hooks/useSystemState";
import type { RiskGuardrail, RiskLevel } from "@/lib/domain-types";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type GuardrailFilter = "all" | "blocked" | "caution";

export default function RiskCenter() {
  const { guardrails, loading, create, update, remove } = useGuardrails();
  const { data: system, update: updateSystem } = useSystemState();
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<RiskGuardrail | null>(null);
  const [killOpen, setKillOpen] = useState(false);
  const [filter, setFilter] = useState<GuardrailFilter>("all");

  const blocked = guardrails.filter((g) => g.level === "blocked").length;
  const caution = guardrails.filter((g) => g.level === "caution").length;
  const snapshot = system?.lastEngineSnapshot ?? null;
  const lastGateReasons = snapshot?.gateReasons ?? [];

  const filtered =
    filter === "all"
      ? guardrails
      : guardrails.filter((g) => g.level === filter);

  const confirmKill = async () => {
    if (!system) return;
    try {
      await updateSystem({
        killSwitchEngaged: !system.killSwitchEngaged,
        bot: !system.killSwitchEngaged ? "halted" : "paused",
      });
      toast.success(system.killSwitchEngaged ? "Kill-switch disarmed." : "Kill-switch ENGAGED. Bot halted.");
    } catch {
      toast.error("Couldn't toggle kill-switch.");
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Risk Control"
        title="Guardrails & kill-switches"
        description="Capital preservation by default. Live trading is dangerous and explicitly gated."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Add annotation
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-status-blocked border-status-blocked/40 hover:bg-status-blocked/10 hover:text-status-blocked"
              onClick={() => setKillOpen(true)}
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              {system?.killSwitchEngaged ? "Disarm kill-switch" : "Engage kill-switch"}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <button
          type="button"
          onClick={() => setFilter("all")}
          aria-pressed={filter === "all"}
          className={cn(
            "panel p-4 flex items-center gap-3 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            filter === "all" && "border-primary/60 ring-1 ring-primary/30",
          )}
        >
          <div className={`h-10 w-10 rounded-md flex items-center justify-center ${blocked > 0 ? "bg-status-blocked/15 text-status-blocked" : "bg-status-safe/15 text-status-safe"}`}>
            {blocked > 0 ? <ShieldAlert className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Overall posture</div>
            <div className="text-base font-semibold text-foreground">
              {blocked > 0 ? "Active blockers" : caution > 0 ? "Watch close" : "Capital protected"}
            </div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setFilter(filter === "blocked" ? "all" : "blocked")}
          aria-pressed={filter === "blocked"}
          disabled={blocked === 0}
          className={cn(
            "panel p-4 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
            "hover:border-status-blocked/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-blocked/40",
            filter === "blocked" && "border-status-blocked/60 ring-1 ring-status-blocked/40",
          )}
        >
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Blocked checks</div>
          <div className="text-2xl font-semibold tabular text-status-blocked">{blocked}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mt-1">
            {filter === "blocked" ? "filter active · click to clear" : blocked > 0 ? "click to filter" : "—"}
          </div>
        </button>
        <button
          type="button"
          onClick={() => setFilter(filter === "caution" ? "all" : "caution")}
          aria-pressed={filter === "caution"}
          disabled={caution === 0}
          className={cn(
            "panel p-4 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
            "hover:border-status-caution/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-status-caution/40",
            filter === "caution" && "border-status-caution/60 ring-1 ring-status-caution/40",
          )}
        >
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Caution checks</div>
          <div className="text-2xl font-semibold tabular text-status-caution">{caution}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mt-1">
            {filter === "caution" ? "filter active · click to clear" : caution > 0 ? "click to filter" : "—"}
          </div>
        </button>
      </div>

      {/* Trading profile — sets how aggressive Max can be */}
      <div className="panel p-5">
        <ProfilePicker />
      </div>

      {/* Per-trade auto-sell — answers "when does the bot bail out?" */}
      <PerTradeStopPanel />

      {/* Live engine gates from the last tick — not user-defined guardrails. */}
      <div className="panel p-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">
            Engine gates · last tick
          </span>
          {snapshot && (
            <span className="text-[10px] text-muted-foreground tabular">
              {new Date(snapshot.ranAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        {!snapshot ? (
          <p className="text-xs text-muted-foreground italic">
            No engine snapshot yet. Run the engine from the Copilot page.
          </p>
        ) : lastGateReasons.length === 0 ? (
          <p className="text-xs text-status-safe italic">All clear — engine has nothing blocking it right now.</p>
        ) : (
          <GateReasonList reasons={lastGateReasons} />
        )}
      </div>

      {/* Doctrine source-of-truth: derived live from doctrine + account + trades. */}
      <DoctrineGuardrailGrid />

      {loading ? (
        <p className="text-xs text-muted-foreground italic">Loading…</p>
      ) : guardrails.length === 0 ? null : (
        <div>
          <div className="flex items-end justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                Custom annotations · {filtered.length}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Display-only guardrails for ops awareness. The engine does <span className="text-foreground/80">not</span> read these — see Doctrine guardrails above for what's actually enforced.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {filter !== "all" && (
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                >
                  Clear filter <X className="h-3 w-3" />
                </button>
              )}
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {filter === "all" ? "all" : filter}
              </span>
            </div>
          </div>
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No custom guardrails match this filter.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filtered.map((g) => (
                <div key={g.id} className="relative group">
                  <button type="button" onClick={() => setEditing(g)} className="w-full text-left">
                    <GuardrailRow guardrail={g} />
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-3 right-3 h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(g.id).then(() => toast.success("Annotation removed."));
                    }}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <EventModePanel />

      <div className="panel p-5 space-y-3 border-status-blocked/30">
        <div className="flex items-center gap-2">
          <StatusBadge tone={system?.liveTradingEnabled ? "safe" : "blocked"} dot>
            live trading gate
          </StatusBadge>
          <span className="text-sm font-medium text-foreground">
            {system?.liveTradingEnabled ? "Armed (use with discipline)" : "Currently blocked"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Toggling live mode requires every guardrail to pass and explicit operator confirmation. This control lives in Settings → Bot controls.
        </p>
      </div>

      <GuardrailDialog
        open={newOpen || !!editing}
        guardrail={editing ?? undefined}
        onOpenChange={(o) => {
          if (!o) {
            setNewOpen(false);
            setEditing(null);
          }
        }}
        onSubmit={async (input) => {
          try {
            if (editing) await update(editing.id, input);
            else await create(input);
            toast.success(editing ? "Guardrail updated." : "Guardrail added.");
            setNewOpen(false);
            setEditing(null);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't save guardrail");
          }
        }}
      />

      <KillSwitchDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        engaged={!!system?.killSwitchEngaged}
        onConfirm={confirmKill}
      />
    </div>
  );
}

function GuardrailDialog({
  open,
  onOpenChange,
  guardrail,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  guardrail?: RiskGuardrail;
  onSubmit: (input: NewGuardrailInput) => void;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [current, setCurrent] = useState("");
  const [limit, setLimit] = useState("");
  const [level, setLevel] = useState<RiskLevel>("safe");
  const [utilization, setUtilization] = useState("0");

  useState(() => {
    if (guardrail) {
      setLabel(guardrail.label);
      setDescription(guardrail.description);
      setCurrent(guardrail.current);
      setLimit(guardrail.limit);
      setLevel(guardrail.level);
      setUtilization(String(guardrail.utilization));
    }
    return undefined;
  });

  // Sync when guardrail changes
  if (guardrail && label === "" && guardrail.label !== "") {
    setLabel(guardrail.label);
    setDescription(guardrail.description);
    setCurrent(guardrail.current);
    setLimit(guardrail.limit);
    setLevel(guardrail.level);
    setUtilization(String(guardrail.utilization));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setLabel("");
          setDescription("");
          setCurrent("");
          setLimit("");
          setLevel("safe");
          setUtilization("0");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle>{guardrail ? "Edit guardrail" : "New guardrail"}</DialogTitle>
          <DialogDescription>Set the rule and the current value. Utilization is 0 → 1 (e.g. 0.42 = 42% used).</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Max order size" /></Field>
          <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Current"><Input value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="0.18%" /></Field>
            <Field label="Limit"><Input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="0.25%" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Level">
              <Select value={level} onValueChange={(v) => setLevel(v as RiskLevel)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="safe">Safe</SelectItem>
                  <SelectItem value="caution">Caution</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Utilization (0–1)"><NumberStepper value={utilization} onChange={setUtilization} step={0.05} shiftMultiplier={2} min={0} max={1} precision={2} /></Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => {
              if (!label.trim()) return toast.error("Label required.");
              onSubmit({
                label,
                description,
                current,
                limit,
                level,
                utilization: Number(utilization) || 0,
              });
            }}
          >
            Save
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

function EventModePanel() {
  const { data: system, update } = useSystemState();
  const pausedUntil = system?.tradingPausedUntil ? new Date(system.tradingPausedUntil) : null;
  const active = pausedUntil && pausedUntil > new Date();

  const pauseFor = async (hours: number) => {
    try {
      await update({ tradingPausedUntil: new Date(Date.now() + hours * 3600000).toISOString() });
      toast.success(`Trading paused for ${hours}h.`);
    } catch {
      toast.error("Couldn't pause trading.");
    }
  };

  const resumeNow = async () => {
    try {
      await update({ tradingPausedUntil: null });
      toast.success("Trading resumed.");
    } catch {
      toast.error("Couldn't resume.");
    }
  };

  return (
    <div className="panel p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-status-caution" />
        <span className="text-sm font-semibold text-foreground">Event Mode</span>
        <span className={cn(
          "text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded",
          active ? "bg-status-caution/15 text-status-caution" : "bg-secondary text-muted-foreground"
        )}>
          {active ? "active" : "inactive"}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Pause all new trade proposals around high-impact macro events (FOMC, CPI, Fed speeches).
      </p>
      <div className="flex flex-wrap gap-2">
        {[1, 2, 4, 8, 24].map((h) => (
          <Button key={h} size="sm" variant="outline" onClick={() => pauseFor(h)}>
            Pause {h}h
          </Button>
        ))}
        <Button size="sm" variant="outline" onClick={resumeNow} disabled={!active}>
          Resume Now
        </Button>
      </div>
      {active && pausedUntil && (
        <p className="text-xs text-status-caution">
          Resumes at {pausedUntil.toLocaleString()}
        </p>
      )}
    </div>
  );
}

