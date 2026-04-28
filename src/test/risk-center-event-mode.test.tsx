import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventModePanel } from "@/pages/RiskCenter";

const updateMock = vi.fn();

vi.mock("@/hooks/useSystemState", () => ({
  useSystemState: () => ({
    data: {
      tradingPausedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      pauseReason: "FOMC",
    },
    update: updateMock,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Risk Center Event Mode panel", () => {
  beforeEach(() => {
    updateMock.mockReset();
    updateMock.mockResolvedValue(undefined);
  });

  it("shows both local and UTC resume timestamp labels", () => {
    render(<EventModePanel />);

    expect(screen.getByText(/Resumes at \(Local\):/i)).toBeInTheDocument();
    expect(screen.getByText(/Resumes at \(UTC\):/i)).toBeInTheDocument();
  });

  it("resume flow clears both pause timestamp and pause reason fields", async () => {
    render(<EventModePanel />);

    fireEvent.click(screen.getByRole("button", { name: /resume now/i }));

    expect(updateMock).toHaveBeenCalledWith({
      tradingPausedUntil: null,
      pauseReason: null,
    });
  });
});
