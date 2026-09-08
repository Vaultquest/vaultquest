import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import VaultActivityExport from "./VaultActivityExport";

const MOCK_ACTIVITIES = [
  {
    id: "tx-1",
    type: "deposit",
    pool: "USDC Vault",
    asset: "USDC",
    amount: 100,
    date: "2026-06-01T12:00:00.000Z",
    status: "confirmed",
    walletAddress: "0x1111111111111111111111111111111111111111",
    counterparty: "0x2222222222222222222222222222222222222222",
    memo: "Private note",
  },
  {
    id: "tx-2",
    type: "reward",
    pool: "USDC Vault",
    asset: "USDC",
    amount: 25,
    date: "2026-06-02T14:00:00.000Z",
    status: "confirmed",
    walletAddress: "0x1111111111111111111111111111111111111111",
  },
];

describe("VaultActivityExport Component", () => {
  let createdBlobUrl;
  let clickSpy;

  beforeEach(() => {
    createdBlobUrl = "blob:https://vaultquest.app/mock-blob-uuid";
    window.URL.createObjectURL = vi.fn(() => createdBlobUrl);
    window.URL.revokeObjectURL = vi.fn();
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders export component with title, checksum indicator, and scope", () => {
    render(
      <VaultActivityExport
        activities={MOCK_ACTIVITIES}
        walletAddress="0x1111111111111111111111111111111111111111"
        network="testnet"
      />
    );

    expect(screen.getByText("Export activity")).toBeDefined();
    expect(screen.getByText("Tamper-Evident SHA-256")).toBeDefined();
    expect(screen.getByText(/0x1111…1111/)).toBeDefined();
    expect(screen.getByText(/SHA-256:/)).toBeDefined();
  });

  it("displays summary statistics when provided", () => {
    render(
      <VaultActivityExport
        activities={MOCK_ACTIVITIES}
        summary={{ deposits: 1, withdrawals: 0, rewards: 1 }}
      />
    );

    expect(screen.getByText("Deposits:")).toBeDefined();
    expect(screen.getByText("Rewards:")).toBeDefined();
    expect(screen.getByText("Total records:")).toBeDefined();
  });

  it("allows toggling between CSV and JSON export formats", () => {
    render(<VaultActivityExport activities={MOCK_ACTIVITIES} />);

    const csvButton = screen.getByRole("button", { name: /^CSV$/i });
    const jsonButton = screen.getByRole("button", { name: /^JSON$/i });
    const exportButton = screen.getByRole("button", { name: /Export CSV/i });

    expect(exportButton).toBeDefined();

    fireEvent.click(jsonButton);
    expect(screen.getByRole("button", { name: /Export JSON/i })).toBeDefined();

    fireEvent.click(csvButton);
    expect(screen.getByRole("button", { name: /Export CSV/i })).toBeDefined();
  });

  it("allows toggling privacy redaction checkbox", () => {
    render(<VaultActivityExport activities={MOCK_ACTIVITIES} />);

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.checked).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("triggers CSV export download and displays success notification", async () => {
    render(
      <VaultActivityExport
        activities={MOCK_ACTIVITIES}
        filename="custom-export"
        walletAddress="0x1111111111111111111111111111111111111111"
      />
    );

    const exportButton = screen.getByRole("button", { name: /Export CSV/i });
    fireEvent.click(exportButton);

    expect(window.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith(createdBlobUrl);

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeDefined();
      expect(screen.getByText(/Downloaded/)).toBeDefined();
      expect(screen.getByText("custom-export.csv")).toBeDefined();
    });
  });

  it("triggers JSON export download with schema envelope and checksum", async () => {
    render(
      <VaultActivityExport
        activities={MOCK_ACTIVITIES}
        filename="custom-export"
      />
    );

    const jsonButton = screen.getByRole("button", { name: /JSON/i });
    fireEvent.click(jsonButton);

    const exportButton = screen.getByRole("button", { name: /Export JSON/i });
    fireEvent.click(exportButton);

    expect(window.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeDefined();
      expect(screen.getByText("custom-export.json")).toBeDefined();
    });
  });

  it("disables export button when activities array is empty", () => {
    render(<VaultActivityExport activities={[]} />);

    const exportButton = screen.getByRole("button", { name: /Export/i });
    expect(exportButton.disabled).toBe(true);
  });
});
