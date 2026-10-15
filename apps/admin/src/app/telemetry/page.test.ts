import { beforeEach, describe, expect, it, vi } from "vitest";

import TelemetryPage from "./page";

const data = vi.hoisted(() => ({
  getCost: vi.fn(), getHealth: vi.fn(), getBusiness: vi.fn(),
}));
vi.mock("@/lib/access", () => ({ guardPage: async () => ({ ok: true }) }));
vi.mock("@/lib/data", () => data);

beforeEach(() => {
  vi.resetAllMocks();
  data.getCost.mockResolvedValue({ from: "", to: "", totalCostUsd: 0, totalCalls: 0, rows: [] });
  data.getHealth.mockResolvedValue({ source: "unavailable", window: "1h", services: [], degraded: false });
  data.getBusiness.mockResolvedValue({ enabled: false, from: "", to: "" });
});

describe("telemetry date filters", () => {
  it.each([
    ["2026-10-14", "2026-10-15"],
    ["2026-10-31", "2026-11-01"],
    ["2026-12-31", "2027-01-01"],
    ["2028-02-29", "2028-03-01"],
  ])("includes the entire selected day %s in both reports", async (day, nextDay) => {
    await TelemetryPage({ searchParams: Promise.resolve({ from: day, to: day, groupBy: "tenant" }) });
    expect(data.getCost).toHaveBeenCalledWith(day, nextDay, "tenant");
    expect(data.getBusiness).toHaveBeenCalledWith(day, nextDay);
  });

  it("keeps the backend default window when no dates are selected", async () => {
    await TelemetryPage({ searchParams: Promise.resolve({}) });
    expect(data.getCost).toHaveBeenCalledWith(undefined, undefined, "service");
    expect(data.getBusiness).toHaveBeenCalledWith(undefined, undefined);
  });

  it("does not forward malformed or nonexistent calendar dates", async () => {
    await TelemetryPage({ searchParams: Promise.resolve({ from: "invalid", to: "2026-02-30", groupBy: "invalid" }) });
    expect(data.getCost).toHaveBeenCalledWith(undefined, undefined, "service");
    expect(data.getBusiness).toHaveBeenCalledWith(undefined, undefined);
  });
});
