import { describe, expect, it } from "vitest";
import {
  assessExecutionDataReadiness,
  buildPaperExecutionSnapshot,
  EXECUTION_SCHEMA_AUDIT,
  EXISTING_EXECUTION_DATA_AUDIT_TABLE,
  REQUIRED_EXECUTION_DATA_FIELDS,
} from "@/lib/execution-data-readiness";

describe("execution data readiness audit", () => {
  const fullExplicitData = {
    expected_price: 100,
    actual_fill_price: 100.02,
    order_type: "market",
    maker_taker_flag: "taker",
    fees: 0.02,
    spread: 4,
    slippage: 2,
    time_to_fill: 425,
    partial_fill_status: "complete",
    quote_snapshot: {
      bid: 99.99,
      ask: 100.01,
      lastPrice: 100,
      capturedAt: "2026-05-14T00:00:00.000Z",
    },
    decision_timestamp: "2026-05-14T00:00:00.000Z",
    fill_timestamp: "2026-05-14T00:00:00.425Z",
  };

  it("returns insufficient when fill, fee, and slippage data are missing", () => {
    const readiness = assessExecutionDataReadiness({});

    expect(readiness.readiness).toBe("insufficient");
    expect(readiness.availableFields).toEqual([]);
    expect(readiness.missingFields).toEqual(REQUIRED_EXECUTION_DATA_FIELDS);
    expect(readiness.warnings.join(" ")).toContain("Actual fill price is missing");
    expect(readiness.executionAllowed).toBe(false);
  });

  it("returns partial when only proposal/decision data exists", () => {
    const readiness = assessExecutionDataReadiness({
      expected_price: 100,
      decision_timestamp: "2026-05-14T00:00:00.000Z",
      order_type: "paper_market",
    });

    expect(readiness.readiness).toBe("partial");
    expect(readiness.availableFields).toEqual(["expected_price", "order_type", "decision_timestamp"]);
    expect(readiness.missingFields).toContain("actual_fill_price");
    expect(readiness.missingFields).toContain("fees");
    expect(readiness.missingFields).toContain("slippage");
  });

  it("can report ready_for_research when every explicit execution-quality field exists", () => {
    const readiness = assessExecutionDataReadiness(fullExplicitData);

    expect(readiness.readiness).toBe("ready_for_research");
    expect(readiness.availableFields).toEqual(REQUIRED_EXECUTION_DATA_FIELDS);
    expect(readiness.missingFields).toEqual([]);
    expect(readiness.warnings.join(" ")).toContain("does not place orders");
  });

  it("blocks maker/taker readiness when maker/taker flag is missing", () => {
    const { maker_taker_flag: _flag, ...withoutMakerTaker } = fullExplicitData;
    const readiness = assessExecutionDataReadiness(withoutMakerTaker);

    expect(readiness.readiness).toBe("partial");
    expect(readiness.missingFields).toContain("maker_taker_flag");
    expect(readiness.makerTakerResearchAllowed).toBe(false);
  });

  it("requires a research-grade quote snapshot", () => {
    const readiness = assessExecutionDataReadiness({
      ...fullExplicitData,
      quote_snapshot: { lastPrice: 100, capturedAt: "2026-05-14T00:00:00.000Z" },
    });

    expect(readiness.readiness).toBe("partial");
    expect(readiness.missingFields).toContain("quote_snapshot");
    expect(readiness.warnings.join(" ")).toContain("bid, ask, and timestamp");
  });

  it("never allows execution from the helper", () => {
    expect(assessExecutionDataReadiness({}).executionAllowed).toBe(false);
    expect(assessExecutionDataReadiness(fullExplicitData).executionAllowed).toBe(false);
  });

  it("does not allow maker/taker experiments from this audit helper even with complete fields", () => {
    expect(assessExecutionDataReadiness({}).makerTakerResearchAllowed).toBe(false);
    expect(assessExecutionDataReadiness(fullExplicitData).makerTakerResearchAllowed).toBe(false);
  });

  it("paper trades do not fake real fees or fills", () => {
    const snapshot = buildPaperExecutionSnapshot({
      expectedPrice: 100,
      symbol: "BTC-USD",
      bid: 99.99,
      ask: 100.01,
      lastPrice: 100,
      decisionTimestamp: "2026-05-14T00:00:00.000Z",
    });

    expect(snapshot.source).toBe("paper_simulation");
    expect(snapshot.expectedPrice).toBe(100);
    expect(snapshot.actualFillPrice).toBeNull();
    expect(snapshot.feesUsd).toBeNull();
    expect(snapshot.slippageBps).toBeNull();
    expect(snapshot.fillTimestamp).toBeNull();
  });

  it("paper trades do not fake maker/taker status", () => {
    const snapshot = buildPaperExecutionSnapshot({ expectedPrice: 100 });

    expect(snapshot.makerTakerFlag).toBe("not_applicable_paper");
    const readiness = assessExecutionDataReadiness({
      ...fullExplicitData,
      maker_taker_flag: snapshot.makerTakerFlag,
    });
    expect(readiness.missingFields).toContain("maker_taker_flag");
    expect(readiness.makerTakerResearchAllowed).toBe(false);
  });

  it("computes paper spread only from explicit bid/ask and leaves it null otherwise", () => {
    const withBidAsk = buildPaperExecutionSnapshot({
      expectedPrice: 100,
      bid: 99.95,
      ask: 100.05,
      decisionTimestamp: "2026-05-14T00:00:00.000Z",
    });
    const withoutBidAsk = buildPaperExecutionSnapshot({ expectedPrice: 100, lastPrice: 100 });

    expect(withBidAsk.spreadBps).toBeCloseTo(10);
    expect(withoutBidAsk.spreadBps).toBeNull();
  });

  it("is a pure audit surface that documents storage without side-effect instructions", () => {
    const serialized = JSON.stringify({ EXECUTION_SCHEMA_AUDIT, EXISTING_EXECUTION_DATA_AUDIT_TABLE }).toLowerCase();

    expect(serialized).toContain("maker_taker_flag");
    expect(serialized).toContain("broker_fills");
    expect(serialized).not.toContain("place market");
    expect(serialized).not.toContain("approve signal");
    expect(serialized).not.toContain("mutate doctrine");
    expect(serialized).not.toContain("mutate strategies");
    expect(serialized).not.toContain("create trade");
  });
});
