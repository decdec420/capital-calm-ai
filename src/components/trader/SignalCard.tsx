import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { Check, X, Brain, Clock } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import type { TradeSignal } from "@/lib/domain-types";
import { cn } from "@/lib/utils";

interface SignalCardProps {
  signal: TradeSignal;
  onDecided?: () => void;
}

export function SignalCard({ signal, onDecided }: SignalCardProps) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [remaining, setRemaining] = useState(() =>
    Math.max(0, new Date(signal.expiresAt).getTime() - Date.now()),
  );

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(Math.max(0, new Date(signal.expiresAt).getTime() - Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [signal.expiresAt]);

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const isUrgent = remaining < 60_000;
  const isExpiring = remaining < 30_000;

  const decide = async (action: "approve" | "reject") => {
    setBusy(action);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) {
        toast.error("Sign in first.");
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/signal-decide`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ signalId: signal.id, action }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? `Failed to ${action}`);
        return;
      }
      toast.success(action === "approve" ? "Trade opened." : "Signal declined. AI noted.");
      onDecided?.();
    } catch {
      toast.error("Connection error.");
    } finally {
      setBusy(null);
    }
  };

  const sideTone = signal.side === "long" ? "safe" : "blocked";
  const rr = signal.proposedStop && signal.proposedTarget
    ? Math.abs((signal.proposedTarget - signal.proposedEntry) / (signal.proposedEntry - signal.proposedStop))
    : 0;

  return (
    <div
      className={cn(
        "panel p-5 space-y-4 bg-gradient-to-br from-primary/5 to-transparent animate-fade-in transition-colors",
        isExpiring
          ? "border-status-blocked animate-pulse-soft shadow-[0_0_20px_hsl(var(--status-blocked)/0.15)]"
          : isUrgent
            ? "border-status-caution"
            : "border-primary/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Brain className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-primary">AI Signal · pending</div>
            <div className="text-sm font-semibold text-foreground">
              {signal.side.toUpperCase()} {signal.symbol} @ ${signal.proposedEntry.toFixed(2)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone={sideTone} size="sm" dot>
            {signal.side}
          </StatusBadge>
          <StatusBadge
            tone={isExpiring ? "blocked" : isUrgent ? "caution" : "neutral"}
            size="sm"
            dot
            pulse={isUrgent}
          >
            <Clock className="h-3 w-3" />
            {mins}:{secs.toString().padStart(2, "0")}
          </StatusBadge>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Confidence" value={`${(signal.confidence * 100).toFixed(0)}%`} highlight />
        <Stat label="Stop" value={signal.proposedStop ? `$${signal.proposedStop.toFixed(2)}` : "—"} />
        <Stat label="Target" value={signal.proposedTarget ? `$${signal.proposedTarget.toFixed(2)}` : "—"} />
        <Stat label="Size" value={`$${signal.sizeUsd.toFixed(0)} (${(signal.sizePct * 100).toFixed(1)}%)`} />
        <Stat label="R:R" value={rr ? `${rr.toFixed(2)}:1` : "—"} />
      </div>

      <div className="rounded-md bg-secondary/50 border border-border p-3">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">AI reasoning</div>
        <p className="text-sm text-foreground leading-relaxed">{signal.aiReasoning}</p>
        <div className="text-[10px] text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1">
          <span>Regime: <span className="text-foreground">{signal.regime}</span></span>
          <span>Setup: <span className="text-foreground tabular">{signal.setupScore.toFixed(2)}</span></span>
          <span>Phase: <span className="text-foreground">{signal.lifecyclePhase}</span></span>
          {signal.strategyVersion && (
            <span>Strategy: <span className="text-foreground">{signal.strategyVersion}</span></span>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={() => decide("approve")}
          disabled={busy !== null || remaining === 0}
          className="flex-1 gap-1.5 bg-status-safe hover:bg-status-safe/90 text-white"
        >
          <Check className="h-4 w-4" />
          {busy === "approve" ? "Opening…" : "Approve & open trade"}
        </Button>
        <Button
          onClick={() => decide("reject")}
          disabled={busy !== null || remaining === 0}
          variant="outline"
          className="gap-1.5 border-status-blocked/40 text-status-blocked hover:bg-status-blocked/10 hover:text-status-blocked"
        >
          <X className="h-4 w-4" />
          {busy === "reject" ? "…" : "Reject"}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-sm tabular", highlight ? "text-primary font-semibold" : "text-foreground")}>{value}</div>
    </div>
  );
}
