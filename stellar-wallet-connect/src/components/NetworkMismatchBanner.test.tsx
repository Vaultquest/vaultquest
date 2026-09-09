import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NetworkMismatchBanner } from "./NetworkMismatchBanner";

describe("NetworkMismatchBanner", () => {
  it("renders with alert role and assertive live region for accessibility", () => {
    render(
      <NetworkMismatchBanner
        connectedNetwork="public"
        expectedNetwork="testnet"
        actionName="Deposits"
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(alert).toHaveAttribute("data-testid", "network-mismatch-banner");
  });

  it("displays action name, expected network and connected network", () => {
    render(
      <NetworkMismatchBanner
        connectedNetwork="futurenet"
        expectedNetwork="testnet"
        actionName="Withdrawals"
      />,
    );

    expect(screen.getByText("Network Mismatch Detected")).toBeInTheDocument();
    expect(screen.getByText(/Withdrawals are blocked/i)).toBeInTheDocument();
    expect(screen.getByTestId("expected-network")).toHaveTextContent("Stellar Testnet (testnet)");
    expect(screen.getByTestId("actual-network")).toHaveTextContent("Stellar Futurenet (futurenet)");
    expect(screen.getByText(/Switch your wallet network to/i)).toBeInTheDocument();
  });

  it("handles unknown or fallback network types gracefully", () => {
    render(
      <NetworkMismatchBanner
        connectedNetwork={null}
        expectedNetwork="testnet"
        actionName="Reward claims"
      />,
    );

    expect(screen.getByText(/Reward claims are blocked/i)).toBeInTheDocument();
    expect(screen.getByTestId("actual-network")).toHaveTextContent("Unknown network");
  });
});
