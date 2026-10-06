import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountPage from "./page";

const mockWagmi = vi.hoisted(() => ({
  useAccount: vi.fn(),
  useChainId: vi.fn(),
}));

vi.mock("wagmi", () => mockWagmi);
vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}));
vi.mock("@/lib/wagmi", () => ({
  SUPPORTED_CHAINS: [
    { id: 43114, name: "Avalanche" },
    { id: 43113, name: "Avalanche Fuji" },
  ],
}));
vi.mock("@/components/hooks/useYieldCounter", () => ({
  useYieldCounter: () => 12.34,
}));
vi.mock("@/components/app/VaultOnboardingTour", () => ({
  __esModule: true,
  default: () => null,
  useRestartTour: () => vi.fn(),
}));

vi.mock("@/components/app/AccountPositionSummary", () => ({
  default: () => <div>position-summary</div>,
}));
vi.mock("@/components/app/UserDepositsList", () => ({
  default: () => <div>deposits</div>,
}));
vi.mock("@/components/app/ProfileEditor", () => ({
  default: () => <div>profile</div>,
}));
vi.mock("@/components/app/LevelOnboarding", () => ({
  default: () => <div>level</div>,
}));
vi.mock("@/components/app/BadgesGallery", () => ({
  default: () => <div>badges</div>,
}));
vi.mock("@/components/app/PrizeChart", () => ({
  default: () => <div>chart</div>,
}));
vi.mock("@/components/app/VaultNotificationSettings", () => ({
  default: () => <div>notifications</div>,
}));
vi.mock("@/components/app/WalletReconnectGuidance", () => ({
  default: ({ isNetworkMismatch, isDisconnected }) => (
    <div>
      {isNetworkMismatch ? "mismatch-guidance" : null}
      {isDisconnected ? "disconnect-guidance" : null}
    </div>
  ),
}));
vi.mock("@/components/app/SecurityTipsPanel", () => ({
  default: () => <div>security</div>,
}));

