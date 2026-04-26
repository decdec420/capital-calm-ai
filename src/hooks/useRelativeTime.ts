import { useEffect, useState } from "react";

function format(timestamp: number | null, now: number): string {
  if (timestamp === null) return "—";
  const diff = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function useRelativeTime(timestamp: number | null): string {
  const [label, setLabel] = useState<string>(() => format(timestamp, Date.now()));

  useEffect(() => {
    setLabel(format(timestamp, Date.now()));
    if (timestamp === null) return;
    const id = setInterval(() => {
      setLabel(format(timestamp, Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [timestamp]);

  return label;
}

export function isStale(timestamp: number | null, thresholdMs = 60000): boolean {
  if (timestamp === null) return false;
  return Date.now() - timestamp > thresholdMs;
}
