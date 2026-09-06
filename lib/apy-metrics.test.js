import { describe, expect, it } from "vitest";
import { APY_METRIC, APY_METRIC_COPY, formatApy, getApyMetric } from "./apy-metrics";

describe("APY metric taxonomy", () => {
  it.each([
    [APY_METRIC.REALIZED, "Realized APY"],
    [APY_METRIC.PROJECTED, "Projected APY"],
    [APY_METRIC.PRIZE_FUNDED, "Prize-funded yield"],
  ])("defines %s separately", (metric, label) => {
    expect(APY_METRIC_COPY[metric].label).toBe(label);
    expect(getApyMetric(metric, 4.25, "en-US")).toMatchObject({ metric, label, value: "4.25%" });
  });

  it.each([null, undefined, "", Number.NaN, Number.POSITIVE_INFINITY, -1, "not-a-rate"])(
    "keeps unavailable value %s unavailable",
    (value) => expect(formatApy(value, "en-US")).toBeNull(),
  );

  it("preserves a measured zero instead of treating it as missing", () => {
    expect(formatApy(0, "en-US")).toBe("0%");
  });

  it("uses locale-aware decimal separators", () => {
    expect(formatApy(4.25, "en-US")).toBe("4.25%");
    expect(formatApy(4.25, "de-DE")).toBe("4,25%");
  });

  it("rejects unknown metric types instead of silently relabelling them", () => {
    expect(() => getApyMetric("combined", 4.25, "en-US")).toThrow(TypeError);
  });
});
