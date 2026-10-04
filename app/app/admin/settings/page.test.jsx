import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminSettingsPage from "./page";

const HEALTHY_PAYLOAD = {
  status: "healthy",
  checkedAt: "2026-09-25T18:00:00.000Z",
  summary: { healthy: 4, stale: 0, degraded: 0, total: 4 },
  dependencies: [
    {
      id: "rpc",
      name: "Horizon / Soroban RPC",
      kind: "rpc",
      status: "healthy",
      detail: "RPC responding in 90ms on the expected network.",
      latencyMs: 90,
      checkedAt: "2026-09-25T18:00:00.000Z",
      remediationUrl: "https://github.com/Vaultquest/vaultquest/blob/main/docs/ADMIN_HEALTH_REMEDIATION.md#1-rpc-health",
    },
    {
      id: "indexer",
      name: "Event indexer",
      kind: "indexer",
      status: "healthy",
      detail: "Indexer in sync (lag 2 ledgers).",
      checkedAt: "2026-09-25T18:00:00.000Z",
      remediationUrl: "https://github.com/Vaultquest/vaultquest/blob/main/docs/INDEXER_RUNBOOK.md",
    },
    {
      id: "contract_hash",
      name: "Smart contract WASM hash",
      kind: "contract_hash",
      status: "healthy",
      detail: "Contract WASM hash matches canonical v0.1.0 provenance.",
      checkedAt: "2026-09-25T18:00:00.000Z",
      remediationUrl: "https://github.com/Vaultquest/vaultquest/blob/main/docs/ADMIN_HEALTH_REMEDIATION.md#2-contract-wasm-provenance",
    },
    {
      id: "config_drift",
      name: "Configuration drift",
      kind: "config_drift",
      status: "healthy",
      detail: "Runtime protocol parameters match canonical provenance.",
      checkedAt: "2026-09-25T18:00:00.000Z",
      remediationUrl: "https://github.com/Vaultquest/vaultquest/blob/main/docs/ADMIN_HEALTH_REMEDIATION.md#3-configuration-drift",
    },
  ],
  configDrift: {
    status: "healthy",
    hasDrift: false,
    drifts: [],
    checkedAt: "2026-09-25T18:00:00.000Z",
    remediationUrl: "https://github.com/Vaultquest/vaultquest/blob/main/docs/ADMIN_HEALTH_REMEDIATION.md#3-configuration-drift",
  },
};

const STALE_PAYLOAD = {
  ...HEALTHY_PAYLOAD,
  status: "stale",
  summary: { healthy: 3, stale: 1, degraded: 0, total: 4 },
  dependencies: HEALTHY_PAYLOAD.dependencies.map((dep) =>
    dep.id === "indexer"
      ? {
          ...dep,
          status: "stale",
          detail: "Indexer soft lag: 120 ledgers (warning ≥ 100).",
        }
      : dep,
  ),
};

const DEGRADED_PAYLOAD = {
  ...HEALTHY_PAYLOAD,
  status: "degraded",
  summary: { healthy: 2, stale: 0, degraded: 2, total: 4 },
  dependencies: HEALTHY_PAYLOAD.dependencies.map((dep) => {
    if (dep.id === "rpc") {
      return { ...dep, status: "degraded", detail: "Horizon probe timed out" };
    }
    if (dep.id === "config_drift") {
      return {
        ...dep,
        status: "degraded",
        detail: "1 parameter diverges from canonical provenance.",
      };
    }
    return dep;
  }),
  configDrift: {
    status: "degraded",
    hasDrift: true,
    drifts: [
      {
        parameter: "treasuryFee",
        expected: "0.75%",
        actual: "2.00%",
        severity: "critical",
        impact: "Changes yield skim before prize allocation.",
      },
    ],
    checkedAt: "2026-09-25T18:00:00.000Z",
    remediationUrl: "https://github.com/Vaultquest/vaultquest/blob/main/docs/ADMIN_HEALTH_REMEDIATION.md#3-configuration-drift",
  },
};

