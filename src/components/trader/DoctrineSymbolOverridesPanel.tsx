// ============================================================
// DoctrineSymbolOverridesPanel — tighten doctrine per symbol.
// Each override row can ONLY tighten the global doctrine; the
// resolver enforces this by taking min() against the global.
// ============================================================
import { useState } from "react";
import { Plus, Trash2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import {
  useDoctrineSymbolOverrides,
  type SymbolOverride,
  type SymbolOverrideInput,
} from "@/hooks/useDoctrineSymbolOverrides";
import { useDoctrineSettings } from "@/hooks/useDoctrineSettings";
import { toast } from "sonner";

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

const COMMON_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"];

export function DoctrineSymbolOverridesPanel() {
  const { overrides, loading, upsert, remove } = useDoctrineSymbolOverrides();
  const { settings } = useDoctrineSettings();
  const [editing, setEditing] = useState<SymbolOverride | "new" | null>(null);

  return (
    <div className="panel p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Per-symbol overrides</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tighten caps for specific symbols (e.g. half-size SOL). Overrides can only make caps smaller — never larger than the global doctrine.
          </p>
        </div>
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing("new")}>
          <Plus className="h-3.5 w-3.5" /> Add override
        </Button>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground italic">Loading…</p>
      ) : overrides.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No symbol overrides — every symbol uses the global doctrine.</p>
      ) : (
        <div className="space-y-1.5">
          {overrides.map((o) => (
            <div key={o.id} className="flex items-center justify-between rounded-md border border-border/60 bg-background/40 px-3 py-2">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${o.enabled ? "bg-status-safe/15 text-status-safe" : "bg-muted text-muted-foreground"}`}>
                  {o.enabled ? "active" : "off"}
                </span>
                <span className="text-sm font-medium text-foreground tabular">{o.symbol}</span>
                <span className="text-[11px] text-muted-foreground truncate">
                  order {fmtPct(o.max_order_pct)} · risk {fmtPct(o.risk_per_trade_pct)} · daily {fmtPct(o.daily_loss_pct)} · trades {o.max_trades_per_day ?? "—"}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button size="icon" variant="ghost" onClick={() => setEditing(o)} aria-label="Edit override">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await remove(o.id);
                      toast.success(`Removed override for ${o.symbol}.`);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Couldn't remove.");
                    }
                  }}
                  aria-label="Delete override"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <SymbolOverrideDialog
          existing={editing === "new" ? null : editing}
          globalMaxOrderPct={settings?.max_order_pct ?? 0.05}
          globalRiskPct={settings?.risk_per_trade_pct ?? 0.01}
          globalDailyLossPct={settings?.daily_loss_pct ?? 0.02}
          globalTrades={settings?.max_trades_per_day ?? 6}
          onClose={() => setEditing(null)}
          onSave={async (input, id) => {
            try {
              await upsert({ ...input, ...(id ? { id } : {}) });
              toast.success("Override saved.");
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
  existing: SymbolOverride | null;
  globalMaxOrderPct: number;
  globalRiskPct: number;
  globalDailyLossPct: number;
  globalTrades: number;
  onClose: () => void;
  onSave: (input: SymbolOverrideInput, id?: string) => Promise<void>;
}

function SymbolOverrideDialog({
  existing,
  globalMaxOrderPct,
  globalRiskPct,
  globalDailyLossPct,
  globalTrades,
  onClose,
  onSave,
}: DialogProps) {
  const [symbol, setSymbol] = useState(existing?.symbol ?? "BTC-USD");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [maxOrderPct, setMaxOrderPct] = useState<string>(existing?.max_order_pct != null ? String(existing.max_order_pct * 100) : "");
  const [riskPct, setRiskPct] = useState<string>(existing?.risk_per_trade_pct != null ? String(existing.risk_per_trade_pct * 100) : "");
  const [dailyLossPct, setDailyLossPct] = useState<string>(existing?.daily_loss_pct != null ? String(existing.daily_loss_pct * 100) : "");
  const [trades, setTrades] = useState<string>(existing?.max_trades_per_day != null ? String(existing.max_trades_per_day) : "");
  const [saving, setSaving] = useState(false);

  const parseOptPct = (s: string): number | null => {
    if (!s.trim()) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n / 100;
  };
  const parseOptInt = (s: string): number | null => {
    if (!s.trim()) return null;
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    return n;
  };

  const submit = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) {
      toast.error("Symbol is required.");
      return;
    }
    const mop = parseOptPct(maxOrderPct);
    const rpt = parseOptPct(riskPct);
    const dlp = parseOptPct(dailyLossPct);
    const tpd = parseOptInt(trades);

    // Tighten-only guard (UI hint — resolver enforces too).
    if (mop != null && mop > globalMaxOrderPct) {
      toast.error(`Order cap can't exceed global ${(globalMaxOrderPct * 100).toFixed(2)}%.`);
      return;
    }
    if (rpt != null && rpt > globalRiskPct) {
      toast.error(`Risk per trade can't exceed global ${(globalRiskPct * 100).toFixed(2)}%.`);
      return;
    }
    if (dlp != null && dlp > globalDailyLossPct) {
      toast.error(`Daily loss can't exceed global ${(globalDailyLossPct * 100).toFixed(2)}%.`);
      return;
    }
    if (tpd != null && tpd > globalTrades) {
      toast.error(`Trades/day can't exceed global ${globalTrades}.`);
      return;
    }

    setSaving(true);
    try {
      await onSave(
        {
          symbol: sym,
          enabled,
          max_order_pct: mop,
          risk_per_trade_pct: rpt,
          daily_loss_pct: dlp,
          max_trades_per_day: tpd,
        },
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
          <DialogTitle>{existing ? `Edit ${existing.symbol} override` : "New symbol override"}</DialogTitle>
          <DialogDescription>
            Leave a field blank to inherit the global doctrine. Values can only tighten — never loosen — the global cap.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sym-input">Symbol</Label>
              <Input
                id="sym-input"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                list="common-symbols"
                placeholder="BTC-USD"
              />
              <datalist id="common-symbols">
                {COMMON_SYMBOLS.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="flex items-end gap-2">
              <Switch checked={enabled} onCheckedChange={setEnabled} id="enabled-switch" />
              <Label htmlFor="enabled-switch" className="mb-2.5">{enabled ? "Active" : "Disabled"}</Label>
            </div>
          </div>

          <Field
            label="Max order (% of equity)"
            value={maxOrderPct}
            onChange={setMaxOrderPct}
            placeholder={`global ${(globalMaxOrderPct * 100).toFixed(2)}`}
            suffix="%"
          />
          <Field
            label="Risk per trade (% of equity)"
            value={riskPct}
            onChange={setRiskPct}
            placeholder={`global ${(globalRiskPct * 100).toFixed(2)}`}
            suffix="%"
          />
          <Field
            label="Daily loss cap (% of equity)"
            value={dailyLossPct}
            onChange={setDailyLossPct}
            placeholder={`global ${(globalDailyLossPct * 100).toFixed(2)}`}
            suffix="%"
          />
          <Field
            label="Max trades per day"
            value={trades}
            onChange={setTrades}
            placeholder={`global ${globalTrades}`}
            suffix=""
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save override"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onChange, placeholder, suffix }: {
  label: string; value: string; onChange: (s: string) => void; placeholder: string; suffix: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="relative">
        <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="decimal" />
        {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}
