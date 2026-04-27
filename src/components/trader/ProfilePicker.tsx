import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Zap, Shield, Flame } from "lucide-react";
import { useSystemState } from "@/hooks/useSystemState";
import { TRADING_PROFILES, type ProfileId } from "@/lib/doctrine-constants";
import { toast } from "sonner";

const ICONS: Record<ProfileId, typeof Shield> = {
  sentinel: Shield,
  active: Zap,
  aggressive: Flame,
};

export function ProfilePicker() {
  const { data: system, update } = useSystemState();
  const [pending, setPending] = useState<ProfileId | null>(null);
  const active: ProfileId = system?.activeProfile ?? "sentinel";

  const handleSelect = async (id: ProfileId) => {
    if (id === active || pending) return;
    setPending(id);
    try {
      await update({ activeProfile: id });
      toast.success(`Switched to ${TRADING_PROFILES[id].label} profile`);
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
          How aggressively Harvey scans the market and sizes orders. Kill-switch floor
          ($8), symbol whitelist, and live-arming approval stay locked at every tier.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(Object.values(TRADING_PROFILES)).map((p) => {
          const Icon = ICONS[p.id];
          const isActive = p.id === active;
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
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">{p.label}</span>
                </div>
                {isActive && (
                  <Badge variant="default" className="text-[10px] px-1.5 py-0">
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
                <Row label="Daily loss cap" value={`$${p.maxDailyLossUsdHardCap}`} />
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
    <div className="flex justify-between items-baseline">
      <dt className="text-muted-foreground text-[11px]">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
