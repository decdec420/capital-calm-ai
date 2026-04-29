// DoctrineProposalBanner — Feature 3: Shows pending Wags doctrine change proposals
// Reads from system_events where event_type = 'doctrine_proposal'.
// Proposals auto-apply after 24h unless the user dismisses them here.

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Clock, X } from "lucide-react";

interface DoctrineProposal {
  id: string;
  change_summary: string;
  rationale: string;
  apply_after: string;
  proposed_by: string;
  created_at: string;
}

function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "any moment";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `in ${Math.floor(ms / 60_000)} min`;
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

export function DoctrineProposalBanner() {
  const { user } = useAuth();
  const [proposals, setProposals] = useState<DoctrineProposal[]>([]);
  const [dismissing, setDismissing] = useState<Set<string>>(new Set());

  const load = async () => {
    if (!user) return;
    const { data } = await (supabase as any)
      .from("system_events")
      .select("id, payload, created_at")
      .eq("user_id", user.id)
      .eq("event_type", "doctrine_proposal")
      // Only show proposals where apply_after is in the future
      .order("created_at", { ascending: false })
      .limit(5);

    const now = Date.now();
    const active = ((data ?? []) as Array<{ id: string; payload: Record<string, unknown>; created_at: string }>)
      .filter((row) => {
        const applyAfter = row.payload?.apply_after as string | undefined;
        return applyAfter && new Date(applyAfter).getTime() > now;
      })
      .map((row) => ({
        id: row.id,
        change_summary: (row.payload?.change_summary as string) ?? "Doctrine change",
        rationale:      (row.payload?.rationale as string)      ?? "",
        apply_after:    (row.payload?.apply_after as string)    ?? "",
        proposed_by:    (row.payload?.proposed_by as string)    ?? "wags",
        created_at:     row.created_at,
      }));
    setProposals(active);
  };

  useEffect(() => { load(); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = async (id: string) => {
    if (!user) return;
    setDismissing((s) => new Set(s).add(id));
    // Mark it as expired by deleting the row (best-effort)
    await (supabase as any)
      .from("system_events")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id);
    setProposals((p) => p.filter((x) => x.id !== id));
    setDismissing((s) => { const n = new Set(s); n.delete(id); return n; });
  };

  if (proposals.length === 0) return null;

  return (
    <div className="space-y-2">
      {proposals.map((p) => (
        <div
          key={p.id}
          className="panel p-3 border-primary/30 bg-primary/5 flex items-start gap-3"
        >
          <Clock className="h-4 w-4 text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] uppercase tracking-wider text-primary font-semibold">
                Doctrine change queued
              </span>
              <span className="text-[10px] text-muted-foreground tabular">
                · applies {relativeTime(p.apply_after)}
              </span>
            </div>
            <p className="text-sm text-foreground leading-snug">{p.change_summary}</p>
            {p.rationale && (
              <p className="text-[11px] text-muted-foreground mt-0.5">{p.rationale}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
            disabled={dismissing.has(p.id)}
            onClick={() => dismiss(p.id)}
            aria-label="Veto this proposal"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
}
