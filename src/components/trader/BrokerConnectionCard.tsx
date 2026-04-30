import { useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/trader/StatusBadge";
import { BrokerConnectDialog } from "@/components/trader/BrokerConnectDialog";
import { useBrokerHealth } from "@/hooks/useBrokerHealth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useRelativeTime } from "@/hooks/useRelativeTime";
import { Wifi, WifiOff, AlertTriangle, Loader2, RotateCw, Trash2 } from "lucide-react";

export function BrokerConnectionCard() {
  const { health, loading } = useBrokerHealth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const lastSuccess = useRelativeTime(health.lastSuccessAt ? new Date(health.lastSuccessAt).getTime() : null);

  const onProbe = async () => {
    setProbing(true);
    try {
      const { data, error } = await supabase.functions.invoke("broker-connection", {
        body: { action: "probe" },
      });
      if (error) throw new Error(error.message);
      if (data?.ok) toast.success("Broker connection healthy.");
      else toast.error(data?.error ?? "Probe failed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Probe failed");
    } finally {
      setProbing(false);
    }
  };

  const onDisconnect = async () => {
    if (!confirm("Disconnect Coinbase? Live orders will fail until you reconnect.")) return;
    setDisconnecting(true);
    try {
      const { data, error } = await supabase.functions.invoke("broker-connection", {
        body: { action: "disconnect" },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      toast.success("Broker disconnected.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setDisconnecting(false);
    }
  };

  const status = health.status;
  const meta =
    status === "healthy"
      ? { icon: <Wifi className="h-4 w-4" />, tone: "safe" as const, label: "Connected" }
      : status === "auth_failed"
        ? { icon: <AlertTriangle className="h-4 w-4" />, tone: "blocked" as const, label: "Auth failed" }
        : { icon: <WifiOff className="h-4 w-4" />, tone: "caution" as const, label: "Not connected" };

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                meta.tone === "safe"
                  ? "border-status-safe/30 bg-status-safe/10 text-status-safe"
                  : meta.tone === "blocked"
                    ? "border-status-blocked/30 bg-status-blocked/10 text-status-blocked"
                    : "border-status-caution/30 bg-status-caution/10 text-status-caution"
              }`}>
                {meta.icon}
                <span>Coinbase · {meta.label}</span>
              </span>
            </div>
            {health.keyName && (
              <div className="text-xs text-muted-foreground font-mono truncate" title={health.keyName}>
                {health.keyName}
              </div>
            )}
            {status === "healthy" && health.lastSuccessAt && (
              <div className="text-xs text-muted-foreground">Last verified {lastSuccess}</div>
            )}
            {status === "auth_failed" && health.lastError && (
              <div className="text-xs text-status-blocked">{health.lastError}</div>
            )}
            {status === "not_connected" && (
              <div className="text-xs text-muted-foreground">
                Required for live trading. Paper mode works without it.
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {status !== "not_connected" && (
              <Button size="sm" variant="ghost" onClick={onProbe} disabled={probing || loading}>
                {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
                Re-test
              </Button>
            )}
            <Button size="sm" variant={status === "healthy" ? "outline" : "default"} onClick={() => setDialogOpen(true)}>
              {status === "not_connected" ? "Connect" : "Reconnect"}
            </Button>
            {status !== "not_connected" && (
              <Button size="sm" variant="ghost" onClick={onDisconnect} disabled={disconnecting}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
          Coinbase Advanced Trade keys with <span className="text-foreground">view + trade</span> scopes. Stored encrypted in Lovable Cloud Vault — never visible to the browser. We verify the keys against Coinbase before saving.
        </div>
      </div>

      <BrokerConnectDialog
        key={health.keyName ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialKeyName={health.keyName}
      />
    </>
  );
}
