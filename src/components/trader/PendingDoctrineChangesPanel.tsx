// ============================================================
// PendingDoctrineChangesPanel — shows doctrine changes that have
// been requested but are still inside the 24h cooldown. Each row
// has a live "activates in Xh Ym" countdown and a Cancel button.
// ============================================================
import { useEffect, useState } from "react";
import { Clock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePendingDoctrineChanges, type PendingDoctrineChange } from "@/hooks/usePendingDoctrineChanges";
import { DOCTRINE_FIELD_LABELS, type DoctrineField } from "@/lib/doctrine-resolver";
import { toast } from "sonner";

export function PendingDoctrineChangesPanel() {
  const { pending, cancel } = usePendingDoctrineChanges();
  if (pending.length === 0) return null;

  return (
    <div className="panel p-4 border-status-caution/30 space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-status-caution" />
        <span className="text-sm font-semibold text-foreground">
          Pending doctrine changes · {pending.length}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          24h tilt protection
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        These loosen risk and activate after their cooldown. You can cancel any of them before they go live.
      </p>
      <div className="space-y-2">
        {pending.map((p) => (
          <PendingRow
            key={p.id}
            change={p}
            onCancel={async () => {
              try {
                await cancel(p.id);
                toast.success("Pending change cancelled.");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Couldn't cancel.");
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function PendingRow({ change, onCancel }: { change: PendingDoctrineChange; onCancel: () => void }) {
  const label = DOCTRINE_FIELD_LABELS[change.field as DoctrineField] ?? change.field;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const remaining = new Date(change.effectiveAt).getTime() - now;
  const countdown = formatRemaining(remaining);

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-secondary/40 border border-border">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{label}</div>
        <div className="text-[11px] text-muted-foreground tabular">
          {formatValue(change.field, change.fromValue ?? 0)} → {formatValue(change.field, change.toValue)}
          <span className="ml-2">· activates in {countdown}</span>
        </div>
        {change.reason && (
          <div className="text-[10px] text-muted-foreground italic mt-0.5">"{change.reason}"</div>
        )}
      </div>
      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onCancel}>
        <X className="h-3 w-3 mr-1" />
        Cancel
      </Button>
    </div>
  );
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "any moment";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatValue(field: string, v: number): string {
  if (field.endsWith("_pct")) return `${(v * 100).toFixed(2)}%`;
  if (field === "max_order_abs_cap") return `$${v.toFixed(2)}`;
  return String(v);
}
