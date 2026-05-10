import { describe, it, expect } from "vitest";
import {
  getSampleQualityLabel,
  hasSufficientData,
  isPaperPromotionEligible,
  isLivePromotionEligible,
  MIN_SAMPLE_FOR_METRICS,
  MIN_SAMPLE_BUILDING,
  MIN_SAMPLE_SIGNIFICANT,
} from "@/components/trader/StrategyEvidenceScorecard";

describe("strategy evidence scorecard — sample quality", () => {
  describe("getSampleQualityLabel", () => {
    it("returns 'Insufficient data' for trades < 5", () => {
      expect(getSampleQualityLabel(0)).toBe("Insufficient data (< 5)");
      expect(getSampleQualityLabel(4)).toBe("Insufficient data (< 5)");
    });

    it("returns 'Very early data' for 5–29 trades", () => {
      expect(getSampleQualityLabel(5)).toBe("Very early data (5–29)");
      expect(getSampleQualityLabel(29)).toBe("Very early data (5–29)");
    });

    it("returns 'Building data' for 30–99 trades", () => {
      expect(getSampleQualityLabel(30)).toBe("Building data (30–99)");
      expect(getSampleQualityLabel(99)).toBe("Building data (30–99)");
    });

    it("returns 'Significant' for ≥ 100 trades", () => {
      expect(getSampleQualityLabel(100)).toBe("Significant (≥ 100)");
      expect(getSampleQualityLabel(500)).toBe("Significant (≥ 100)");
    });
  });

  describe("hasSufficientData", () => {
    it("returns false when trades < MIN_SAMPLE_FOR_METRICS", () => {
      expect(hasSufficientData(0)).toBe(false);
      expect(hasSufficientData(MIN_SAMPLE_FOR_METRICS - 1)).toBe(false);
    });

    it("returns true when trades >= MIN_SAMPLE_FOR_METRICS", () => {
      expect(hasSufficientData(MIN_SAMPLE_FOR_METRICS)).toBe(true);
      expect(hasSufficientData(100)).toBe(true);
    });
  });

  describe("isPaperPromotionEligible", () => {
    it("returns false when trades < MIN_SAMPLE_BUILDING (30)", () => {
      expect(isPaperPromotionEligible(MIN_SAMPLE_BUILDING - 1)).toBe(false);
    });

    it("returns true when trades >= MIN_SAMPLE_BUILDING (30)", () => {
      expect(isPaperPromotionEligible(MIN_SAMPLE_BUILDING)).toBe(true);
      expect(isPaperPromotionEligible(99)).toBe(true);
    });
  });

  describe("isLivePromotionEligible", () => {
    it("returns false when trades < MIN_SAMPLE_SIGNIFICANT (100)", () => {
      expect(isLivePromotionEligible(MIN_SAMPLE_SIGNIFICANT - 1)).toBe(false);
    });

    it("returns true when trades >= MIN_SAMPLE_SIGNIFICANT (100)", () => {
      expect(isLivePromotionEligible(MIN_SAMPLE_SIGNIFICANT)).toBe(true);
      expect(isLivePromotionEligible(500)).toBe(true);
    });
  });

  describe("sample quality constants are consistent", () => {
    it("MIN_SAMPLE_FOR_METRICS < MIN_SAMPLE_BUILDING < MIN_SAMPLE_SIGNIFICANT", () => {
      expect(MIN_SAMPLE_FOR_METRICS).toBeLessThan(MIN_SAMPLE_BUILDING);
      expect(MIN_SAMPLE_BUILDING).toBeLessThan(MIN_SAMPLE_SIGNIFICANT);
    });
  });
});
