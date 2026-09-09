import { DEFAULT_RPC } from "./customRpc.js";

export type HealthState = "healthy" | "stale" | "degraded";

export type DependencyType = "rpc" | "indexer" | "contract_hash" | "config_drift";

export interface DependencyHealthCheck {
  id: string;
  name: string;
  type: DependencyType;
  status: HealthState;
  latencyMs?: number;
  detail: string;
  checkedAt: string;
  remediationUrl: string;
  metadata?: Record<string, unknown>;
}

export interface ProtocolParametersConfig {
  roundDuration: string;
  minDeposit: string;
  maxDeposit: string;
  treasuryFee: string;
  settlementQuorum: string;
  emergencyPauseThreshold: string;
}

export interface CanonicalProvenance {
  network: {
    passphrase: string;
    horizonUrl: string;
    sorobanRpcUrl: string;
    chainId?: number;
  };
  contract: {
    contractId: string;
    expectedWasmHash: string;
    version: string;
    deployedAt?: string;
  };
  protocolParameters: ProtocolParametersConfig;
  indexerThresholds: {
    maxHealthyLagLedgers: number;
    maxStaleLagLedgers: number;
    staleSyncWindowMinutes: number;
  };
  remediationDocs: {
    rpc: string;
    indexer: string;
    contractHash: string;
    configDrift: string;
  };
}

export interface ConfigDriftItem {
  parameter: string;
  expected: string;
  actual: string;
  severity: "warning" | "critical";
  impact: string;
}

export interface ConfigDriftReport {
  status: HealthState;
  hasDrift: boolean;
  driftCount: number;
  drifts: ConfigDriftItem[];
  checkedAt: string;
  remediationUrl: string;
}

export interface ContractProvenanceReport {
  status: HealthState;
  contractId: string;
  expectedHash: string;
  actualHash: string;
  verified: boolean;
  detail: string;
  remediationUrl: string;
  checkedAt: string;
}

export interface IndexerHealthReport {
  status: HealthState;
  latestLedger: number;
  syncLag: number;
  lastSyncTime?: string;
  lastSuccessSyncTime?: string;
  lastError?: string | null;
  detail: string;
  remediationUrl: string;
  checkedAt: string;
}

export interface RpcHealthReport {
  status: HealthState;
  endpoint: string;
  networkPassphrase?: string;
  latencyMs: number;
  detail: string;
  remediationUrl: string;
  checkedAt: string;
}

export interface AdminHealthOverview {
  status: HealthState;
  checkedAt: string;
  summary: {
    healthy: number;
    stale: number;
    degraded: number;
    total: number;
  };
  dependencies: DependencyHealthCheck[];
  configDrift: ConfigDriftReport;
  contractProvenance: ContractProvenanceReport;
  indexer: IndexerHealthReport;
  rpc: RpcHealthReport;
}

export const CANONICAL_PROVENANCE: CanonicalProvenance = {
  network: {
    passphrase:
      process.env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE ||
      "Test SDF Network ; September 2015",
    horizonUrl:
      process.env.NEXT_PUBLIC_HORIZON_URL ||
      DEFAULT_RPC.horizon ||
      "https://horizon-testnet.stellar.org",
    sorobanRpcUrl:
      process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
      "https://soroban-testnet.stellar.org",
  },
  contract: {
    contractId:
      process.env.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID ||
      "CA_DRIP_POOL_CANONICAL_TESTNET_RELEASE_01",
    expectedWasmHash:
      "sha256:7f4c9c18d8e3b3e6488d907f1a30f305dbf2d93e25b1f1ac76bca9ef1587d552",
    version: "v0.1.0",
    deployedAt: "2026-06-01T00:00:00Z",
  },
  protocolParameters: {
    roundDuration: "7 days",
    minDeposit: "100 XLM",
    maxDeposit: "250,000 XLM",
    treasuryFee: "0.75%",
    settlementQuorum: "3 of 5",
    emergencyPauseThreshold: "2 failed attempts",
  },
  indexerThresholds: {
    maxHealthyLagLedgers: 5,
    maxStaleLagLedgers: 100,
    staleSyncWindowMinutes: 5,
  },
  remediationDocs: {
    rpc: "/docs/ADMIN_HEALTH_REMEDIATION.md#1-rpc-health-remediation",
    indexer: "/docs/INDEXER_RUNBOOK.md",
    contractHash:
      "/docs/ADMIN_HEALTH_REMEDIATION.md#2-smart-contract-provenance-remediation",
    configDrift:
      "/docs/ADMIN_HEALTH_REMEDIATION.md#3-configuration-drift-remediation",
  },
};

