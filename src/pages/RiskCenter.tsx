import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { GuardrailRow } from "@/components/trader/GuardrailRow";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { EmptyState } from "@/components/trader/EmptyState";
import { KillSwitchDialog } from "@/components/trader/KillSwitchDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useGuardrails, type NewGuardrailInput } from "@/hooks/useGuardrails";
import { useSystemState } from "@/hooks/useSystemState";
import type { RiskGuardrail, RiskLevel } from "@/lib/domain-types";
import { toast } from "sonner";

export default function RiskCenter() {
  const { guardrails, loading, create, update, remove } = useGuardrails();
  const { data: system, update: updateSystem } = useSystemState();
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<RiskGuardrail | null>(null);
  const [killOpen, setKillOpen] = useState(false);

  const blocked = guardrails.filter((g) => g.level === "blocked").length;
  const caution = guardrails.filter((g) => g.level === "caution").length;

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
              <Plus className="h-3.5 w-3.5" /> Add guardrail
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-status-blocked border-status-blocked/40 hover:bg-status-blocked/10 hover:text-status-blocked"
              onClick={toggleKill}
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              {system?.killSwitchEngaged ? "Disarm kill-switch" : "Engage kill-switch"}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="panel p-4 flex items-center gap-3">
          <div className={`h-10 w-10 rounded-md flex items-center justify-center ${blocked > 0 ? "bg-status-blocked/15 text-status-blocked" : "bg-status-safe/15 text-status-safe"}`}>
            {blocked > 0 ? <ShieldAlert className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Overall posture</div>
            <div className="text-base font-semibold text-foreground">
              {blocked > 0 ? "Active blockers" : caution > 0 ? "Watch close" : "Capital protected"}
            </div>
          </div>
        </div>
        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Blocked checks</div>
          <div className="text-2xl font-semibold tabular text-status-blocked">{blocked}</div>
        </div>
        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Caution checks</div>
          <div className="text-2xl font-semibold tabular text-status-caution">{caution}</div>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground italic">Loading…</p>
      ) : guardrails.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-5 w-5" />}
          title="No guardrails configured"
          description="Add at least a balance floor and a daily loss cap before you start trading."
          action={<Button size="sm" onClick={() => setNewOpen(true)}>Add guardrail</Button>}
        />
      ) : (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">All guardrails</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {guardrails.map((g) => (
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
                    remove(g.id).then(() => toast.success("Guardrail removed."));
                  }}
                >
                  <Trash2 className="h-3 w-3 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

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
          Toggling live mode requires every guardrail to pass and explicit operator confirmation. This control lives in Settings → Mode controls.
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
            <Field label="Utilization (0–1)"><Input type="number" step="0.01" min="0" max="1" value={utilization} onChange={(e) => setUtilization(e.target.value)} /></Field>
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
