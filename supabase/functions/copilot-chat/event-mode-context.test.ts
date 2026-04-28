import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildEventModeContextInstruction } from "./event-mode-context.ts";

Deno.test("Copilot/Harvey — unknown reason context states unknown and avoids guessing", () => {
  const instruction = buildEventModeContextInstruction({
    system: {
      trading_paused_until: new Date(Date.now() + 60_000).toISOString(),
      pause_reason: null,
    },
  });

  assertStringIncludes(instruction, "UNKNOWN_EVENT_MODE");
  assertStringIncludes(instruction, "do not guess");
});

Deno.test("Copilot/Harvey — known reason context uses exact reason label/detail", () => {
  const instruction = buildEventModeContextInstruction({
    system: {
      trading_paused_until: new Date(Date.now() + 60_000).toISOString(),
      pause_reason: "CPI",
    },
  });

  assertStringIncludes(instruction, "Reason code: CPI");
  assertStringIncludes(instruction, "Reason label: CPI release window");
  assertStringIncludes(
    instruction,
    "Detail: Inflation print can whip liquidity and invalidate setup quality during release window.",
  );
});

Deno.test("Copilot/Harvey — no active pause yields no instruction", () => {
  const instruction = buildEventModeContextInstruction({
    system: {
      trading_paused_until: new Date(Date.now() - 60_000).toISOString(),
      pause_reason: "CPI",
    },
  });

  assertEquals(instruction, "");
});