describe("AccountPage", () => {
  beforeEach(() => {
    delete window.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__;
    window.history.replaceState({}, "", "/app/account");
    mockWagmi.useAccount.mockReturnValue({ isConnected: false, chainId: undefined });
    mockWagmi.useChainId.mockReturnValue(43113);
  });

  it("renders the never-connected empty state without disconnect recovery", async () => {
    render(<AccountPage />);
    expect(await screen.findByText(/Wallet not connected/i)).toBeInTheDocument();
    expect(screen.queryByText("disconnect-guidance")).not.toBeInTheDocument();
  });

  it("renders the connected dashboard from wagmi without URL fixtures", async () => {
    mockWagmi.useAccount.mockReturnValue({ isConnected: true, chainId: 43113 });
    render(<AccountPage />);
    expect(await screen.findByText("position-summary")).toBeInTheDocument();
    expect(screen.queryByText(/Wallet not connected/i)).not.toBeInTheDocument();
  });

  it.each([
    [1, 43114],
    [137, 43113],
  ])("detects wallet chain %i while the configured chain remains %i", async (walletChainId, configuredChainId) => {
    mockWagmi.useAccount.mockReturnValue({ isConnected: true, chainId: walletChainId });
    mockWagmi.useChainId.mockReturnValue(configuredChainId);
    render(<AccountPage />);
    expect(await screen.findByText("mismatch-guidance")).toBeInTheDocument();
  });

  it("applies mockConnected when the E2E runtime flag is present", async () => {
    window.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__ = true;
    window.history.replaceState({}, "", "/app/account?mockConnected=true");
    render(<AccountPage />);
    await waitFor(() => {
      expect(screen.getByText("position-summary")).toBeInTheDocument();
    });
  });
  it.each([true, false])(
    "keeps mismatch-only production URL fixtures gated when runtime authorization is %s",
    async (runtimeAuthorized) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PUBLIC_ALLOW_ACCOUNT_TEST_FIXTURES", "false");
      window.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__ = runtimeAuthorized;
      window.history.replaceState({}, "", "/app/account?networkMismatch=true");

      try {
        render(<AccountPage />);
        expect(await screen.findByText(/Wallet not connected/i)).toBeInTheDocument();
        expect(screen.queryByText("position-summary")).not.toBeInTheDocument();

        if (runtimeAuthorized) {
          expect(await screen.findByText("mismatch-guidance")).toBeInTheDocument();
          expect(screen.queryByText("disconnect-guidance")).not.toBeInTheDocument();
        } else {
          expect(screen.queryByText("mismatch-guidance")).not.toBeInTheDocument();
          expect(screen.queryByText("disconnect-guidance")).not.toBeInTheDocument();
        }
      } finally {
        vi.unstubAllEnvs();
        delete window.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__;
      }
    },
  );

  it("tracks supported, unsupported and disconnected states through real wagmi hooks", async () => {
    const { createConfig, createConnector, WagmiProvider, useAccount, useChainId } =
      await vi.importActual("wagmi");
    const { connect, disconnect, getAccount, getChainId } =
      await vi.importActual("wagmi/actions");
    mockWagmi.useAccount.mockImplementation(useAccount);
    mockWagmi.useChainId.mockImplementation(useChainId);

    const accounts = ["0x1111111111111111111111111111111111111111"];
    let walletChainId = 43114;
    const config = createConfig({
      chains: [
        { id: 43114, name: "Avalanche" },
        { id: 43113, name: "Avalanche Fuji" },
      ],
      connectors: [
        createConnector(({ emitter }) => ({
          id: "account-page-test",
          name: "Account page test wallet",
          type: "mock",
          async connect() { return { accounts, chainId: walletChainId }; },
          async disconnect() {},
          async getAccounts() { return accounts; },
          async getChainId() { return walletChainId; },
          async getProvider() { return {}; },
          async isAuthorized() { return false; },
          onAccountsChanged(nextAccounts) { emitter.emit("change", { accounts: nextAccounts }); },
          onChainChanged(chain) {
            walletChainId = Number(chain);
            emitter.emit("change", { chainId: walletChainId });
          },
          onDisconnect() { emitter.emit("disconnect"); },
        })),
      ],
      transports: {},
      storage: null,
      multiInjectedProviderDiscovery: false,
    });
    const connector = config.connectors[0];

    render(
      <WagmiProvider config={config} reconnectOnMount={false}>
        <AccountPage />
      </WagmiProvider>,
    );
    expect(await screen.findByText(/Wallet not connected/i)).toBeInTheDocument();
    expect(screen.queryByText("disconnect-guidance")).not.toBeInTheDocument();

    await act(() => connect(config, { connector }));
    expect(await screen.findByText("position-summary")).toBeInTheDocument();
    expect(screen.queryByText("mismatch-guidance")).not.toBeInTheDocument();

    await act(async () => connector.onChainChanged("0x1"));
    expect(getAccount(config).chainId).toBe(1);
    expect(getChainId(config)).toBe(43114);
    expect(await screen.findByText("mismatch-guidance")).toBeInTheDocument();

    await act(async () => connector.onChainChanged("0xa869"));
    expect(getAccount(config).chainId).toBe(43113);
    expect(getChainId(config)).toBe(43113);
    expect(screen.queryByText("mismatch-guidance")).not.toBeInTheDocument();

    await act(async () => connector.onChainChanged("0x89"));
    expect(getAccount(config).chainId).toBe(137);
    expect(getChainId(config)).toBe(43113);
    expect(await screen.findByText("mismatch-guidance")).toBeInTheDocument();

    await act(() => disconnect(config, { connector }));
    expect(await screen.findByText(/Wallet not connected/i)).toBeInTheDocument();
    expect(await screen.findByText("disconnect-guidance")).toBeInTheDocument();
    expect(screen.queryByText("mismatch-guidance")).not.toBeInTheDocument();
    expect(screen.queryByText("position-summary")).not.toBeInTheDocument();
  });

});
