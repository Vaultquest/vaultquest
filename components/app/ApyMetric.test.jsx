import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ApyMetric from "./ApyMetric";
import { APY_METRIC } from "@/lib/apy-metrics";

describe("ApyMetric", () => {
  it.each([
    [APY_METRIC.REALIZED, "Realized APY"],
    [APY_METRIC.PROJECTED, "Projected APY"],
    [APY_METRIC.PRIZE_FUNDED, "Prize-funded yield"],
  ])("renders the %s taxonomy label and tooltip", (metric, label) => {
    render(<ApyMetric metric={metric} value={5.2} locale="en-US" />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(`^${label}:`))).toBeInTheDocument();
    expect(screen.getByText("5.2%")).toBeInTheDocument();
  });

  it("renders missing data as unavailable rather than zero", () => {
    render(<ApyMetric metric={APY_METRIC.REALIZED} value={null} />);
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });
});