const CRITICAL_PARAMETERS = new Set([
  "treasuryFee",
  "settlementQuorum",
  "emergencyPauseThreshold",
  "contractId",
]);

/**
 * Evaluates live RPC endpoint connectivity, responsiveness, and network passphrase integrity.
 * @param result RPC ping result with latency, status, and network passphrase
 * @param provenance Canonical deployment provenance configuration
 * @returns Structured RpcHealthReport with health classification and runbook link
 */
export function evaluateRpcHealth(
  result: {
    ok: boolean;
    latencyMs: number;
    networkPassphrase?: string;
    endpoint?: string;
    error?: string;
  },
  provenance: CanonicalProvenance = CANONICAL_PROVENANCE,
): RpcHealthReport {
  const endpoint = result.endpoint || provenance.network.horizonUrl;
  const checkedAt = new Date().toISOString();
  const remediationUrl = provenance.remediationDocs.rpc;

  if (!result.ok) {
    return {
      status: "degraded",
      endpoint,
      networkPassphrase: result.networkPassphrase,
      latencyMs: result.latencyMs,
      detail: result.error || "RPC endpoint unreachable or returned an error response.",
      remediationUrl,
      checkedAt,
    };
  }

  if (
    result.networkPassphrase &&
    result.networkPassphrase !== provenance.network.passphrase
  ) {
    return {
      status: "degraded",
      endpoint,
      networkPassphrase: result.networkPassphrase,
      latencyMs: result.latencyMs,
      detail: `RPC network passphrase mismatch: received "${result.networkPassphrase}", expected "${provenance.network.passphrase}".`,
      remediationUrl,
      checkedAt,
    };
  }

  if (result.latencyMs >= 1500) {
    return {
      status: "stale",
      endpoint,
      networkPassphrase: result.networkPassphrase,
      latencyMs: result.latencyMs,
      detail: `High RPC latency detected (${result.latencyMs}ms >= 1500ms threshold).`,
      remediationUrl,
      checkedAt,
    };
  }

  return {
    status: "healthy",
    endpoint,
    networkPassphrase: result.networkPassphrase,
    latencyMs: result.latencyMs,
    detail: `RPC responsive (${result.latencyMs}ms) and network passphrase verified.`,
    remediationUrl,
    checkedAt,
  };
}

/**
 * Evaluates ledger indexer synchronization state against freshness and ledger lag thresholds.
 * @param indexerData Current checkpoint metrics from indexer health endpoint
 * @param provenance Canonical deployment provenance configuration
 * @returns Structured IndexerHealthReport with lag metrics, error state, and remediation link
 */
export function evaluateIndexerHealth(
  indexerData: {
    latest_ledger?: number;
    sync_lag?: number;
    last_sync_time?: string;
    last_success_sync_time?: string;
    last_error?: string | null;
    status?: string;
  },
  provenance: CanonicalProvenance = CANONICAL_PROVENANCE,
): IndexerHealthReport {
  const checkedAt = new Date().toISOString();
  const remediationUrl = provenance.remediationDocs.indexer;
  const latestLedger = indexerData.latest_ledger ?? 0;
  const syncLag = indexerData.sync_lag ?? 0;
  const lastError = indexerData.last_error ?? null;
  const lastSyncTime = indexerData.last_sync_time;
  const lastSuccessSyncTime = indexerData.last_success_sync_time;

  if (lastError || syncLag > provenance.indexerThresholds.maxStaleLagLedgers) {
    const errorReason = lastError
      ? `Reported error: ${lastError}`
      : `Critical sync lag (${syncLag} ledgers > ${provenance.indexerThresholds.maxStaleLagLedgers} limit)`;
    return {
      status: "degraded",
      latestLedger,
      syncLag,
      lastSyncTime,
      lastSuccessSyncTime,
      lastError,
      detail: errorReason,
      remediationUrl,
      checkedAt,
    };
  }

  let isTimeStale = false;
  if (lastSuccessSyncTime) {
    const lastSuccessMs = new Date(lastSuccessSyncTime).getTime();
    const nowMs = Date.now();
    const staleWindowMs =
      provenance.indexerThresholds.staleSyncWindowMinutes * 60 * 1000;
    if (!Number.isNaN(lastSuccessMs) && nowMs - lastSuccessMs > staleWindowMs) {
      isTimeStale = true;
    }
  }

  if (syncLag > provenance.indexerThresholds.maxHealthyLagLedgers || isTimeStale) {
    const reason =
      syncLag > provenance.indexerThresholds.maxHealthyLagLedgers
        ? `Lagging by ${syncLag} ledgers (soft limit ${provenance.indexerThresholds.maxHealthyLagLedgers}). Background catch-up active.`
        : `Last successful sync was over ${provenance.indexerThresholds.staleSyncWindowMinutes} minutes ago.`;
    return {
      status: "stale",
      latestLedger,
      syncLag,
      lastSyncTime,
      lastSuccessSyncTime,
      lastError: null,
      detail: reason,
      remediationUrl,
      checkedAt,
    };
  }

  return {
    status: "healthy",
    latestLedger,
    syncLag,
    lastSyncTime,
    lastSuccessSyncTime,
    lastError: null,
    detail: `Synchronized with ledger sequence ${latestLedger} (lag: ${syncLag} ledgers).`,
    remediationUrl,
    checkedAt,
  };
}

