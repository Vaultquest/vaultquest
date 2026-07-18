import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HeaderWalletStatus from "./HeaderWalletStatus";
import UnsupportedNetworkBanner from "./UnsupportedNetworkBanner";
import { connectedNetwork, connectedPublicKey, isNetworkMismatch } from "@vaultquest/stellar-wallet-connect/src/core/store";

const walletService = vi.hoisted(() => ({
  connectWallet: vi.fn(),
  disconnectWallet: vi.fn(),
  disconnect: vi.fn(),
  getConnectedNetwork: vi.fn(),
  getWalletHealth: vi.fn(),
  initializeConnection: vi.fn(),
  loadedProvider: vi.fn(),
  setConnection: vi.fn(),
}));

const mockWagmiHooks = vi.hoisted(() => ({
  useAccount: vi.fn(),
  useChainId: vi.fn(),
  useSwitchChain: vi.fn(),
}));

vi.mock("@vaultquest/stellar-wallet-connect/src/core/walletService", () => walletService);
vi.mock("wagmi", () => mockWagmiHooks);
vi.mock("@/lib/wagmi", () => ({
  DEFAULT_CHAIN: { id: 43113, name: "Avalanche Fuji" },
  SUPPORTED_CHAINS: [
    { id: 43114, name: "Avalanche" },
    { id: 43113, name: "Avalanche Fuji" },
  ],
}));

const TEST_PUBLIC_KEY = "GABCD1234567890XYZ9876543210ABCDE";

function resetStores() {
  connectedPublicKey.set("");
  connectedNetwork.set(null);
  isNetworkMismatch.set(false);
}

async function renderWalletStatus(props) {
  const view = render(<HeaderWalletStatus {...props} />);
  await act(async () => {});
  return view;
}

describe("HeaderWalletStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    window.freighterApi = undefined;
    window.freighter = undefined;
    walletService.initializeConnection.mockReturnValue(null);
    walletService.loadedProvider.mockReturnValue(null);
    walletService.getConnectedNetwork.mockResolvedValue("testnet");
    walletService.getWalletHealth.mockResolvedValue({
      exists: true,
      balances: { XLM: 12.25, USDC: 3.5 },
    });
  });

  it("renders the disconnected call to action", async () => {
    await renderWalletStatus();

    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeEnabled();
    expect(screen.queryByLabelText(/wallet connection status/i)).not.toBeInTheDocument();
  });

  it("shows connecting state while connect is in flight", async () => {
    let resolveConnect;
    walletService.connectWallet.mockReturnValue(
      new Promise((resolve) => {
        resolveConnect = resolve;
      }),
    );

    await renderWalletStatus();
    fireEvent.click(screen.getByRole("button", { name: /connect wallet/i }));

    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeDisabled();

    await act(async () => {
      resolveConnect({ provider: "freighter", publicKey: TEST_PUBLIC_KEY, address: TEST_PUBLIC_KEY });
    });
  });

  it("renders connected account and loaded balances", async () => {
    connectedPublicKey.set(TEST_PUBLIC_KEY);
    connectedNetwork.set("testnet");

    await renderWalletStatus();

    const status = screen.getByLabelText(/wallet connection status/i);
    expect(within(status).getByText("GABC...CDE")).toBeInTheDocument();
    expect(await within(status).findByText("12.25 XLM · 3.5 USDC")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect wallet\. testnet connected/i })).toBeEnabled();
  });

  it("does not present stale balances as final values while refreshing", async () => {
    connectedPublicKey.set(TEST_PUBLIC_KEY);
    let resolveNetwork;
    walletService.getConnectedNetwork.mockReturnValue(
      new Promise((resolve) => {
        resolveNetwork = resolve;
      }),
    );
    walletService.getWalletHealth.mockReturnValue(new Promise(() => {}));

    render(<HeaderWalletStatus />);

    expect(screen.getByText(/refreshing balance/i)).toBeInTheDocument();
    expect(screen.queryByText(/xlm/i)).not.toBeInTheDocument();

    await act(async () => {
      resolveNetwork("testnet");
    });
  });

  it("renders balance errors without replacing the connected status", async () => {
    connectedPublicKey.set(TEST_PUBLIC_KEY);
    walletService.getWalletHealth.mockRejectedValue(new Error("Horizon unavailable"));

    await renderWalletStatus();

    expect(await screen.findByText(/balance unavailable/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/wallet connection status/i)).toBeInTheDocument();
  });

  it("clears connected UI when the browser wallet extension disconnects externally", async () => {
    connectedPublicKey.set(TEST_PUBLIC_KEY);
    window.freighterApi = {
      isAllowed: vi.fn().mockResolvedValue(true),
      isConnected: vi.fn().mockResolvedValue(false),
    };

    await renderWalletStatus();

    await waitFor(() => expect(window.freighterApi.isConnected).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
  });

  it("marks a connected wallet on the wrong Stellar network", async () => {
    connectedPublicKey.set(TEST_PUBLIC_KEY);
    connectedNetwork.set("futurenet");
    isNetworkMismatch.set(true);
    let resolveNetwork;
    walletService.getConnectedNetwork.mockReturnValue(
      new Promise((resolve) => {
        resolveNetwork = resolve;
      }),
    );

    render(<HeaderWalletStatus />);

    expect(await screen.findByRole("button", { name: /disconnect wallet\. wrong network/i })).toBeInTheDocument();

    await act(async () => {
      resolveNetwork("futurenet");
    });
  });
});

describe("UnsupportedNetworkBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWagmiHooks.useAccount.mockReturnValue({ isConnected: true });
    mockWagmiHooks.useChainId.mockReturnValue(43113);
    mockWagmiHooks.useSwitchChain.mockReturnValue({ switchChain: vi.fn(), isPending: false });
  });

  it("stays hidden while disconnected", () => {
    mockWagmiHooks.useAccount.mockReturnValue({ isConnected: false });

    render(<UnsupportedNetworkBanner />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("stays hidden on supported networks", () => {
    mockWagmiHooks.useChainId.mockReturnValue(43113);

    render(<UnsupportedNetworkBanner />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a switch-network action only for unsupported networks", () => {
    const switchChain = vi.fn();
    mockWagmiHooks.useChainId.mockReturnValue(1);
    mockWagmiHooks.useSwitchChain.mockReturnValue({ switchChain, isPending: false });

    render(<UnsupportedNetworkBanner />);
    fireEvent.click(screen.getByRole("button", { name: /switch to avalanche fuji/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/unsupported network/i);
    expect(switchChain).toHaveBeenCalledWith({ chainId: 43113 });
  });
});
