import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomRpcModal from "./CustomRpcModal";
import {
  DEFAULT_RPC,
  RPC_STORAGE_KEY,
  pingEvmRpc,
  pingHorizon,
  writeStoredRpc,
} from "@/lib/customRpc";

vi.mock("@/lib/customRpc", async () => {
  const actual = await vi.importActual("@/lib/customRpc");
  return {
    ...actual,
    pingHorizon: vi.fn(),
    pingEvmRpc: vi.fn(),
  };
});

describe("CustomRpcModal — adapter isolation (#123)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    pingHorizon.mockResolvedValue({ ok: true });
    pingEvmRpc.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to the Stellar Horizon tab and does not require Avalanche validation", async () => {
    const onClose = vi.fn();
    render(<CustomRpcModal open onClose={onClose} />);

    expect(screen.getByTestId("rpc-tab-stellar")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("rpc-input-horizon")).toBeInTheDocument();
    expect(screen.queryByTestId("rpc-input-avalanche")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rpc-save-btn"));

    await waitFor(() => {
      expect(pingHorizon).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
    expect(pingEvmRpc).not.toHaveBeenCalled();

    const stored = JSON.parse(localStorage.getItem(RPC_STORAGE_KEY));
    expect(stored.horizon).toBeTruthy();
  });

  it("saves Avalanche endpoints independently without re-validating Horizon", async () => {
    writeStoredRpc({ horizon: "https://horizon-custom.example" });
    const onClose = vi.fn();
    render(<CustomRpcModal open onClose={onClose} />);

    fireEvent.click(screen.getByTestId("rpc-tab-avalanche"));
    expect(screen.getByTestId("rpc-panel-avalanche")).toBeInTheDocument();
    expect(screen.getByTestId("rpc-input-avalanche")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rpc-save-btn"));

    await waitFor(() => {
      expect(pingEvmRpc).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
    expect(pingHorizon).not.toHaveBeenCalled();

    const stored = JSON.parse(localStorage.getItem(RPC_STORAGE_KEY));
    expect(stored.horizon).toBe("https://horizon-custom.example");
    expect(stored.avalanche).toBeTruthy();
  });

  it("blocks Horizon save when validation fails without touching Avalanche fields", async () => {
    pingHorizon.mockResolvedValue({ ok: false, error: "Not Horizon" });
    const onClose = vi.fn();
    render(<CustomRpcModal open onClose={onClose} />);

    fireEvent.change(screen.getByTestId("rpc-input-horizon"), {
      target: { value: "https://bad-horizon.example" },
    });
    fireEvent.click(screen.getByTestId("rpc-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("rpc-diagnostics")).toHaveTextContent(/fix the Horizon URL/i);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(pingEvmRpc).not.toHaveBeenCalled();
  });

  it("keeps public Avalanche defaults available under the Avalanche tab (non-goal)", () => {
    render(<CustomRpcModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("rpc-tab-avalanche"));
    expect(screen.getByTestId("rpc-input-avalanche")).toHaveValue(DEFAULT_RPC.avalanche);
    expect(screen.getByTestId("rpc-input-avalancheFuji")).toHaveValue(DEFAULT_RPC.avalancheFuji);
  });
});
