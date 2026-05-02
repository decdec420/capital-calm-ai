// ============================================================
// DoctrineWindowsPanel — time-of-day rules (UTC) that force a
// tightening mode (calm/choppy/storm/lockout). Useful for
// CPI/FOMC blackouts and weekend slow-modes.
// ============================================================
import { useState } from "react";
import { Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useDoctrineWindows, type DoctrineWindow, type DoctrineWindowInput, type DoctrineMode } from "@/hooks/useDoctrineWindows";
import { toast } from "sonner";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MODE_OPTIONS: { value: DoctrineMode; label: string; desc: string }[] = [
  { value: "choppy",  label: "Choppy",  desc: "70% size, 50% trades" },
  { value: "storm",   label: "Storm",   desc: "40% size, 50% risk" },
  { value: "lockout", label: "Lockout", desc: "no new entries" },
];

function fmtDays(days: number[]): string {
  if (!days || days.length === 0) return "—";
  if (days.length === 7) return "every day";
  if (days.length === 5 && [1,2,3,4,5].every((d) => days.includes(d))) return "weekdays";
  if (days.length === 2 && [0,6].every((d) => days.includes(d))) return "weekends";
  return days.map((d) => DAY_LABELS[d]).join(" ");
}

export function DoctrineWindowsPanel() {
  const { windows, loading, upsert, remove } = useDoctrineWindows();
  const [editing, setEditing] = useState<DoctrineWindow | "new" | null>(null);

  return (
    <div className="panel p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Time windows</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Force a tighter mode during specific UTC time windows — CPI prints, weekend illiquidity, etc.
          </p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing("new")}>
          <Plus className="h-3.5 w-3.5" /> Add window
        </Button>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground italic">Loading…</p>
      ) : windows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No time windows — no time-of-day tightening.</p>
      ) : (
        <div className="space-y-1.5">
          {windows.map((w) => (
            <div key={w.id} className="flex items-center justify-between rounded-md border border-border/60 bg-background/40 px-3 py-2">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${w.enabled ? "bg-status-safe/15 text-status-safe" : "bg-muted text-muted-foreground"}`}>
                  {w.enabled ? "on" : "off"}
                </span>
                <span className="text-sm font-medium text-foreground truncate">{w.label}</span>
                <span className="text-[11px] text-muted-foreground tabular truncate">
                  {fmtDays(w.days)} · {w.start_utc}–{w.end_utc} UTC · → <span className="font-semibold uppercase">{w.mode}</span>
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="ghost" onClick={() => setEditing(w)} aria-label="Edit window">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await remove(w.id);
                      toast.success(`Removed “${w.label}”.`);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Couldn't remove.");
                    }
                  }}
                  aria-label="Delete window"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <WindowDialog
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (input, id) => {
            try {
              await upsert({ ...input, ...(id ? { id } : {}) });
              toast.success("Window saved.");
              setEditing(null);
            } catch (e) {
              toast.error(e instanceof Error ? e.message : "Couldn't save.");
            }
          }}
        />
      )}
    </div>
  );
}

interface DialogProps {
  existing: DoctrineWindow | null;
  onClose: () => void;
  onSave: (input: DoctrineWindowInput, id?: string) => Promise<void>;
}

function WindowDialog({ existing, onClose, onSave }: DialogProps) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [start, setStart] = useState(existing?.start_utc ?? "12:30");
  const [end, setEnd] = useState(existing?.end_utc ?? "14:00");
  const [mode, setMode] = useState<DoctrineMode>(existing?.mode ?? "lockout");
  const [days, setDays] = useState<number[]>(existing?.days ?? [0,1,2,3,4,5,6]);
  const [saving, setSaving] = useState(false);

  const toggleDay = (d: number) => {
    setDays((cur) => cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort());
  };

  const submit = async () => {
    if (!label.trim()) { toast.error("Label is required."); return; }
    if (days.length === 0) { toast.error("Pick at least one day."); return; }
    if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      toast.error("Times must be HH:MM (24h, UTC).");
      return;
    }
    setSaving(true);
    try {
      await onSave(
        { label: label.trim(), enabled, days, start_utc: start, end_utc: end, mode },
        existing?.id,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? `Edit “${existing.label}”` : "New time window"}</DialogTitle>
          <DialogDescription>
            All times are in UTC. The strictest active mode wins if windows overlap.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <div>
              <Label htmlFor="win-label">Label</Label>
              <Input id="win-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. CPI release" />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch checked={enabled} onCheckedChange={setEnabled} id="win-enabled" />
              <Label htmlFor="win-enabled">{enabled ? "On" : "Off"}</Label>
            </div>
          </div>

          <div>
            <Label className="block mb-1.5">Days (UTC)</Label>
            <div className="flex gap-1">
              {DAY_LABELS.map((d, i) => {
                const active = days.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(i)}
                    className={`flex-1 text-[11px] py-1.5 rounded border transition-colors ${
                      active ? "bg-primary/15 text-primary border-primary/40" : "bg-background border-border text-muted-foreground hover:border-border/80"
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="win-start">Start (UTC)</Label>
              <Input id="win-start" value={start} onChange={(e) => setStart(e.target.value)} placeholder="HH:MM" />
            </div>
            <div>
              <Label htmlFor="win-end">End (UTC)</Label>
              <Input id="win-end" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="HH:MM" />
            </div>
          </div>

          <div>
            <Label>Mode while active</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as DoctrineMode)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MODE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <div className="flex flex-col">
                      <span className="font-medium">{opt.label}</span>
                      <span className="text-[10px] text-muted-foreground">{opt.desc}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save window"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
