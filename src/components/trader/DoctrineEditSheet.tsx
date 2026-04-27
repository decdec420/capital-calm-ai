// ============================================================
// DoctrineEditSheet — the editable doctrine surface.
// Each field shows: current value, draft value, derived $ amount,
// and a tag — "Applies instantly" (tightening) or
// "Activates in 24h" (loosening). All changes route through the
// update-doctrine edge function.
// ============================================================
import { useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useDoctrineSettings } from "@/hooks/useDoctrineSettings";
import { useAccountState } from "@/hooks/useAccountState";
import {
  isLoosening,
  resolveDoctrine,
  DOCTRINE_FIELD_LABELS,
  type DoctrineField,
  type DoctrineSettingsRow,
} from "@/lib/doctrine-resolver";
import { supabase } from "@/integrations/supabase/client";
import { formatUsd } from "@/lib/utils";
import { Clock, Zap, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Optional field to focus (scrolls into view) */
  focusField?: DoctrineField;
}

interface DraftRow {
  field: DoctrineField;
  current: number;
  draft: number;
}

const EDITABLE_FIELDS: DoctrineField[] = [
  "max_order_pct",
  "max_order_abs_cap",
  "daily_loss_pct",
  "max_trades_per_day",
  "floor_pct",
  "risk_per_trade_pct",
  "consecutive_loss_limit",
  "loss_cooldown_minutes",
];