/**
 * Validates deployed smart contract WASM bytecode hash against canonical release provenance.
 * @param actualHash Live SHA-256 hash of deployed contract artifact
 * @param provenance Canonical deployment provenance configuration
 * @returns Structured ContractProvenanceReport with verification status and remediation runbook
 */
export function verifyContractProvenance(
  actualHash: string | undefined | null,
  provenance: CanonicalProvenance = CANONICAL_PROVENANCE,
): ContractProvenanceReport {
  const checkedAt = new Date().toISOString();
  const remediationUrl = provenance.remediationDocs.contractHash;
  const contractId = provenance.contract.contractId;
  const expectedHash = provenance.contract.expectedWasmHash;

  if (!actualHash || actualHash === "pending" || actualHash === "unknown") {
    return {
      status: "stale",
      contractId,
      expectedHash,
      actualHash: actualHash || "unknown",
      verified: false,
      detail: "Contract bytecode hash verification in progress or unavailable.",
      remediationUrl,
      checkedAt,
    };
  }

  const normalizedActual = actualHash.trim().toLowerCase();
  const normalizedExpected = expectedHash.trim().toLowerCase();

  if (normalizedActual !== normalizedExpected) {
    return {
      status: "degraded",
      contractId,
      expectedHash,
      actualHash,
      verified: false,
      detail: `Contract bytecode hash mismatch: expected "${expectedHash}", found "${actualHash}". Unauthorized code or incorrect deployment detected.`,
      remediationUrl,
      checkedAt,
    };
  }

  return {
    status: "healthy",
    contractId,
    expectedHash,
    actualHash,
    verified: true,
    detail: "Latest deployed contract hash matches canonical published release.",
    remediationUrl,
    checkedAt,
  };
}

/**
 * Compares active runtime configuration parameters against canonical deployment provenance to detect drift.
 * @param currentConfig Active protocol parameters and network configuration
 * @param provenance Canonical deployment provenance configuration
 * @returns Detailed ConfigDriftReport itemizing drifted parameters and severity classification
 */
