import { useState } from "react";
import { SectionHeader } from "@/components/trader/SectionHeader";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { AIInsightPanel } from "@/components/trader/AIInsightPanel";
import { MetricCard } from "@/components/trader/MetricCard";
import { EmptyState } from "@/components/trader/EmptyState";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useExperiments, type NewExperimentInput } from "@/hooks/useExperiments";
import type { ExperimentStatus } from "@/lib/domain-types";
import { Brain, Check, FlaskConical, Plus, Play, Trash2, X } from "lucide-react";
import { toast } from "sonner";

const statusTone = {
  queued: "neutral",
  running: "candidate",
  accepted: "safe",
  rejected: "blocked",
} as const;

export default function Learning() {
  const { experiments, loading, create, setStatus, remove } = useExperiments();
  const [newOpen, setNewOpen] = useState(false);

  const queued = experiments.filter((e) => e.status === "queued").length;
  const accepted = experiments.filter((e) => e.status === "accepted").length;
  const rejected = experiments.filter((e) => e.status === "rejected").length;

  return (
    <div className="space-y-6 animate-fade-in">
      <SectionHeader
        eyebrow="Learning"
        title="Controlled optimization"
        description="The bot improves only through explicit, evidence-bound experiments."
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge tone="accent" dot pulse>
              <Brain className="h-3 w-3" /> learning mode active
            </StatusBadge>
            <Button size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Queue experiment
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Experiments queued" value={String(queued)} icon={<FlaskConical className="h-3.5 w-3.5" />} />
        <MetricCard label="Accepted (all-time)" value={String(accepted)} tone="safe" />
        <MetricCard label="Rejected (all-time)" value={String(rejected)} tone="blocked" />
        <MetricCard label="Total run" value={String(experiments.length)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <AIInsightPanel
          className="lg:col-span-2"
          title="Weekly insight"
          body={
            experiments.length === 0
              ? "No experiments yet. Pick one parameter, write a hypothesis, and let the system tell you if it actually moves the needle."
              : `You've run ${experiments.length} experiment${experiments.length === 1 ? "" : "s"}. ${accepted > rejected ? "Edge is improving — keep iterating on what worked." : "Most are getting rejected — that's good. Healthy science kills its darlings."}`
          }
          timestamp="now"
        />
        <div className="panel p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">Acceptance ratio</div>
          <div className="text-3xl font-semibold tabular text-foreground">
            {experiments.length > 0 ? `${Math.round((accepted / experiments.length) * 100)}%` : "—"}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{accepted} of {experiments.length} accepted</p>
        </div>
      </div>

      <div className="panel">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Experiment queue</span>
          <span className="text-xs text-muted-foreground tabular">{experiments.length} total</span>
        </div>
        {loading ? (
          <p className="text-xs text-muted-foreground italic p-6">Loading…</p>
        ) : experiments.length === 0 ? (
          <EmptyState
            icon={<FlaskConical className="h-5 w-5" />}
            title="No experiments — yet"
            description="Pick a parameter, set before/after, queue it. Science wins over vibes."
            action={<Button size="sm" onClick={() => setNewOpen(true)}>Queue your first</Button>}
            className="border-0 bg-transparent"
          />
        ) : (
          <div className="divide-y divide-border">
            {experiments.map((e) => (
              <div key={e.id} className="px-4 py-3 flex items-center gap-3 flex-wrap group">
                <StatusBadge tone={statusTone[e.status]} size="sm" dot>{e.status}</StatusBadge>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">{e.title}</div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {e.parameter}: <span className="text-foreground/80">{e.before}</span> → <span className="text-primary">{e.after}</span>{" "}
                    {e.delta && <span className="text-muted-foreground">({e.delta})</span>}
                  </div>
                  {e.notes && <div className="text-xs text-muted-foreground italic mt-0.5">{e.notes}</div>}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {e.status === "queued" && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={() => setStatus(e.id, "running")}>
                      <Play className="h-3 w-3" /> Start
                    </Button>
                  )}
                  {e.status === "running" && (
                    <>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1 text-status-safe" onClick={() => setStatus(e.id, "accepted")}>
                        <Check className="h-3 w-3" /> Accept
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1 text-status-blocked" onClick={() => setStatus(e.id, "rejected")}>
                        <X className="h-3 w-3" /> Reject
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => remove(e.id).then(() => toast.success("Experiment removed."))}>
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground tabular">
                  {new Date(e.createdAt).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <ExperimentDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onSubmit={async (input) => {
          try {
            await create(input);
            toast.success("Experiment queued.");
            setNewOpen(false);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Couldn't queue");
          }
        }}
      />
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
  const [delta, setDelta] = useState("");
  const [status, setStatus] = useState<ExperimentStatus>("queued");
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
          setDelta("");
          setStatus("queued");
          setNotes("");
        }
        onOpenChange(o);
      }}
    >
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle>Queue experiment</DialogTitle>
          <DialogDescription>One parameter at a time. Hypothesis-driven only.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Tighten min_setup_score" /></Field>
          <Field label="Parameter"><Input value={parameter} onChange={(e) => setParameter(e.target.value)} placeholder="e.g. min_setup_score" /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Before"><Input value={before} onChange={(e) => setBefore(e.target.value)} placeholder="0.65" /></Field>
            <Field label="After"><Input value={after} onChange={(e) => setAfter(e.target.value)} placeholder="0.70" /></Field>
            <Field label="Delta"><Input value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="+0.05" /></Field>
          </div>
          <Field label="Status">
            <Select value={status} onValueChange={(v) => setStatus(v as ExperimentStatus)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="accepted">Accepted</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="optional hypothesis" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => {
              if (!title.trim() || !parameter.trim()) return toast.error("Title and parameter required.");
              onSubmit({ title, parameter, before, after, delta, status, notes });
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
