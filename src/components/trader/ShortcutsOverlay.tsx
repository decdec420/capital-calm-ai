import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";

type Scope = "Copilot only" | "Global";

const SHORTCUTS: { key: string; desc: string; scope: Scope }[] = [
  { key: "A", desc: "Approve pending signal", scope: "Copilot only" },
  { key: "R", desc: "Reject pending signal", scope: "Copilot only" },
  { key: "E", desc: "Run engine now", scope: "Copilot only" },
  { key: "K", desc: "Toggle kill-switch dialog", scope: "Global" },
  { key: "?", desc: "Show this overlay", scope: "Global" },
  { key: "Esc", desc: "Close any dialog", scope: "Global" },
];

/**
 * Global shortcuts overlay.
 *   ?  → toggle this overlay (handled here directly, since `?` requires Shift
 *        and the standard hook filters out modifier-held keys).
 *   k  → dispatches `lovable:open-kill-switch`, picked up by FloatingKillSwitch.
 */
export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

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

        <Table>
          <TableBody>
            {SHORTCUTS.map((s) => (
              <TableRow key={s.key} className="border-border">
                <TableCell className="w-16 py-2">
                  <KeyCap value={s.key} />
                </TableCell>
                <TableCell className="py-2 text-sm text-foreground">{s.desc}</TableCell>
                <TableCell className="py-2 text-right text-[10px] uppercase tracking-wider text-muted-foreground">
                  {s.scope}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <p className="text-[11px] text-muted-foreground italic pt-1">
          Signal shortcuts only activate when a pending signal exists.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function KeyCap({ value }: { value: string }) {
  return (
    <kbd
      className={[
        "inline-flex items-center justify-center",
        "min-w-[1.75rem] h-7 px-2",
        "font-mono text-xs font-medium text-foreground",
        "rounded-md border border-border bg-secondary",
        "shadow-[inset_0_-1px_0_hsl(var(--border))]",
      ].join(" ")}
    >
      {value}
    </kbd>
  );
}