export function DoctrineEditSheet({ open, onOpenChange, focusField }: Props) {
  const { settings, refetch } = useDoctrineSettings();
  const { data: account } = useAccountState();
  const equity = account?.equity ?? 0;

  const [drafts, setDrafts] = useState<Record<DoctrineField, number>>({} as Record<DoctrineField, number>);
  const [startingEquityDraft, setStartingEquityDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Reset drafts whenever the sheet opens
  useEffect(() => {
    if (open && settings) {
      const next = {} as Record<DoctrineField, number>;
      for (const f of EDITABLE_FIELDS) next[f] = Number((settings as unknown as Record<string, unknown>)[f] ?? 0);
      setDrafts(next);
      setStartingEquityDraft(settings.starting_equity_usd?.toString() ?? "");
    }
  }, [open, settings]);

  const draftRows: DraftRow[] = useMemo(() => {
    if (!settings) return [];
    return EDITABLE_FIELDS.map((f) => ({
      field: f,
      current: Number((settings as unknown as Record<string, unknown>)[f] ?? 0),
      draft: drafts[f] ?? 0,
    }));
  }, [drafts, settings]);

  // Live preview: what would the resolved doctrine look like with these drafts applied?
  const previewSettings: DoctrineSettingsRow | null = useMemo(() => {
    if (!settings) return null;
    const startingEquity = Number(startingEquityDraft);
    return {
      ...settings,
      ...drafts,
      starting_equity_usd: Number.isFinite(startingEquity) && startingEquity > 0 ? startingEquity : settings.starting_equity_usd,
    };
  }, [settings, drafts, startingEquityDraft]);
  const previewResolved = useMemo(() => previewSettings ? resolveDoctrine(previewSettings, equity) : null, [previewSettings, equity]);

  const changes = draftRows.filter((r) => r.current !== r.draft);
  const tighten = changes.filter((r) => !isLoosening(r.field, r.current, r.draft));
  const loosen = changes.filter((r) => isLoosening(r.field, r.current, r.draft));
  const startingEquityChanged =
    Number(startingEquityDraft) > 0 && Number(startingEquityDraft) !== settings?.starting_equity_usd;

  const handleSave = async () => {
    if (changes.length === 0 && !startingEquityChanged) {
      toast.info("No changes to save.");
      return;
    }
    setSaving(true);
    try {
      const { data: sessionRes } = await supabase.auth.getSession();
      const token = sessionRes?.session?.access_token;
      if (!token) throw new Error("Not signed in.");

      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
      const res = await fetch(`${SUPABASE_URL}/functions/v1/update-doctrine`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          changes: changes.map((c) => ({ field: c.field, to_value: c.draft })),
          ...(startingEquityChanged ? { starting_equity_usd: Number(startingEquityDraft) } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "update failed");

      const instantCount = body.results?.filter((r: { applied: string }) => r.applied === "instant").length ?? 0;
      const pendingCount = body.results?.filter((r: { applied: string }) => r.applied === "pending").length ?? 0;
      let msg = "Doctrine updated.";
      if (instantCount > 0 && pendingCount > 0) msg = `${instantCount} applied · ${pendingCount} queued for 24h cooldown`;
      else if (pendingCount > 0) msg = `${pendingCount} change${pendingCount > 1 ? "s" : ""} queued — activate after 24h.`;
      else if (instantCount > 0) msg = `${instantCount} change${instantCount > 1 ? "s" : ""} applied.`;
      toast.success(msg);
      await refetch();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't update doctrine.");
    } finally {
      setSaving(false);
    }
  };

  if (!settings) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto bg-card border-border">
        <SheetHeader>
          <SheetTitle>Edit doctrine</SheetTitle>
          <SheetDescription>
            Tighten risk → applies instantly. Loosen risk → 24-hour cooldown.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Starting equity */}
          <div className="panel p-3 space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Starting equity (USD)
            </Label>
            <Input
              type="number"
              min={1}
              step={1}
              value={startingEquityDraft}
              onChange={(e) => setStartingEquityDraft(e.target.value)}
              className="tabular"
            />
            <p className="text-[10px] text-muted-foreground">
              Basis for kill-switch floor. Current: {settings.starting_equity_usd != null ? formatUsd(settings.starting_equity_usd) : "—"}
            </p>
          </div>

          {/* Field rows */}
          {draftRows.map((r) => {
            const changed = r.current !== r.draft;
            const loosens = changed && isLoosening(r.field, r.current, r.draft);
            return (
              <FieldRow
                key={r.field}
                field={r.field}
                current={r.current}
                draft={r.draft}
                changed={changed}
                loosens={loosens}
                onChange={(v) => setDrafts((d) => ({ ...d, [r.field]: v }))}
                equity={equity}
                startingEquity={Number(startingEquityDraft) || settings.starting_equity_usd || equity || 10}
                focused={focusField === r.field}
              />
            );
          })}

          {/* Preview */}
          {previewResolved && (
            <div className="panel p-3 space-y-1.5 border-primary/30">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Resulting caps · current equity {formatUsd(equity)}
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                <PreviewRow label="Max order" value={formatUsd(previewResolved.maxOrderUsd)} />
                <PreviewRow label="Daily loss cap" value={formatUsd(previewResolved.dailyLossUsd)} />
                <PreviewRow label="Kill-switch floor" value={formatUsd(previewResolved.killSwitchFloorUsd)} />
                <PreviewRow label="Max trades/day" value={`${previewResolved.maxTradesPerDay}`} />
              </div>
            </div>
          )}

          {/* Summary */}
          {(tighten.length > 0 || loosen.length > 0 || startingEquityChanged) && (
            <div className="panel p-3 space-y-2 text-xs">
              {tighten.length > 0 && (
                <div className="flex items-center gap-2 text-status-safe">
                  <Zap className="h-3.5 w-3.5" />
                  <span>
                    {tighten.length} tighten{tighten.length === 1 ? "" : "s"} — applies instantly
                  </span>
                </div>
              )}
              {loosen.length > 0 && (
                <div className="flex items-center gap-2 text-status-caution">
                  <Clock className="h-3.5 w-3.5" />
                  <span>
                    {loosen.length} loosen{loosen.length === 1 ? "" : "s"} — activate in 24h
                  </span>
                </div>
              )}
              {startingEquityChanged && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>Starting equity change applies instantly (rebases the floor).</span>
                </div>
              )}
            </div>
          )}
        </div>

        <SheetFooter className="mt-6 flex-row gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || (changes.length === 0 && !startingEquityChanged)}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function FieldRow({
  field,
  current,
  draft,
  changed,
  loosens,
  onChange,
  equity,
  startingEquity,
  focused,
}: {
  field: DoctrineField;
  current: number;
  draft: number;
  changed: boolean;
  loosens: boolean;
  onChange: (v: number) => void;
  equity: number;
  startingEquity: number;
  focused?: boolean;
}) {
  const isPct = field.endsWith("_pct");
  const step = isPct ? 0.001 : 1;
  // Show as percent strings for pct fields so users edit "0.50" not "0.005".
  const displayValue = isPct ? (draft * 100).toFixed(3) : String(draft);

  const handleChange = (s: string) => {
    const n = Number(s);
    if (!Number.isFinite(n)) return;
    onChange(isPct ? n / 100 : n);
  };

  // Derived dollar value for this field
  const derived = (() => {
    if (field === "max_order_pct") return formatUsd(equity * draft);
    if (field === "daily_loss_pct") return formatUsd(equity * draft);
    if (field === "floor_pct") return formatUsd(startingEquity * draft);
    if (field === "risk_per_trade_pct") return `${formatUsd(equity * draft)} risk/trade`;
    return null;
  })();

  return (
    <div
      className={`panel p-3 space-y-2 ${focused ? "border-primary/60 ring-1 ring-primary/30" : ""} ${
        changed ? (loosens ? "border-status-caution/40" : "border-status-safe/40") : ""
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Label className="text-xs font-medium text-foreground">
          {DOCTRINE_FIELD_LABELS[field]}
        </Label>
        {changed && (
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold ${
              loosens ? "text-status-caution" : "text-status-safe"
            }`}
          >
            {loosens ? "Activates in 24h" : "Applies instantly"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          step={isPct ? 0.01 : step}
          value={displayValue}
          onChange={(e) => handleChange(e.target.value)}
          className="tabular text-sm h-9 flex-1"
        />
        <span className="text-[10px] text-muted-foreground w-8">
          {isPct ? "%" : ""}
        </span>
      </div>
      <div className="flex items-baseline justify-between text-[10px] text-muted-foreground">
        <span>
          Current: {isPct ? `${(current * 100).toFixed(3)}%` : current}
        </span>
        {derived && <span className="tabular">≈ {derived}</span>}
      </div>
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular text-foreground font-medium">{value}</span>
    </div>
  );
}
