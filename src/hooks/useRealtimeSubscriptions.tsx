/**
 * useRealtimeSubscriptions — shared realtime channel manager
 * ==========================================================
 * Opens a SINGLE Supabase WebSocket channel that multiplexes
 * postgres_changes events for all 8 subscribed tables.
 *
 * WHY: Each hook used to open its own channel.  Supabase allows
 * ~200 concurrent subscriptions per project; with 8 hooks × every
 * open tab that limit is reached faster than expected.  Multiplexing
 * 8 postgres_changes filters over one channel also reduces
 * subscribe/unsubscribe churn on navigation.
 *
 * USAGE in a data hook:
 *
 *   import { useTableChanges } from "@/hooks/useRealtimeSubscriptions";
 *
 *   export function useMyHook() {
 *     ...
 *     useTableChanges("my_table", refetch);
 *     ...
 *   }
 *
 * The RealtimeSubscriptionProvider must sit above all hooks in the
 * React tree (added to App.tsx alongside AuthProvider).
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { RealtimeChannel } from "@supabase/supabase-js";

// ── Supported tables ──────────────────────────────────────────

export type WatchedTable =
  | "system_state"
  | "trade_signals"
  | "account_state"
  | "alerts"
  | "trades"
  | "market_intelligence"
  | "doctrine_settings"
  | "pending_doctrine_changes"
  | "experiments";

const WATCHED_TABLES: WatchedTable[] = [
  "system_state",
  "trade_signals",
  "account_state",
  "alerts",
  "trades",
  "market_intelligence",
  "doctrine_settings",
  "pending_doctrine_changes",
  "experiments",
];

// ── Context ───────────────────────────────────────────────────

type Callback = () => void;
type Registry = Map<WatchedTable, Set<Callback>>;

interface RealtimeContextValue {
  /** Register a callback for a table.  Returns an unsubscribe fn. */
  subscribe: (table: WatchedTable, cb: Callback) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────

export function RealtimeSubscriptionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const registry = useRef<Registry>(new Map());
  const channelRef = useRef<RealtimeChannel | null>(null);

  // Build (or rebuild) the single multiplexed channel whenever user changes.
  useEffect(() => {
    if (!user) return;

    const uid = user.id;
    const channelName = `app_realtime:${uid}`;

    // Ensure registry has a Set for every watched table.
    for (const table of WATCHED_TABLES) {
      if (!registry.current.has(table)) {
        registry.current.set(table, new Set());
      }
    }

    let ch = supabase.channel(channelName);

    for (const table of WATCHED_TABLES) {
      ch = ch.on(
        // @ts-ignore — overloaded signature; string literal is valid
        "postgres_changes" as any,
        { event: "*", schema: "public", table, filter: `user_id=eq.${uid}` },
        () => {
          // Fan out to every registered callback for this table.
          registry.current.get(table as WatchedTable)?.forEach((cb) => cb());
        },
      );
    }

    ch.subscribe();
    channelRef.current = ch;

    return () => {
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [user?.id]);

  const subscribe = useCallback((table: WatchedTable, cb: Callback): (() => void) => {
    if (!registry.current.has(table)) {
      registry.current.set(table, new Set());
    }
    registry.current.get(table)!.add(cb);
    return () => {
      registry.current.get(table)?.delete(cb);
    };
  }, []);

  return (
    <RealtimeContext.Provider value={{ subscribe }}>
      {children}
    </RealtimeContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────

/**
 * Subscribe to postgres_changes for `table` via the shared channel.
 * `callback` is called on every INSERT / UPDATE / DELETE.
 *
 * Drop-in replacement for the per-hook supabase.channel() block:
 *
 *   // Before:
 *   const channel = supabase.channel(`trades:${user.id}:${random}`)
 *     .on("postgres_changes", { ... table: "trades" ... }, () => refetch())
 *     .subscribe();
 *
 *   // After:
 *   useTableChanges("trades", refetch);
 */
export function useTableChanges(table: WatchedTable, callback: Callback): void {
  const ctx = useContext(RealtimeContext);

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(table, callback);
    // callback identity must be stable (wrap in useCallback at the call site if needed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, table]);
}
