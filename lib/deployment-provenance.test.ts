import { describe, it, expect } from "vitest";
import {
  CANONICAL_PROVENANCE,
  evaluateRpcHealth,
  evaluateIndexerHealth,
  verifyContractProvenance,
  detectConfigDrift,
  aggregateAdminHealth,
} from "./deployment-provenance";

describe("deployment-provenance", () => {
  describe("evaluateRpcHealth", () => {
    it("reports healthy state when RPC is responsive under latency threshold and passphrase matches", () => {
      const report = evaluateRpcHealth({
        ok: true,
        latencyMs: 140,
        networkPassphrase: CANONICAL_PROVENANCE.network.passphrase,
      });

      expect(report.status).toBe("healthy");
      expect(report.latencyMs).toBe(140);
      expect(report.detail).toContain("responsive (140ms)");
      expect(report.remediationUrl).toContain("remediation");
    });

    it("reports stale state when RPC response latency exceeds the slow threshold", () => {
      const report = evaluateRpcHealth({
        ok: true,
        latencyMs: 1850,
        networkPassphrase: CANONICAL_PROVENANCE.network.passphrase,
      });

      expect(report.status).toBe("stale");
      expect(report.latencyMs).toBe(1850);
      expect(report.detail).toContain("High RPC latency detected");
    });

    it("reports degraded state when RPC endpoint is unreachable or returns error", () => {
      const report = evaluateRpcHealth({
        ok: false,
        latencyMs: 5000,
        error: "Connection timeout after 5000ms",
      });

      expect(report.status).toBe("degraded");
      expect(report.detail).toBe("Connection timeout after 5000ms");
    });

    it("reports degraded state when RPC network passphrase diverges from canonical provenance", () => {
      const report = evaluateRpcHealth({
        ok: true,
        latencyMs: 90,
        networkPassphrase: "Public Global Stellar Network ; September 2015",
      });

      expect(report.status).toBe("degraded");
      expect(report.detail).toContain("RPC network passphrase mismatch");
    });
  });

  describe("evaluateIndexerHealth", () => {
    it("reports healthy state when indexer is within the soft lag threshold with zero errors", () => {
      const report = evaluateIndexerHealth({
        latest_ledger: 1500000,
        sync_lag: 2,
        last_sync_time: new Date().toISOString(),
        last_success_sync_time: new Date().toISOString(),
        last_error: null,
      });

      expect(report.status).toBe("healthy");
      expect(report.syncLag).toBe(2);
      expect(report.detail).toContain("Synchronized with ledger sequence 1500000");
    });

    it("reports stale state when indexer lag exceeds soft limit but remains below hard threshold", () => {
      const report = evaluateIndexerHealth({
        latest_ledger: 1500000,
        sync_lag: 25,
        last_sync_time: new Date().toISOString(),
        last_success_sync_time: new Date().toISOString(),
        last_error: null,
      });

      expect(report.status).toBe("stale");
      expect(report.syncLag).toBe(25);
      expect(report.detail).toContain("Lagging by 25 ledgers");
    });

    it("reports stale state when last successful sync time exceeds freshness window", () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const report = evaluateIndexerHealth({
        latest_ledger: 1500000,
        sync_lag: 0,
        last_sync_time: new Date().toISOString(),
        last_success_sync_time: tenMinutesAgo,
        last_error: null,
      });

      expect(report.status).toBe("stale");
      expect(report.detail).toContain("Last successful sync was over 5 minutes ago");
    });

    it("reports degraded state when indexer reports a hard error", () => {
      const report = evaluateIndexerHealth({
        latest_ledger: 1500000,
        sync_lag: 4,
        last_error: "Horizon rate limit exceeded (HTTP 429)",
      });

      expect(report.status).toBe("degraded");
      expect(report.lastError).toBe("Horizon rate limit exceeded (HTTP 429)");
      expect(report.detail).toContain("Reported error: Horizon rate limit exceeded");
    });

    it("reports degraded state when indexer sync lag exceeds the critical threshold", () => {
      const report = evaluateIndexerHealth({
        latest_ledger: 1500000,
        sync_lag: 180,
        last_error: null,
      });

      expect(report.status).toBe("degraded");
      expect(report.syncLag).toBe(180);
      expect(report.detail).toContain("Critical sync lag (180 ledgers > 100 limit)");
    });
  });

  describe("verifyContractProvenance", () => {
    it("reports healthy state when deployed WASM hash matches canonical release provenance", () => {
      const report = verifyContractProvenance(
        CANONICAL_PROVENANCE.contract.expectedWasmHash,
      );

      expect(report.status).toBe("healthy");
      expect(report.verified).toBe(true);
      expect(report.actualHash).toBe(CANONICAL_PROVENANCE.contract.expectedWasmHash);
      expect(report.detail).toContain("matches canonical published release");
    });

    it("reports stale state when contract hash verification is pending or unknown", () => {
      const report = verifyContractProvenance("pending");

      expect(report.status).toBe("stale");
      expect(report.verified).toBe(false);
      expect(report.detail).toContain("verification in progress or unavailable");
    });

    it("reports degraded state when deployed bytecode hash diverges from canonical hash", () => {
      const badHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
      const report = verifyContractProvenance(badHash);

      expect(report.status).toBe("degraded");
      expect(report.verified).toBe(false);
      expect(report.actualHash).toBe(badHash);
      expect(report.detail).toContain("Contract bytecode hash mismatch");
    });
  });

  describe("detectConfigDrift", () => {
    it("reports healthy state when active parameters match canonical deployment provenance", () => {
      const report = detectConfigDrift({
        roundDuration: "7 days",
        minDeposit: "100 XLM",
        maxDeposit: "250,000 XLM",
        treasuryFee: "0.75%",
        settlementQuorum: "3 of 5",
        emergencyPauseThreshold: "2 failed attempts",
      });

      expect(report.status).toBe("healthy");
      expect(report.hasDrift).toBe(false);
      expect(report.driftCount).toBe(0);
      expect(report.drifts).toHaveLength(0);
    });

    it("reports stale state when non-critical configuration parameters drift", () => {
      const report = detectConfigDrift({
        roundDuration: "14 days",
        minDeposit: "50 XLM",
      });

      expect(report.status).toBe("stale");
      expect(report.hasDrift).toBe(true);
      expect(report.driftCount).toBe(2);
      expect(report.drifts.every((d) => d.severity === "warning")).toBe(true);
    });

    it("reports degraded state when critical security parameters drift", () => {
      const report = detectConfigDrift({
        treasuryFee: "2.5%",
        settlementQuorum: "1 of 5",
      });

      expect(report.status).toBe("degraded");
      expect(report.hasDrift).toBe(true);
      expect(report.drifts.some((d) => d.severity === "critical")).toBe(true);
      expect(report.drifts.find((d) => d.parameter === "treasuryFee")?.expected).toBe("0.75%");
      expect(report.drifts.find((d) => d.parameter === "treasuryFee")?.actual).toBe("2.5%");
    });

    it("reports degraded state when deployed contract address diverges from provenance", () => {
      const report = detectConfigDrift({
        contractId: "CA_UNAUTHORIZED_REPLACEMENT_CONTRACT_99",
      });

      expect(report.status).toBe("degraded");
      expect(report.hasDrift).toBe(true);
      expect(report.drifts.find((d) => d.parameter === "contractId")?.severity).toBe("critical");
    });
  });

  describe("aggregateAdminHealth", () => {
    it("aggregates to healthy when all dependencies are healthy", () => {
      const rpc = evaluateRpcHealth({ ok: true, latencyMs: 50 });
      const indexer = evaluateIndexerHealth({ sync_lag: 0 });
      const contract = verifyContractProvenance(CANONICAL_PROVENANCE.contract.expectedWasmHash);
      const drift = detectConfigDrift({});

      const overview = aggregateAdminHealth(rpc, indexer, contract, drift);

      expect(overview.status).toBe("healthy");
      expect(overview.summary.healthy).toBe(4);
      expect(overview.summary.stale).toBe(0);
      expect(overview.summary.degraded).toBe(0);
      expect(overview.summary.total).toBe(4);
      expect(overview.dependencies).toHaveLength(4);
    });

    it("aggregates to stale when any dependency is stale and none are degraded", () => {
      const rpc = evaluateRpcHealth({ ok: true, latencyMs: 1800 });
      const indexer = evaluateIndexerHealth({ sync_lag: 0 });
      const contract = verifyContractProvenance(CANONICAL_PROVENANCE.contract.expectedWasmHash);
      const drift = detectConfigDrift({});

      const overview = aggregateAdminHealth(rpc, indexer, contract, drift);

      expect(overview.status).toBe("stale");
      expect(overview.summary.healthy).toBe(3);
      expect(overview.summary.stale).toBe(1);
      expect(overview.summary.degraded).toBe(0);
    });

    it("aggregates to degraded when any dependency is degraded", () => {
      const rpc = evaluateRpcHealth({ ok: true, latencyMs: 1800 });
      const indexer = evaluateIndexerHealth({ sync_lag: 500 });
      const contract = verifyContractProvenance(CANONICAL_PROVENANCE.contract.expectedWasmHash);
      const drift = detectConfigDrift({});

      const overview = aggregateAdminHealth(rpc, indexer, contract, drift);

      expect(overview.status).toBe("degraded");
      expect(overview.summary.degraded).toBe(1);
    });
  });
});