function mockHealth(payload, { ok = true } = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 503,
    json: async () => payload,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AdminSettingsPage live health", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders healthy live dependency health from /api/admin/health", async () => {
    mockHealth(HEALTHY_PAYLOAD);
    render(<AdminSettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("health-dep-rpc")).toHaveAttribute(
        "data-status",
        "healthy",
      );
    });

    expect(screen.getByText("Live dependency health")).toBeInTheDocument();
    expect(screen.getByText("Horizon / Soroban RPC")).toBeInTheDocument();
    expect(screen.getByText("Event indexer")).toBeInTheDocument();
    expect(screen.getAllByText("Healthy").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("config-drift-panel")).not.toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/admin/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("renders stale indexer state", async () => {
    mockHealth(STALE_PAYLOAD);
    render(<AdminSettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("health-dep-indexer")).toHaveAttribute(
        "data-status",
        "stale",
      );
    });

    expect(screen.getByText(/Indexer soft lag/i)).toBeInTheDocument();
    expect(screen.getAllByText("Stale").length).toBeGreaterThan(0);
  });

  it("renders degraded state and surfaces config drift", async () => {
    mockHealth(DEGRADED_PAYLOAD, { ok: false });
    render(<AdminSettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("config-drift-panel")).toBeInTheDocument();
    });

    expect(screen.getByTestId("health-dep-rpc")).toHaveAttribute(
      "data-status",
      "degraded",
    );
    const drift = screen.getByTestId("drift-treasuryFee");
    expect(within(drift).getByText("treasuryFee")).toBeInTheDocument();
    expect(within(drift).getByText("0.75%")).toBeInTheDocument();
    expect(within(drift).getByText("2.00%")).toBeInTheDocument();
    expect(screen.getByText(/Open config-drift remediation/i)).toHaveAttribute(
      "href",
      expect.stringContaining("ADMIN_HEALTH_REMEDIATION"),
    );
  });

  it("refreshes health when the refresh button is pressed", async () => {
    mockHealth(HEALTHY_PAYLOAD);
    const user = userEvent.setup();
    render(<AdminSettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("health-dep-rpc")).toHaveAttribute(
        "data-status",
        "healthy",
      );
    });
    const callsAfterMount = global.fetch.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThanOrEqual(1);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => STALE_PAYLOAD,
    });
    await user.click(screen.getByLabelText("Refresh health"));

    await waitFor(() => {
      expect(screen.getByTestId("health-dep-indexer")).toHaveAttribute(
        "data-status",
        "stale",
      );
    });
    expect(global.fetch).toHaveBeenCalled();
  });

  it("does not retain a healthy result after a failed refresh", async () => {
    mockHealth(HEALTHY_PAYLOAD);
    const user = userEvent.setup();
    render(<AdminSettingsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("health-dep-rpc")).toHaveAttribute(
        "data-status",
        "healthy",
      );
    });

    global.fetch = vi.fn().mockRejectedValue(new Error("Health probe failed"));
    await user.click(screen.getByLabelText("Refresh health"));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Health probe failed");
    });
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getAllByText("Degraded").length).toBeGreaterThan(0);
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
    expect(screen.queryByTestId("health-dep-rpc")).not.toBeInTheDocument();
  });

  it("keeps the newest degraded poll when an older healthy body arrives late", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldBody = deferred();
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => oldBody.promise })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => DEGRADED_PAYLOAD });
    render(<AdminSettingsPage />);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByTestId("health-dep-rpc")).toHaveAttribute("data-status", "degraded");

    await act(async () => { oldBody.resolve(HEALTHY_PAYLOAD); });
    expect(screen.getByTestId("health-dep-rpc")).toHaveAttribute("data-status", "degraded");
    expect(screen.getByTestId("config-drift-panel")).toBeInTheDocument();
    expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("ignores an older poll failure after a newer healthy response", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldRequest = deferred();
    global.fetch = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => HEALTHY_PAYLOAD });
    render(<AdminSettingsPage />);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await act(async () => { oldRequest.reject(new Error("Old request failed")); });

    expect(screen.getByTestId("health-dep-rpc")).toHaveAttribute("data-status", "healthy");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the newest failure when an older healthy body arrives late", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldBody = deferred();
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => oldBody.promise })
      .mockRejectedValueOnce(new Error("Latest health probe failed"));
    render(<AdminSettingsPage />);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await act(async () => { oldBody.resolve(HEALTHY_PAYLOAD); });

    expect(screen.getByRole("alert")).toHaveTextContent("Latest health probe failed");
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("health-dep-rpc")).not.toBeInTheDocument();
  });

  it("keeps refresh disabled until the newest overlapping poll settles", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const oldRequest = deferred();
    const currentRequest = deferred();
    global.fetch = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise);
    render(<AdminSettingsPage />);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await act(async () => {
      oldRequest.resolve({ ok: true, status: 200, json: async () => HEALTHY_PAYLOAD });
    });
    expect(screen.getByLabelText("Refresh health")).toBeDisabled();
    expect(screen.queryByTestId("health-dep-rpc")).not.toBeInTheDocument();

    await act(async () => {
      currentRequest.resolve({ ok: true, status: 200, json: async () => STALE_PAYLOAD });
    });
    expect(screen.getByLabelText("Refresh health")).toBeEnabled();
    expect(screen.getByTestId("health-dep-indexer")).toHaveAttribute("data-status", "stale");
  });

  it("cancels an outstanding poll and stops polling when the page unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pendingRequest = deferred();
    global.fetch = vi.fn().mockReturnValue(pendingRequest.promise);
    const { unmount } = render(<AdminSettingsPage />);
    const signal = global.fetch.mock.calls[0][1].signal;

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      pendingRequest.resolve({ ok: true, status: 200, json: async () => HEALTHY_PAYLOAD });
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
