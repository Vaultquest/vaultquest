import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GasPrioritySelector from "./GasPrioritySelector";

describe("GasPrioritySelector - Stellar Fee Isolation (#123)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches fee_stats from Stellar testnet Horizon and renders stroops, source ledger, and freshness", async () => {
    const mockFeeStats = {
      last_ledger: 5432100,
      last_ledger_base_fee: 120,
      ledger_capacity_usage: "0.15",
    };

    global.fetch = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes("fee_stats")) {
        return new Response(JSON.stringify(mockFeeStats), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const onChange = vi.fn();
    render(
      <GasPrioritySelector
        network="stellar"
        networkType="testnet"
        nativeBalance={25.0}
        onChange={onChange}
      />
    );

    // Verify loading or updated states
    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("120 stroops");
    });

    // Check source ledger
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#5432100");

    // Check freshness
    expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");

    // Verify no EVM/wei leakages anywhere in the DOM
    expect(screen.queryByText(/wei/i)).toBeNull();
    expect(screen.queryByText(/avalanche c-chain/i)).toBeNull();

    // Verify onChange callback payload
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.network).toBe("Stellar");
    expect(lastCall.payload.type).toBe("stellar");
    expect(lastCall.payload.feeStroops).toBe(120);
    expect(lastCall.payload.sourceLedger).toBe("5432100");
    expect(lastCall.payload.isStale).toBe(false);
    expect(lastCall.payload.unsupported).toBe(false);
  });

  it("targets Stellar mainnet Horizon when networkType is mainnet", async () => {
    let requestedUrl = "";
    global.fetch = vi.fn().mockImplementation(async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({ last_ledger: 998877, last_ledger_base_fee: 100 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    render(
      <GasPrioritySelector
        network="stellar"
        networkType="mainnet"
        nativeBalance={50.0}
      />
    );

    await waitFor(() => {
      expect(requestedUrl).toContain("https://horizon.stellar.org/fee_stats");
    });

    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#998877");
  });

  it("respects custom Horizon URL override", async () => {
    let requestedUrl = "";
    global.fetch = vi.fn().mockImplementation(async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({ last_ledger: 112233, last_ledger_base_fee: 150 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    render(
      <GasPrioritySelector
        network="stellar"
        customHorizonUrl="https://my-custom-horizon.org"
      />
    );

    await waitFor(() => {
      expect(requestedUrl).toBe("https://my-custom-horizon.org/fee_stats");
    });

    expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("150 stroops");
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#112233");
  });

  it("handles stale fee data gracefully with fallback when Horizon is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network connection dropped"));

    const onChange = vi.fn();
    render(
      <GasPrioritySelector
        network="stellar"
        nativeBalance={10.0}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Stale data");
    });

    // Fallback base fee is 100 stroops
    expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("100 stroops");
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("Fallback ledger");

    // Stale notice displayed
    expect(screen.getByTestId("fee-warning-alert")).toHaveTextContent(/stale fee notice|network warning/i);

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.isStale).toBe(true);
    expect(lastCall.payload.sourceLedger).toBe("fallback");
  });

  it("renders unsupported network state and alerts the user", async () => {
    render(
      <GasPrioritySelector
        network="stellar"
        isUnsupported={true}
      />
    );

    expect(screen.getByTestId("unsupported-network-alert")).toHaveTextContent(
      /unsupported network/i
    );

    // Tier buttons are disabled
    expect(screen.getByTestId("tier-btn-low")).toBeDisabled();
    expect(screen.getByTestId("tier-btn-medium")).toBeDisabled();
    expect(screen.getByTestId("tier-btn-high")).toBeDisabled();
  });

  it("incorporates Soroban simulationResourceFee into total stroops", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ last_ledger: 654321, last_ledger_base_fee: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const onChange = vi.fn();
    render(
      <GasPrioritySelector
        network="stellar"
        simulationResourceFee={4900} // 4900 stroops resource fee
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("100 stroops");
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    // Base fee (100) + Resource fee (4900) = 5000 stroops = 0.0005 XLM
    expect(lastCall.payload.feeStroops).toBe(5000);
    expect(lastCall.payload.resourceFeeStroops).toBe(4900);
    expect(lastCall.payload.feeBid).toBe("0.000500 XLM");
  });

  it("allows priority tier selection to update multiplier and feeBid", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ last_ledger: 1000, last_ledger_base_fee: 200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const onChange = vi.fn();
    render(
      <GasPrioritySelector
        network="stellar"
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("200 stroops");
    });

    // Switch to High tier (1.25x of 200 = 250 stroops)
    fireEvent.click(screen.getByTestId("tier-btn-high"));

    await waitFor(() => {
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
      expect(lastCall.tier.key).toBe("high");
      expect(lastCall.payload.feeStroops).toBe(250);
      expect(lastCall.payload.feeBid).toBe("0.000025 XLM");
    });
  });

  it("preserves independent Avalanche product fee calculation when network is explicitly avalanche", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: "0x5d21dba00" }), { // 25 gwei
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const onChange = vi.fn();
    render(
      <GasPrioritySelector
        network="avalanche"
        nativeBalance={2.5}
        onChange={onChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent(/wei/i);
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.network).toBe("Avalanche");
    expect(lastCall.payload.type).toBe("evm");
    expect(lastCall.payload.chain).toBe("Avalanche C-Chain");
  });
});