export function detectConfigDrift(
  currentConfig: Partial<
    ProtocolParametersConfig & {
      contractId?: string;
      passphrase?: string;
      horizonUrl?: string;
    }
  >,
  provenance: CanonicalProvenance = CANONICAL_PROVENANCE,
): ConfigDriftReport {
  const checkedAt = new Date().toISOString();
  const remediationUrl = provenance.remediationDocs.configDrift;
  const drifts: ConfigDriftItem[] = [];

  const paramKeys: (keyof ProtocolParametersConfig)[] = [
    "roundDuration",
    "minDeposit",
    "maxDeposit",
    "treasuryFee",
    "settlementQuorum",
    "emergencyPauseThreshold",
  ];

  for (const key of paramKeys) {
    const expected = provenance.protocolParameters[key];
    const actual = currentConfig[key];
    if (actual !== undefined && actual !== expected) {
      const isCritical = CRITICAL_PARAMETERS.has(key);
      drifts.push({
        parameter: key,
        expected,
        actual,
        severity: isCritical ? "critical" : "warning",
        impact: isCritical
          ? `Discrepancy in security-critical parameter ${key} modifies protocol settlement or fees.`
          : `Discrepancy in ${key} alters round operational timing or deposit limits.`,
      });
    }
  }

  if (
    currentConfig.contractId !== undefined &&
    currentConfig.contractId !== provenance.contract.contractId
  ) {
    drifts.push({
      parameter: "contractId",
      expected: provenance.contract.contractId,
      actual: currentConfig.contractId,
      severity: "critical",
      impact: "Active contract address diverged from canonical release deployment.",
    });
  }

  const hasDrift = drifts.length > 0;
  const hasCritical = drifts.some((d) => d.severity === "critical");
  const status: HealthState = hasCritical
    ? "degraded"
    : hasDrift
      ? "stale"
      : "healthy";

  return {
    status,
    hasDrift,
    driftCount: drifts.length,
    drifts,
    checkedAt,
    remediationUrl,
  };
}

/**
 * Aggregates individual dependency health evaluations into a unified AdminHealthOverview report.
 * @param rpc RpcHealthReport from evaluateRpcHealth
 * @param indexer IndexerHealthReport from evaluateIndexerHealth
 * @param contract ContractProvenanceReport from verifyContractProvenance
 * @param configDrift ConfigDriftReport from detectConfigDrift
 * @returns Unified AdminHealthOverview with overall system state and dependency summaries
 */
export function aggregateAdminHealth(
  rpc: RpcHealthReport,
  indexer: IndexerHealthReport,
  contract: ContractProvenanceReport,
  configDrift: ConfigDriftReport,
): AdminHealthOverview {
  const checkedAt = new Date().toISOString();

  const dependencies: DependencyHealthCheck[] = [
    {
      id: "rpc",
      name: "Stellar Horizon & RPC",
      type: "rpc",
      status: rpc.status,
      latencyMs: rpc.latencyMs,
      detail: rpc.detail,
      checkedAt: rpc.checkedAt,
      remediationUrl: rpc.remediationUrl,
      metadata: {
        endpoint: rpc.endpoint,
        networkPassphrase: rpc.networkPassphrase,
      },
    },
    {
      id: "indexer",
      name: "Event Indexer",
      type: "indexer",
      status: indexer.status,
      detail: indexer.detail,
      checkedAt: indexer.checkedAt,
      remediationUrl: indexer.remediationUrl,
      metadata: {
        latestLedger: indexer.latestLedger,
        syncLag: indexer.syncLag,
        lastError: indexer.lastError,
      },
    },
    {
      id: "contract_hash",
      name: "Smart Contract Hash",
      type: "contract_hash",
      status: contract.status,
      detail: contract.detail,
      checkedAt: contract.checkedAt,
      remediationUrl: contract.remediationUrl,
      metadata: {
        contractId: contract.contractId,
        expectedHash: contract.expectedHash,
        actualHash: contract.actualHash,
        verified: contract.verified,
      },
    },
    {
      id: "config_drift",
      name: "Configuration Drift",
      type: "config_drift",
      status: configDrift.status,
      detail: configDrift.hasDrift
        ? `${configDrift.driftCount} configuration parameter${configDrift.driftCount === 1 ? "" : "s"} drifted from canonical provenance.`
        : "All active parameters match canonical deployment provenance.",
      checkedAt: configDrift.checkedAt,
      remediationUrl: configDrift.remediationUrl,
      metadata: {
        driftCount: configDrift.driftCount,
        drifts: configDrift.drifts,
      },
    },
  ];

  let healthy = 0;
  let stale = 0;
  let degraded = 0;

  for (const dep of dependencies) {
    if (dep.status === "healthy") healthy += 1;
    else if (dep.status === "stale") stale += 1;
    else if (dep.status === "degraded") degraded += 1;
  }

  const overallStatus: HealthState =
    degraded > 0 ? "degraded" : stale > 0 ? "stale" : "healthy";

  return {
    status: overallStatus,
    checkedAt,
    summary: {
      healthy,
      stale,
      degraded,
      total: dependencies.length,
    },
    dependencies,
    configDrift,
    contractProvenance: contract,
    indexer,
    rpc,
  };
}
