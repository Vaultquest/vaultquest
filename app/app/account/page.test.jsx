import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccountPage from "./page";

const mockOpenConnectModal = vi.fn();
let mockAccountState = {
  isConnected: false,
  chain: { id: 1, name: "Stellar", unsupported: false },
};

vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({
    openConnectModal: mockOpenConnectModal,
  }),
}));

vi.mock("wagmi", () => ({
  useAccount: () => mockAccountState,
}));

// Mock heavyweight nested components to keep unit test isolated and fast
vi.mock("@/components/app/AccountPositionSummary", () => ({
  default: () => <div data-testid="account-position-summary">Position Summary</div>,
}));

vi.mock("@/components/app/UserDepositsList", () => ({
  default: () => <div data-testid="user-deposits-list">Deposits List</div>,
}));

vi.mock("@/components/app/ProfileEditor", () => ({
  default: () => <div data-testid="profile-editor">Profile Editor</div>,
}));

vi.mock("@/components/app/LevelOnboarding", () => ({
  default: () => <div data-testid="level-onboarding">Level Onboarding</div>,
}));

vi.mock("@/components/app/BadgesGallery", () => ({
  default: () => <div data-testid="badges-gallery">Badges Gallery</div>,
}));

vi.mock("@/components/app/PrizeChart", () => ({
  default: () => <div data-testid="prize-chart">Prize Chart</div>,
}));

vi.mock("@/components/app/VaultNotificationSettings", () => ({
  default: () => <div data-testid="vault-notification-settings">Notification Settings</div>,
}));

vi.mock("@/components/app/SecurityTipsPanel", () => ({
  default: () => <div data-testid="security-tips-panel">Security Tips</div>,
}));

vi.mock("@/components/app/VaultOnboardingTour", () => ({
  default: () => <div data-testid="vault-onboarding-tour">Tour</div>,
  useRestartTour: (cb) => cb,
}));

describe("AccountPage — Wallet state isolation and test overrides (#114)", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountState = {
      isConnected: false,
      chain: { id: 1, name: "Stellar", unsupported: false },
    };
    window.history.replaceState({}, "", "/app/account");
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    window.history.replaceState({}, "", "/app/account");
  });

  describe("Production environment (hostile / untrusted public URL parameters)", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
    });

    it("renders disconnected empty state when wallet is not connected", () => {
      render(<AccountPage />);
      expect(screen.getByText("Wallet not connected")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^connect wallet$/i })).toBeInTheDocument();
      expect(screen.queryByText("Active deposits")).not.toBeInTheDocument();
    });

    it("strictly ignores ?mockConnected=true and never forges connection state in production", async () => {
      window.history.replaceState({}, "", "/app/account?mockConnected=true");
      render(<AccountPage />);

      // Must NOT show dashboard or active deposits
      expect(screen.getByText("Wallet not connected")).toBeInTheDocument();
      expect(screen.queryByText("Active deposits")).not.toBeInTheDocument();
      expect(screen.queryByTestId("account-position-summary")).not.toBeInTheDocument();
    });

    it("strictly ignores ?networkMismatch=true query parameter in production", async () => {
      window.history.replaceState({}, "", "/app/account?networkMismatch=true");
      render(<AccountPage />);

      expect(screen.queryByText(/Network Mismatch Detected/i)).not.toBeInTheDocument();
    });

    it("renders connected dashboard when wallet is genuinely connected via wagmi provider", () => {
      mockAccountState = {
        isConnected: true,
        chain: { id: 1, name: "Stellar", unsupported: false },
      };

      render(<AccountPage />);
      expect(screen.getByText("Active deposits")).toBeInTheDocument();
      expect(screen.getByText("Cumulative winnings")).toBeInTheDocument();
      expect(screen.getByTestId("account-position-summary")).toBeInTheDocument();
      expect(screen.queryByText("Wallet not connected")).not.toBeInTheDocument();
    });

    it("derives network mismatch from provider chain.unsupported in production", () => {
      mockAccountState = {
        isConnected: true,
        chain: { id: 99999, name: "UnsupportedChain", unsupported: true },
      };

      render(<AccountPage />);
      expect(screen.getByText(/Network Mismatch Detected/i)).toBeInTheDocument();
    });
  });

  describe("Development / Test environment (test fixture overrides enabled)", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "test";
    });

    it("honors ?mockConnected=true query parameter to support E2E fixtures", async () => {
      window.history.replaceState({}, "", "/app/account?mockConnected=true");
      render(<AccountPage />);

      await waitFor(() => {
        expect(screen.getByText("Active deposits")).toBeInTheDocument();
      });
      expect(screen.getByTestId("account-position-summary")).toBeInTheDocument();
      expect(screen.queryByText("Wallet not connected")).not.toBeInTheDocument();
    });

    it("honors ?networkMismatch=true and renders guidance in dev/test", async () => {
      window.history.replaceState({}, "", "/app/account?mockConnected=true&networkMismatch=true");
      render(<AccountPage />);

      await waitFor(() => {
        expect(screen.getByText(/Network Mismatch Detected/i)).toBeInTheDocument();
      });
    });

    it("handles reconnect guidance retry to prompt wallet connection", async () => {
      const user = userEvent.setup();
      render(<AccountPage />);

      // When disconnected, WalletReconnectGuidance shows "Reconnect Wallet"
      const reconnectButton = screen.getByRole("button", { name: /^reconnect wallet$/i });
      await user.click(reconnectButton);

      expect(mockOpenConnectModal).toHaveBeenCalled();
    });
  });
});
