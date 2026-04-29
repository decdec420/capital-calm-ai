import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Zap, Shield, Flame, Clock } from "lucide-react";
import { useSystemState } from "@/hooks/useSystemState";
import { useDoctrineSettings } from "@/hooks/useDoctrineSettings";
import { TRADING_PROFILES, type ProfileId } from "@/lib/doctrine-constants";
import { isLoosening, type DoctrineField } from "@/lib/doctrine-resolver";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const ICONS: Record<ProfileId, typeof Shield> = {
  sentinel: Shield,
  active: Zap,
  aggressive: Flame,
};

/** Map a preset to the doctrine-settings fields it would set. */
function presetFields(id: ProfileId): Partial<Record<DoctrineField, number>> {
  const p = TRADING_PROFILES[id];
  return {
    max_order_abs_cap: p.maxOrderUsdHardCap,
    max_trades_per_day: p.maxDailyTradesHardCap,
    daily_loss_pct: p.maxDailyLossPct,
    risk_per_trade_pct: p.riskPerTradePct,
    scan_interval_seconds: p.scanIntervalSeconds,
    max_correlated_positions: p.maxCorrelatedPositions,
  };
}

export function ProfilePicker() {
  const { data: system, update } = useSystemState();
  const { settings } = useDoctrineSettings();
  const [pending, setPending] = useState<ProfileId | null>(null);
  const active: ProfileId = system?.activeProfile ?? "sentinel";

  const handleSelect = async (id: ProfileId) => {
    if (id === active || pending) return;
    setPending(id);
    try {
      // Build per-field change list against current doctrine_settings.
      const target = presetFields(id);
      const changes: Array<{ field: DoctrineField; to_value: number }> = [];
      let willLoosenAny = false;

      if (settings) {
        for (const [field, to] of Object.entries(target) as Array<
          [DoctrineField, number]
        >) {
          const from = Number(
            (settings as unknown as Record<string, unknown>)[field] ?? 0,
          );
          if (from === to) continue;
          changes.push({ field, to_value: to });
          if (isLoosening(field, from, to)) willLoosenAny = true;
        }
      }

      // Always update active_profile label instantly — it's just a label.
      await update({ activeProfile: id });

      if (changes.length > 0) {
        const { data, error } = await supabase.functions.invoke(
          "update-doctrine",
          { body: { changes } },
        );
        if (error) throw error;
        const results = (data as { results?: Array<{ applied: string }> })
          ?.results ?? [];
        const pendingCount = results.filter((r) => r.applied === "pending")
          .length;
        if (pendingCount > 0 || willLoosenAny) {
          toast.success(
            `Switched to ${TRADING_PROFILES[id].label} · ${pendingCount} loosening change(s) queued for 24h cooldown.`,
          );
        } else {
          toast.success(`Switched to ${TRADING_PROFILES[id].label} profile`);
        }
      } else {
        toast.success(`Switched to ${TRADING_PROFILES[id].label} profile`);
      }
    } catch (e) {
      toast.error("Failed to switch profile");
      console.error(e);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold tracking-wide uppercase text-foreground">
          Trading Profile
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          How aggressively Taylor scores setups and sizes orders. Tightening
          changes apply instantly; any field that loosens risk waits 24h.
          Symbol whitelist and live-arming approval stay locked at every tier.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(Object.values(TRADING_PROFILES)).map((p) => {
          const Icon = ICONS[p.id];
          const isActive = p.id === active;
          // Preview: would switching to this preset loosen anything?
          let loosensCount = 0;
          if (settings && !isActive) {
            const target = presetFields(p.id);
            for (const [field, to] of Object.entries(target) as Array<
              [DoctrineField, number]
            >) {
              const from = Number(
                (settings as unknown as Record<string, unknown>)[field] ?? 0,
              );
              if (from !== to && isLoosening(field, from, to)) loosensCount++;
            }
          }
          return (
            <Card
              key={p.id}
              className={`p-4 transition-colors cursor-pointer ${
                isActive
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/40"
              }`}
              onClick={() => handleSelect(p.id)}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="h-4 w-4 text-primary shrink-0" />
                  <span className="font-semibold text-sm truncate">{p.label}</span>
                </div>
                {isActive && (
                  <Badge variant="default" className="shrink-0 text-[10px] px-1.5 py-0">
                    <Check className="h-3 w-3 mr-1" /> Active
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mb-3 leading-snug">
                {p.tagline}
              </p>
              <dl className="text-xs space-y-1 font-mono">
                <Row label="Per order" value={`$${p.maxOrderUsdHardCap}`} />
                <Row label="Trades / day" value={String(p.maxDailyTradesHardCap)} />
                <Row label="Daily loss cap" value={`${(p.maxDailyLossPct * 100).toFixed(1)}%`} />
                <Row label="Risk / trade" value={`${(p.riskPerTradePct * 100).toFixed(1)}%`} />
                <Row
                  label="Scan every"
                  value={
                    p.scanIntervalSeconds >= 60
                      ? `${p.scanIntervalSeconds / 60} min`
                      : `${p.scanIntervalSeconds} s`
                  }
                />
              </dl>
              {!isActive && loosensCount > 0 && (
                <div className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-500">
                  <Clock className="h-3 w-3" />
                  {loosensCount} field{loosensCount === 1 ? "" : "s"} would loosen — 24h cooldown
                </div>
              )}
              {!isActive && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-3 h-7 text-xs"
                  disabled={pending !== null}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSelect(p.id);
                  }}
                >
                  {pending === p.id ? "Switching…" : "Switch to this"}
                </Button>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-3">
      <dt className="text-muted-foreground text-[11px] whitespace-nowrap">{label}</dt>
      <dd className="text-foreground text-right tabular-nums truncate">{value}</dd>
    </div>
  );
}
