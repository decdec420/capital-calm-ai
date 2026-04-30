import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ShieldCheck, Loader2, ExternalLink, AlertCircle } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialKeyName?: string | null;
  onSaved?: () => void;
}

export function BrokerConnectDialog({ open, onOpenChange, initialKeyName, onSaved }: Props) {
  const [keyName, setKeyName] = useState(initialKeyName ?? "");
  const [pem, setPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens with a fresh keyName prop
  // (handles "Reconnect" pre-fill).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // (Intentionally only run when open transitions or initialKeyName changes.)

  const onSubmit = async () => {
    setError(null);
    setBusy(true);
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke("broker-connection", {
        body: { action: "save", keyName: keyName.trim(), privatePem: pem },
      });
      if (invokeErr) throw new Error(invokeErr.message);
      if (data?.error) throw new Error(data.error);
      toast.success("Broker connected.");
      setPem("");
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to save credentials";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Connect Coinbase
          </DialogTitle>
          <DialogDescription>
            Stored encrypted in Lovable Cloud Vault. Never sent to the browser. We test the keys before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="keyName" className="text-xs uppercase tracking-wider text-muted-foreground">
              API Key Name
            </Label>
            <Input
              id="keyName"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="organizations/abc.../apiKeys/xyz..."
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pem" className="text-xs uppercase tracking-wider text-muted-foreground">
              Private Key (PEM)
            </Label>
            <Textarea
              id="pem"
              value={pem}
              onChange={(e) => setPem(e.target.value)}
              placeholder={"-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEI...\n-----END EC PRIVATE KEY-----"}
              className="font-mono text-[11px] min-h-[180px] resize-none"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Paste either format — we normalize SEC1 to PKCS8 server-side.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-status-blocked/30 bg-status-blocked/5 px-3 py-2 text-xs text-status-blocked">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <a
            href="https://www.coinbase.com/settings/api"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Create a Coinbase Advanced Trade key ('view' for paper mode; add 'trade' only for live mode). Do not enable transfer permission.
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={busy || !keyName.trim() || !pem.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Test &amp; Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
