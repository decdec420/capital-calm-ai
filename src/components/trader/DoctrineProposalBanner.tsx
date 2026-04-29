// DoctrineProposalBanner — Feature 3: Shows recent Wags doctrine changes
// Reads from system_events where event_type = 'doctrine_change'.
// Changes apply immediately — this is a confirmation strip, not a queue.

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { CheckCircle2 } from "lucide-react";

interface DoctrineChange {
  id: string;
  change_summary: string;
  rationale: string;
  applied_by: string;
  created_at: string;
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const SHOW_WINDOW_MS = 30 * 60 * 1000; // show for 30 min after apply

export function DoctrineProposalBanner() {
  const { user } = useAuth();
  const [changes, setChanges] = useState<DoctrineChange[]>([]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      const since = new Date(Date.now() - SHOW_WINDOW_MS).toISOString();
      const { data } = await (supabase as any)
        .from("system_events")
        .select("id, payload, created_at")
        .eq("user_id", user.id)
        .eq("event_type", "doctrine_change")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(3);
      if (cancelled) return;
      setChanges(
        ((data ?? []) as Array<{ id: string; payload: Record<string, unknown>; created_at: string }>)
          .filter((row) => row.payload?.applied === true)
          .map((row) => ({
            id:           row.id,
            change_summary: (row.payload?.change_summary as string) ?? "Doctrine updated",
            rationale:    (row.payload?.rationale as string) ?? "",
            applied_by:   (row.payload?.applied_by as string) ?? "wags",
            created_at:   row.created_at,
          }))
      );
    };
    load();
    return () => { cancelled = true; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (changes.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {changes.map((c) => (
        <div
          key={c.id}
          className="panel p-3 border-status-safe/30 bg-status-safe/5 flex items-start gap-2.5"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-status-safe shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] uppercase tracking-wider text-status-safe font-semibold">
                Doctrine updated
              </span>
              <span className="text-[10px] text-muted-foreground tabular">
                · {c.applied_by} · {relativeAge(c.created_at)}
              </span>
            </div>
            <p className="text-xs text-foreground leading-snug">{c.change_summary}</p>
            {c.rationale && (
              <p className="text-[11px] text-muted-foreground mt-0.5">{c.rationale}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
