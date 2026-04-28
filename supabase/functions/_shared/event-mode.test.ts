import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  getActiveEventModeGateFromSystem,
  resolveEventModeReasonContext,
  UNKNOWN_EVENT_MODE,
} from "./event-mode.ts";

Deno.test("signal-engine event mode — active pause with known reason code returns event_mode context with that reason", () => {
  const futureIso = new Date(Date.now() + 60_000).toISOString();
  const gate = getActiveEventModeGateFromSystem({
    trading_paused_until: futureIso,
    pause_reason: "FOMC",
  });

  assertEquals(gate?.code, "TRADING_PAUSED_EVENT_MODE");
  assertEquals((gate?.meta?.eventMode as { code?: string })?.code, "FOMC");
  assertEquals((gate?.meta?.eventMode as { known?: boolean })?.known, true);
});

Deno.test("signal-engine event mode — active pause without reason returns UNKNOWN_EVENT_MODE", () => {
  const futureIso = new Date(Date.now() + 60_000).toISOString();
  const gate = getActiveEventModeGateFromSystem({
    trading_paused_until: futureIso,
    pause_reason: null,
  });

  assertEquals((gate?.meta?.eventMode as { code?: string })?.code, UNKNOWN_EVENT_MODE);
  assertEquals((gate?.meta?.eventMode as { known?: boolean })?.known, false);
});

Deno.test("signal-engine event mode — paused-until expired does not carry forward event mode", () => {
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  const gate = getActiveEventModeGateFromSystem({
    trading_paused_until: pastIso,
    pause_reason: "FOMC",
  });

  assertEquals(gate, null);
});

Deno.test("regression — Donna tick active-pause observation does not mutate trading_paused_until", () => {
  const futureIso = new Date(Date.now() + 60_000).toISOString();
  const sys = {
    trading_paused_until: futureIso,
    pause_reason: "CPI",
  };
  const before = JSON.stringify(sys);

  getActiveEventModeGateFromSystem(sys);

  assertEquals(JSON.stringify(sys), before);
});

Deno.test("event mode reason resolver — unknown reason code stays explicit and non-guessing", () => {
  const reason = resolveEventModeReasonContext("SOME_NEW_EVENT");
  assertEquals(reason.code, UNKNOWN_EVENT_MODE);
  assertEquals(reason.known, false);
});


Deno.test("signal-engine event mode — malformed paused-until does not halt trading", () => {
  const gate = getActiveEventModeGateFromSystem({
    trading_paused_until: "invalid-date",
    pause_reason: "FOMC",
  });

  assertEquals(gate, null);
});
