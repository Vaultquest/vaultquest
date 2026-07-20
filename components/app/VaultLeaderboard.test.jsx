import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { VaultLeaderboard } from "./VaultLeaderboardPlaceholder";
import { formatPrivacyAddress, sortLeaderboardEntries } from "@/services/leaderboardService";

vi.mock("@/services/leaderboardService", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getLeaderboardData: vi.fn(),
  };
});

import { getLeaderboardData } from "@/services/leaderboardService";

const MOCK_ENTRIES = [
  {
    rank: 1,
    previousRank: 2,
    walletAddress: "GABCD1234567890STUVWXWXYZ1234567890ALPHA",
    displayName: "GABC...LPHA",
    vaultId: "v_usdc",
    vaultName: "USDC Vault",
    depositedAmount: 5000,
    asset: "USDC",
    ticketsCount: 100,
    prizeWins: 2,
    score: 9500,
    state: "rising",
    lastActivity: "5m ago",
  },
  {
    rank: 2,
    previousRank: 1,
    walletAddress: "GBBDU9876543210ZYXWVUTSRQPONMLKJIHGBETA",
    displayName: "GBBD...BETA",
    vaultId: "v_xlm",
    vaultName: "XLM Vault",
    depositedAmount: 3000,
    asset: "XLM",
    ticketsCount: 60,
    prizeWins: 0,
    score: 7200,
    state: "holding",
    lastActivity: "1h ago",
  },
];

describe("VaultLeaderboard Component & Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("formatPrivacyAddress", () => {
    it("formats Stellar public key into privacy-conscious string", () => {
      const address = "GABCD1234567890STUVWXWXYZ1234567890ALPHA";
      expect(formatPrivacyAddress(address)).toBe("GABC...LPHA");
    });

    it("formats EVM address into privacy-conscious string", () => {
      const address = "0x1234567890abcdef1234567890abcdef12345678";
      expect(formatPrivacyAddress(address)).toBe("0x12...5678");
    });

    it("handles null or short input gracefully", () => {
      expect(formatPrivacyAddress(null)).toBe("Anonymous Saver");
      expect(formatPrivacyAddress("12345")).toBe("12345");
    });
  });

  describe("sortLeaderboardEntries", () => {
    it("sorts entries by score descending", () => {
      const unsorted = [
        { ...MOCK_ENTRIES[1], score: 5000 },
        { ...MOCK_ENTRIES[0], score: 9000 },
      ];
      const sorted = sortLeaderboardEntries(unsorted);
      expect(sorted[0].score).toBe(9000);
      expect(sorted[1].score).toBe(5000);
    });
  });

  describe("VaultLeaderboard UI component", () => {
    it("renders initial populated data when provided", () => {
      render(<VaultLeaderboard initialData={MOCK_ENTRIES} />);

      expect(screen.getByText("Saver Leaderboard")).toBeInTheDocument();
      expect(screen.getByText("GABC...LPHA")).toBeInTheDocument();
      expect(screen.getByText("GBBD...BETA")).toBeInTheDocument();
      expect(screen.getByText("9,500 pts")).toBeInTheDocument();
      expect(screen.getByText("7,200 pts")).toBeInTheDocument();
    });

    it("fetches data and displays populated state on success", async () => {
      getLeaderboardData.mockResolvedValueOnce({
        success: true,
        data: MOCK_ENTRIES,
        total: 2,
        updatedAt: "2026-07-20T12:00:00Z",
        source: "indexed",
      });

      render(<VaultLeaderboard />);

      await waitFor(() => {
        expect(screen.getByText("Live indexed data")).toBeInTheDocument();
      });

      expect(screen.getByText("GABC...LPHA")).toBeInTheDocument();
    });

    it("renders error state and handles retry action", async () => {
      getLeaderboardData.mockRejectedValueOnce(new Error("Network Error"));

      render(<VaultLeaderboard />);

      await waitFor(() => {
        expect(screen.getByTestId("leaderboard-error")).toBeInTheDocument();
      });

      expect(screen.getByText("Leaderboard Unavailable")).toBeInTheDocument();

      getLeaderboardData.mockResolvedValueOnce({
        success: true,
        data: MOCK_ENTRIES,
        total: 2,
        updatedAt: "2026-07-20T12:00:00Z",
        source: "indexed",
      });

      fireEvent.click(screen.getByRole("button", { name: /retry/i }));

      await waitFor(() => {
        expect(screen.getByText("GABC...LPHA")).toBeInTheDocument();
      });
    });

    it("renders empty state when no entries are returned", async () => {
      getLeaderboardData.mockResolvedValueOnce({
        success: true,
        data: [],
        total: 0,
        updatedAt: "2026-07-20T12:00:00Z",
        source: "indexed",
      });

      render(<VaultLeaderboard />);

      await waitFor(() => {
        expect(screen.getByTestId("leaderboard-empty")).toBeInTheDocument();
      });

      expect(screen.getByText("No leaderboard activity yet")).toBeInTheDocument();
    });
  });
});
