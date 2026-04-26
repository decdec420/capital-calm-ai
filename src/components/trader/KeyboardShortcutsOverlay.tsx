import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

/**
 * Global keyboard shortcuts:
 *   ?  →  open this overlay
 *   k  →  open the kill-switch dialog (broadcast event picked up by FloatingKillSwitch)
 *
 * The `?` binding bypasses the standard hook because the key requires Shift.
 * The hook's "no modifiers" rule would otherwise filter it out.
 */
export function KeyboardShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  // `?` lives outside the hook because it needs Shift held.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (target?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // `k` uses the standard hook and broadcasts an event for FloatingKillSwitch.
  useKeyboardShortcuts({
    k: () => window.dispatchEvent(new CustomEvent("lovable:open-kill-switch")),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Quick keys for the operator console. Disabled while typing in inputs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 pt-1">
          <Section title="Signal bridge (Copilot)">
            <Row keyLabel="A" desc="Approve the active signal" />
            <Row keyLabel="R" desc="Reject the active signal" />
            <Row keyLabel="E" desc="Run the engine now" />
          </Section>
          <Section title="Global">
            <Row keyLabel="K" desc="Open the kill-switch dialog" />
            <Row keyLabel="?" desc="Toggle this shortcuts overlay" />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ keyLabel, desc }: { keyLabel: string; desc: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2">
      <span className="text-sm text-foreground">{desc}</span>
      <kbd className="font-mono text-[11px] rounded border border-border bg-card px-2 py-0.5 text-foreground">
        {keyLabel}
      </kbd>
    </div>
  );
}
