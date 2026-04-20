import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "trader-os:help-mode";

type HelpModeContextValue = {
  enabled: boolean;
  toggle: () => void;
  setEnabled: (v: boolean) => void;
};

const HelpModeContext = createContext<HelpModeContextValue | undefined>(undefined);

export function HelpModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "1";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (enabled) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  }, [enabled]);

  const setEnabled = useCallback((v: boolean) => setEnabledState(v), []);
  const toggle = useCallback(() => setEnabledState((v) => !v), []);

  return (
    <HelpModeContext.Provider value={{ enabled, toggle, setEnabled }}>
      {children}
    </HelpModeContext.Provider>
  );
}

export function useHelpMode() {
  const ctx = useContext(HelpModeContext);
  if (!ctx) throw new Error("useHelpMode must be used within HelpModeProvider");
  return ctx;
}
