import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomRpcModal from "./CustomRpcModal";
import * as customRpc from "@/lib/customRpc";

describe("CustomRpcModal - Chain Adapter Separation (#123)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders Stellar Horizon tab by default and isolates Stellar fields from Avalanche", () => {
    render(<CustomRpcModal open={true} onClose={vi.fn()} />);

    // Stellar Horizon URL is present
    expect(screen.getByLabelText(/stellar horizon url/i)).toBeInTheDocument();

    // Avalanche RPC fields are NOT in the active Stellar view
    expect(screen.queryByLabelText(/avalanche c-chain rpc/i)).toBeNull();
    expect(screen.queryByLabelText(/avalanche fuji rpc/i)).toBeNull();
  });

  it("switches between Stellar and Avalanche network tabs cleanly", () => {
    render(<CustomRpcModal open={true} onClose={vi.fn()} />);

    // Switch to Avalanche
    fireEvent.click(screen.getByTestId("rpc-tab-avalanche"));
    expect(screen.getByLabelText(/avalanche c-chain rpc/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/avalanche fuji rpc/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/stellar horizon url/i)).toBeNull();

    // Switch back to Stellar
    fireEvent.click(screen.getByTestId("rpc-tab-stellar"));
    expect(screen.getByLabelText(/stellar horizon url/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/avalanche c-chain rpc/i)).toBeNull();
  });

  it("saves Stellar Horizon endpoint independently without validating Avalanche", async () => {
    const pingHorizonSpy = vi.spyOn(customRpc, "pingHorizon").mockResolvedValue({ ok: true });
    const pingEvmRpcSpy = vi.spyOn(customRpc, "pingEvmRpc").mockResolvedValue({ ok: false, error: "Offline" });
    const onClose = vi.fn();

    render(<CustomRpcModal open={true} onClose={onClose} network="stellar" />);

    const input = screen.getByLabelText(/stellar horizon url/i);
    fireEvent.change(input, { target: { value: "https://horizon-custom.stellar.org" } });

    // Click Save & apply
    fireEvent.click(screen.getByTestId("save-rpc-btn"));

    await waitFor(() => {
      expect(pingHorizonSpy).toHaveBeenCalledWith("https://horizon-custom.stellar.org");
    });

    // pingEvmRpc should NOT have been called because we are in the Stellar adapter!
    expect(pingEvmRpcSpy).not.toHaveBeenCalled();

    // Modal closed upon successful save
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("resets active network endpoint to defaults", async () => {
    render(<CustomRpcModal open={true} onClose={vi.fn()} network="stellar" />);

    const input = screen.getByLabelText(/stellar horizon url/i);
    fireEvent.change(input, { target: { value: "https://temporary.org" } });
    expect(input).toHaveValue("https://temporary.org");

    fireEvent.click(screen.getByTestId("reset-rpc-btn"));
    expect(input).toHaveValue(customRpc.DEFAULT_RPC.horizon);
  });
});
