import { describe, expect, it } from "vitest";
import {
  getVaultHealth,
  CONTRACTS_PROBE_ID,
  type IndexerHealthLike,
} from "../src/services/vaultHealthService.js";
import type { ProbeResult } from "../src/services/probeService.js";

// Fixed clock so freshness assertions cannot flake with machine speed.
const NOW = new Date("2026-09-13T12:00:00.000Z");
const now = () => NOW;

function indexerHealth(overrides: Partial<IndexerHealthLike> = {}): IndexerHealthLike {
  return {
    status: "healthy",
    latency_ms: 12,
    last_success_sync_time: NOW.toISOString(),
    sync_lag: 0,
    ...overrides,
  };
}

function probeResult(
  checkStatus: "operational" | "degraded" | "outage",
  options: { includeContractsCheck?: boolean; error?: string } = {}
): ProbeResult {
  const checks =
    options.includeContractsCheck === false
      ? []
      : [
          {
            id: CONTRACTS_PROBE_ID,
            name: "Stellar RPC",
            url: "https://soroban-testnet.stellar.org",
            status: checkStatus,
            latency_ms: 210,
            ...(options.error ? { error: options.error } : {}),
          },
        ];
  return { status: checkStatus, checked_at: NOW.toISOString(), checks };
}

function row(services: Awaited<ReturnType<typeof getVaultHealth>>["services"], id: string) {
  const found = services.find((s) => s.id === id);
  if (!found) throw new Error("missing row " + id);
  return found;
}

describe("getVaultHealth", () => {
  it("reports operational per row and overall when every real signal is healthy", async () => {
    const health = await getVaultHealth({
      now,
      indexer: async () => indexerHealth(),
      probes: async () => probeResult("operational"),
    });

    expect(row(health.services, "data-indexer").status).toBe("operational");
    expect(row(health.services, "data-indexer").stale).toBe(false);
    expect(row(health.services, "vault-contracts").status).toBe("operational");
    expect(row(health.services, "vault-contracts").latency_ms).toBe(210);
    expect(health.status).toBe("operational");
    expect(health.checked_at).toBe(NOW.toISOString());
  });

  it("flags a signal older than the staleness window without changing its status", async () => {
    const stale = new Date(NOW.getTime() - 9 * 60 * 1000).toISOString();
    const health = await getVaultHealth({
      now,
      indexer: async () => indexerHealth({ last_success_sync_time: stale }),
      probes: async () => probeResult("operational"),
    });

    const indexer = row(health.services, "data-indexer");
    expect(indexer.status).toBe("operational");
    expect(indexer.stale).toBe(true);
    expect(indexer.age_ms).toBe(9 * 60 * 1000);
  });

  it("reports degraded overall on a partial outage", async () => {
    const health = await getVaultHealth({
      now,
      indexer: async () => indexerHealth({ status: "degraded", message: "Indexer 3 blocks behind" }),
      probes: async () => probeResult("operational"),
    });

    expect(row(health.services, "data-indexer").status).toBe("degraded");
    expect(row(health.services, "data-indexer").message).toBe("Indexer 3 blocks behind");
    expect(row(health.services, "vault-contracts").status).toBe("operational");
    expect(health.status).toBe("degraded");
  });

  it("reports outage overall when every probed dependency is down", async () => {
    const health = await getVaultHealth({
      now,
      indexer: async () => indexerHealth({ status: "unhealthy", message: "checkpoint unreadable" }),
      probes: async () => probeResult("outage", { error: "ECONNREFUSED" }),
    });

    expect(row(health.services, "data-indexer").status).toBe("outage");
    expect(row(health.services, "vault-contracts").status).toBe("outage");
    expect(row(health.services, "vault-contracts").message).toBe("ECONNREFUSED");
    expect(health.status).toBe("outage");
  });

  it("reports outage when a provider times out instead of hanging the endpoint", async () => {
    const timeout = Object.assign(new Error("indexer check timed out after 2000ms"), {
      name: "CheckTimeoutError",
    });
    const health = await getVaultHealth({
      now,
      indexer: async () => {
        throw timeout;
      },
      probes: async () => probeResult("operational"),
    });

    const indexer = row(health.services, "data-indexer");
    expect(indexer.status).toBe("outage");
    expect(indexer.message).toContain("timed out");
    expect(indexer.checked_at).toBeNull();
  });

  it("reports unknown, never operational, for a dependency with no trustworthy probe", async () => {
    const health = await getVaultHealth({
      now,
      indexer: async () => indexerHealth(),
      probes: async () => probeResult("operational"),
    });

    const oracle = row(health.services, "prize-oracle");
    expect(oracle.status).toBe("unknown");
    expect(oracle.source).toBe("none");
    expect(oracle.message).toMatch(/unknown/i);
    expect(oracle.latency_ms).toBeNull();
    // Two of three rows are trustworthy, so the aggregate stays operational;
    // the unknown row is what stops the panel from claiming oracle health.
    expect(health.status).toBe("operational");
  });

  it("reports unknown for the contracts row when the probe payload omits its check", async () => {
    const health = await getVaultHealth({
      now,
      indexer: async () => indexerHealth(),
      probes: async () => probeResult("operational", { includeContractsCheck: false }),
    });

    const contracts = row(health.services, "vault-contracts");
    expect(contracts.status).toBe("unknown");
    expect(contracts.latency_ms).toBeNull();
  });

  it("reports unknown overall when nothing at all is configured", async () => {
    const health = await getVaultHealth({ now });
    expect(health.status).toBe("unknown");
    expect(health.services.every((s) => s.status === "unknown")).toBe(true);
  });
});
