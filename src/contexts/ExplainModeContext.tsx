import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

interface ExplainModeContextValue {
  enabled: boolean;
  toggle: () => void;
  setEnabled: (v: boolean) => void;
}

const ExplainModeContext = createContext<ExplainModeContextValue | null>(null);

const STORAGE_KEY = "trader-os:explain-mode";

export function ExplainModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      // ignore quota / SSR
    }
  }, []);

  const toggle = useCallback(() => setEnabled(!enabled), [enabled, setEnabled]);

  // Keyboard shortcut: Cmd/Ctrl + / toggles explain mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTyping =
        tag === "input" || tag === "textarea" || target?.isContentEditable;
      if (isTyping) return;

      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = useMemo(() => ({ enabled, toggle, setEnabled }), [enabled, toggle, setEnabled]);

  return <ExplainModeContext.Provider value={value}>{children}</ExplainModeContext.Provider>;
}

export function useExplainMode() {
  const ctx = useContext(ExplainModeContext);
  if (!ctx) throw new Error("useExplainMode must be used within ExplainModeProvider");
  return ctx;
}
