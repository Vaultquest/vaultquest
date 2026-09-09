import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminSettingsPage from "./page";
import {
  CANONICAL_PROVENANCE,
  evaluateRpcHealth,
  evaluateIndexerHealth,
  verifyContractProvenance,
  detectConfigDrift,
  aggregateAdminHealth,
} from "@/lib/deployment-provenance";

function makeHealthState({
  rpcResult = { ok: true, latencyMs: 110, networkPassphrase: CANONICAL_PROVENANCE.network.passphrase },
  indexerData = { latest_ledger: 1542890, sync_lag: 0, last_error: null },
  contractHash = CANONICAL_PROVENANCE.contract.expectedWasmHash,
  runtimeConfig = {},
} = {}) {
  const rpc = evaluateRpcHealth(rpcResult);
  const indexer = evaluateIndexerHealth(indexerData);
  const contract = verifyContractProvenance(contractHash);
  const drift = detectConfigDrift(runtimeConfig);
  return aggregateAdminHealth(rpc, indexer, contract, drift);
}

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("AdminSettingsPage live dependency health and config drift", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(makeHealthState())));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders live dependency health in healthy state", async () => {
    const healthyHealth = makeHealthState();
    render(<AdminSettingsPage initialHealth={healthyHealth} />);

    await waitFor(() => {
      expect(screen.getByText("Settings Overview")).toBeInTheDocument();
    });

    expect(screen.getAllByText("Protocol parameters").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Active rounds").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Service status").length).toBeGreaterThanOrEqual(2);

    expect(screen.getByTestId("config-drift-clean")).toBeInTheDocument();
    expect(
      screen.getByText(/Configuration synchronized: active parameters match canonical/i),
    ).toBeInTheDocument();

    expect(screen.getByText("Stellar Horizon & RPC")).toBeInTheDocument();
    expect(screen.getByText("Event Indexer")).toBeInTheDocument();
    expect(screen.getByText("Smart Contract Hash")).toBeInTheDocument();
    expect(screen.getByText("Configuration Drift")).toBeInTheDocument();

    const healthyBadges = screen.getAllByText("Healthy");
    expect(healthyBadges.length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("4/4")).toBeInTheDocument();
  });

  it("renders stale state when indexer lag or RPC latency is elevated", async () => {
    const staleHealth = makeHealthState({
      rpcResult: { ok: true, latencyMs: 1850 },
      indexerData: { latest_ledger: 1542890, sync_lag: 35, last_error: null },
    });
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(staleHealth)));

    render(<AdminSettingsPage initialHealth={staleHealth} />);

    await waitFor(() => {
      expect(screen.getByText("35 ledgers", { exact: false })).toBeInTheDocument();
    });
    expect(screen.getByText("High RPC latency detected (1850ms >= 1500ms threshold).")).toBeInTheDocument();

    const staleBadges = screen.getAllByText("Stale");
    expect(staleBadges.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/2 stale, 0 degraded/i)).toBeInTheDocument();

    const runbookLinks = screen.getAllByText(/Runbook/i);
    expect(runbookLinks.length).toBeGreaterThan(0);
  });

  it("renders degraded state and visible config drift when parameters diverge from provenance", async () => {
    const degradedHealth = makeHealthState({
      runtimeConfig: {
        treasuryFee: "2.5%",
        settlementQuorum: "1 of 5",
      },
      indexerData: {
        latest_ledger: 1542890,
        sync_lag: 200,
        last_error: "Horizon rate limit exceeded",
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(degradedHealth)));

    render(<AdminSettingsPage initialHealth={degradedHealth} />);

    await waitFor(() => {
      expect(screen.getByTestId("config-drift-alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/Configuration Drift Detected \(2 parameters\)/i)).toBeInTheDocument();

    expect(screen.getByText("treasuryFee")).toBeInTheDocument();
    expect(screen.getByText("2.5%")).toBeInTheDocument();
    expect(screen.getByText("settlementQuorum")).toBeInTheDocument();
    expect(screen.getByText("1 of 5")).toBeInTheDocument();

    const criticalBadges = screen.getAllByText("critical");
    expect(criticalBadges.length).toBe(2);

    const degradedBadges = screen.getAllByText("Degraded");
    expect(degradedBadges.length).toBeGreaterThanOrEqual(2);

    expect(screen.getByText(/Drift runbook/i)).toBeInTheDocument();
  });

  it("triggers manual health refresh when clicking Refresh health button", async () => {
    const fetchMock = vi.fn(() => jsonResponse(makeHealthState()));
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminSettingsPage />);

    const refreshButton = screen.getByRole("button", { name: /Refresh health checks/i });
    await userEvent.click(refreshButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
  });
});
