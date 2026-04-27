// ============================================================
// StartingEquityModal — first-run onboarding for doctrine_settings.
// Shown when starting_equity_usd is NULL. Asks the user how much
// capital they're funding the account with so per-user caps can be
// derived. Cannot be dismissed without entering a value (>= $1).
// ============================================================
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useDoctrineSettings } from "@/hooks/useDoctrineSettings";
import { resolveDoctrine, SENTINEL_PRESET } from "@/lib/doctrine-resolver";
import { formatUsd } from "@/lib/utils";
import { Shield } from "lucide-react";
import { toast } from "sonner";

export function StartingEquityModal() {
  const { user } = useAuth();
  const { needsOnboarding, refetch, settings } = useDoctrineSettings();
  const [amount, setAmount] = useState<string>("1000");
  const [saving, setSaving] = useState(false);

  const numericAmount = Number(amount);
  const valid = Number.isFinite(numericAmount) && numericAmount >= 1;

  // Live preview of resulting caps using sentinel preset (default starting position)
  const preview = useMemo(() => {
    if (!valid) return null;
    return resolveDoctrine(
      {
        ...SENTINEL_PRESET,
        starting_equity_usd: numericAmount,
        max_order_abs_floor: 0.25,
        floor_abs_min: 5,
        consecutive_loss_limit: 2,
        loss_cooldown_minutes: 30,
      },
      numericAmount,
    );
  }, [numericAmount, valid]);

  const handleSubmit = async () => {
    if (!user || !valid) return;
    setSaving(true);
    try {
      // Apply the sentinel preset and starting equity in one shot.
      const { error } = await supabase
        .from("doctrine_settings")
        .update({
          starting_equity_usd: numericAmount,
          ...SENTINEL_PRESET,
          updated_via: "user",
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
      if (error) throw error;

      // Sync account_state.equity if it's still the placeholder $10000
      // so the dashboard reflects the real funding level.
      await supabase
        .from("account_state")
        .update({
          equity: numericAmount,
          cash: numericAmount,
          start_of_day_equity: numericAmount,
          balance_floor: Math.max(numericAmount * SENTINEL_PRESET.floor_pct, 5),
        })
        .eq("user_id", user.id);

      toast.success(`Doctrine set up for ${formatUsd(numericAmount)}.`);
      await refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save starting equity.");
    } finally {
      setSaving(false);
    }
  };

  if (!needsOnboarding) return null;

  return (
    <Dialog open={true}>
      <DialogContent className="bg-card border-border max-w-lg" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            <DialogTitle>Set up your doctrine</DialogTitle>
          </div>
          <DialogDescription>
            Capital-preservation guardrails scale with your funded equity. Tell us how much you're putting in so caps can be derived correctly.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Starting equity (USD)
            </Label>
            <Input
              type="number"
              min={1}
              step={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1000"
              className="text-lg tabular"
            />
            <p className="text-[11px] text-muted-foreground">
              Minimum $1. You can change this later in Risk Center.
            </p>
          </div>

          {preview && (
            <div className="panel p-4 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Sentinel preset · derived caps
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <Row label="Max per order" value={`${formatUsd(preview.maxOrderUsd)} (0.10%)`} />
                <Row label="Daily loss cap" value={`${formatUsd(preview.dailyLossUsd)} (0.30%)`} />
                <Row label="Kill-switch floor" value={`${formatUsd(preview.killSwitchFloorUsd)} (80%)`} />
                <Row label="Max trades / day" value={`${preview.maxTradesPerDay}`} />
              </div>
              <p className="text-[10px] text-muted-foreground italic">
                Loosen any of these later → 24-hour cooldown protects against tilt. Tightening applies instantly.
              </p>
            </div>
          )}

          <Button onClick={handleSubmit} disabled={!valid || saving} className="w-full">
            {saving ? "Setting up…" : "Apply doctrine"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular text-foreground font-medium">{value}</span>
    </div>
  );
}
