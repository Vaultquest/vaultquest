/**
 * Deployment provenance + admin dependency health evaluation (#177).
 *
 * Pure classifiers only — callers (API route / tests) inject live probe
 * results. States: healthy | stale | degraded.
 */
import { DEFAULT_RPC } from "./customRpc.js";

export type HealthState = "healthy" | "stale" | "degraded";

export type DependencyKind = "rpc" | "indexer" | "contract_hash" | "config_drift";

export type ProtocolParameterKey =
  | "roundDuration"
  | "minDeposit"
  | "maxDeposit"
  | "treasuryFee"
  | "settlementQuorum"
  | "emergencyPauseThreshold";

export type ProtocolParameters = Record<ProtocolParameterKey, string>;

export interface CanonicalProvenance {
  network: {
    passphrase: string;
    horizonUrl: string;
    sorobanRpcUrl: string;
  };
  contract: {
    contractId: string;
    expectedWasmHash: string;
    version: string;
  };
  protocolParameters: ProtocolParameters;
  indexer: {
    /** Soft lag — map to stale (docs/INDEXER_RUNBOOK.md warning). */
    softLagLedgers: number;
    /** Hard lag — map to degraded (docs/INDEXER_RUNBOOK.md critical). */
    hardLagLedgers: number;
    /** Age of last successful sync before we treat the indexer as stale. */
    staleAfterMs: number;
  };
  remediation: {
    rpc: string;
    indexer: string;
    contractHash: string;
    configDrift: string;
  };
}

export interface RpcProbeInput {
  ok: boolean;
  latencyMs: number;
  endpoint?: string;
  networkPassphrase?: string | null;
  error?: string | null;
}

export interface IndexerProbeInput {
  status?: string | null;
  latestLedger?: number | null;
  syncLag?: number | null;
  lastSyncTime?: string | null;
  lastSuccessSyncTime?: string | null;
  lastError?: string | null;
  message?: string | null;
}

export interface DependencyCheck {
  id: string;
  name: string;
  kind: DependencyKind;
  status: HealthState;
  detail: string;
  checkedAt: string;
  remediationUrl: string;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
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
  drifts: ConfigDriftItem[];
  checkedAt: string;
  remediationUrl: string;
}

export interface AdminHealthOverview {
  status: HealthState;
  checkedAt: string;
  summary: { healthy: number; stale: number; degraded: number; total: number };
  dependencies: DependencyCheck[];
  configDrift: ConfigDriftReport;
}

const GITHUB_DOCS =
  "https://github.com/Vaultquest/vaultquest/blob/main/docs";

/** Parameters that must never silently diverge from the published release. */
const CRITICAL_PARAMETERS = new Set<ProtocolParameterKey>([
  "treasuryFee",
  "settlementQuorum",
  "emergencyPauseThreshold",
]);

const PARAMETER_IMPACT: Record<ProtocolParameterKey, string> = {
  roundDuration: "Changes prize-round cadence and settlement windows.",
  minDeposit: "Affects eligibility floor for new deposits.",
  maxDeposit: "Changes concentration caps per vault.",
  treasuryFee: "Changes yield skim before prize allocation.",
  settlementQuorum: "Changes multisig approval requirements for admin writes.",
  emergencyPauseThreshold: "Changes when automatic pause review is triggered.",
};

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
      "CA_PLACEHOLDER_DRIP_POOL_CONTRACT_ID",
    // Release hash must be configured; a fabricated default cannot verify code.
    expectedWasmHash: process.env.EXPECTED_CONTRACT_WASM_HASH || "",
    version: process.env.NEXT_PUBLIC_CONTRACT_VERSION || "v0.1.0",
  },
  protocolParameters: {
    roundDuration: "7 days",
    minDeposit: "100 XLM",
    maxDeposit: "250,000 XLM",
    treasuryFee: "0.75%",
    settlementQuorum: "3 of 5",
    emergencyPauseThreshold: "2 failed attempts",
  },
  indexer: {
    softLagLedgers: 100,
    hardLagLedgers: 500,
    staleAfterMs: 5 * 60 * 1000,
  },
  remediation: {
    rpc: `${GITHUB_DOCS}/ADMIN_HEALTH_REMEDIATION.md#1-rpc-health`,
    indexer: `${GITHUB_DOCS}/INDEXER_RUNBOOK.md`,
    contractHash: `${GITHUB_DOCS}/ADMIN_HEALTH_REMEDIATION.md#2-contract-wasm-provenance`,
    configDrift: `${GITHUB_DOCS}/ADMIN_HEALTH_REMEDIATION.md#3-configuration-drift`,
  },
};

/** High latency soft threshold for Horizon/Soroban probes (ms). */
export const RPC_STALE_LATENCY_MS = 1500;

/** Allow bounded clock skew between the indexer and the health endpoint. */
const INDEXER_MAX_CLOCK_SKEW_MS = 60_000;

export function worstHealth(...states: HealthState[]): HealthState {
  if (states.includes("degraded")) return "degraded";
  if (states.includes("stale")) return "stale";
  return "healthy";
}

export function evaluateRpcHealth(
  probe: RpcProbeInput,
  provenance: CanonicalProvenance = CANONICAL_PROVENANCE,
  now: Date = new Date(),
): DependencyCheck {
  const checkedAt = now.toISOString();
  const endpoint = probe.endpoint || provenance.network.horizonUrl;
  const remediationUrl = provenance.remediation.rpc;
  const base = {
    id: "rpc",
    name: "Horizon / Soroban RPC",
    kind: "rpc" as const,
    latencyMs: probe.latencyMs,
    checkedAt,
    remediationUrl,
    metadata: { endpoint, networkPassphrase: probe.networkPassphrase ?? null },
  };

  if (!probe.ok) {
    return {
      ...base,
      status: "degraded",
      detail: probe.error || "RPC endpoint unreachable or returned an error.",
    };
  }

  if (!probe.networkPassphrase) {
    return {
      ...base,
      status: "degraded",
      detail: "RPC response did not include a network passphrase.",
    };
  }

  if (probe.networkPassphrase !== provenance.network.passphrase) {
    return {
      ...base,
      status: "degraded",
      detail: `Network passphrase mismatch (got "${probe.networkPassphrase}", expected "${provenance.network.passphrase}").`,
    };
  }

  if (probe.latencyMs >= RPC_STALE_LATENCY_MS) {
    return {
      ...base,
      status: "stale",
      detail: `Elevated RPC latency (${probe.latencyMs}ms ≥ ${RPC_STALE_LATENCY_MS}ms).`,
    };
  }

  return {
    ...base,
    status: "healthy",
    detail: `RPC responding in ${probe.latencyMs}ms on the expected network.`,
  };
}

export function evaluateIndexerHealth(
  probe: IndexerProbeInput,
  provenance: CanonicalProvenance = CANONICAL_PROVENANCE,
  now: Date = new Date(),
): DependencyCheck {
  const checkedAt = now.toISOString();
  const remediationUrl = provenance.remediation.indexer;
  const syncLag = probe.syncLag ?? null;
  const latestLedger = probe.latestLedger ?? null;
  const lastError = typeof probe.lastError === "string" ? probe.lastError : null;
  const backendStatus =
    typeof probe.status === "string" ? probe.status.toLowerCase() : "";
  const successAt =
    typeof probe.lastSuccessSyncTime === "string"
      ? Date.parse(probe.lastSuccessSyncTime)
      : NaN;

  const base = {
    id: "indexer",
    name: "Event indexer",
    kind: "indexer" as const,
    checkedAt,
    remediationUrl,
    metadata: {
      latestLedger,
      syncLag,
      lastSyncTime: probe.lastSyncTime ?? null,
      lastSuccessSyncTime: probe.lastSuccessSyncTime ?? null,
      lastError,
      backendStatus: backendStatus || null,
    },
  };

  if (
    !["healthy", "lagging", "stale", "degraded"].includes(backendStatus) ||
    typeof syncLag !== "number" ||
    !Number.isSafeInteger(syncLag) ||
    syncLag < 0 ||
    (latestLedger !== null &&
      (typeof latestLedger !== "number" ||
        !Number.isSafeInteger(latestLedger) ||
        latestLedger < 0)) ||
    !Number.isFinite(successAt) ||
    successAt > now.getTime() + INDEXER_MAX_CLOCK_SKEW_MS ||
    (probe.lastError != null && typeof probe.lastError !== "string") ||
    (probe.message != null && typeof probe.message !== "string")
  ) {
    return {
      ...base,
      status: "degraded",
      detail: "Indexer health response is incomplete or invalid.",
    };
  }

  if (lastError || backendStatus === "degraded") {
    return {
      ...base,
      status: "degraded",
      detail:
        lastError ||
        probe.message ||
        "Indexer reported a hard error (see INDEXER_RUNBOOK).",
    };
  }

  if (syncLag >= provenance.indexer.hardLagLedgers) {
    return {
      ...base,
      status: "degraded",
      detail: `Indexer hard lag: ${syncLag} ledgers (critical ≥ ${provenance.indexer.hardLagLedgers}).`,
    };
  }

  const ageMs = Math.max(0, now.getTime() - successAt);
  if (ageMs >= provenance.indexer.staleAfterMs) {
    return {
      ...base,
      status: "stale",
      detail: `Last successful sync ${Math.round(ageMs / 1000)}s ago (stale after ${provenance.indexer.staleAfterMs / 1000}s).`,
    };
  }

  if (
    syncLag >= provenance.indexer.softLagLedgers ||
    backendStatus === "lagging" ||
    backendStatus === "stale"
  ) {
    return {
      ...base,
      status: "stale",
      detail: `Indexer soft lag: ${syncLag} ledgers (warning ≥ ${provenance.indexer.softLagLedgers}).`,
    };
  }

  return {
    ...base,
    status: "healthy",
    detail:
      probe.message ||
      `Indexer in sync (lag ${syncLag} ledger${syncLag === 1 ? "" : "s"}).`,
  };
}

export function verifyContractProvenance(
  observedWasmHash: string | null | undefined,
  provenance: CanonicalProvenance = CANONICAL_PROVENANCE,
  now: Date = new Date(),
): DependencyCheck {
  const checkedAt = now.toISOString();
  const expected = normalizeHash(provenance.contract.expectedWasmHash);
  const actual = normalizeHash(observedWasmHash || "");
  const remediationUrl = provenance.remediation.contractHash;
  const base = {
    id: "contract_hash",
    name: "Smart contract WASM hash",
    kind: "contract_hash" as const,
    checkedAt,
    remediationUrl,
    metadata: {
      contractId: provenance.contract.contractId,
      expectedHash: provenance.contract.expectedWasmHash,
      actualHash: observedWasmHash || null,
      version: provenance.contract.version,
    },
  };

  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return {
      ...base,
      status: "degraded",
      detail: "Expected release WASM hash is missing or invalid.",
    };
  }

  if (!/^[0-9a-f]{64}$/.test(actual)) {
    return {
      ...base,
      status: "degraded",
      detail: "Observed on-chain WASM hash is missing or invalid.",
    };
  }

  if (actual !== expected) {
    return {
      ...base,
      status: "degraded",
      detail: `Deployed WASM hash diverges from canonical release (${provenance.contract.version}).`,
    };
  }

  return {
    ...base,
    status: "healthy",
    detail: `Contract WASM hash matches canonical ${provenance.contract.version} provenance.`,
  };
}

export function detectConfigDrift(
  runtime: (Partial<ProtocolParameters> & { contractId?: string }) | null,
  provenance: CanonicalProvenance = CANONICAL_PROVENANCE,
  now: Date = new Date(),
): ConfigDriftReport {
  const checkedAt = now.toISOString();
  const remediationUrl = provenance.remediation.configDrift;
  const drifts: ConfigDriftItem[] = [];

  (Object.keys(provenance.protocolParameters) as ProtocolParameterKey[]).forEach(
    (key) => {
      const expected = provenance.protocolParameters[key];
      const actual = runtime?.[key];
      if (typeof actual !== "string" || !actual.trim()) {
        drifts.push({
          parameter: key,
          expected,
          actual: "unavailable",
          severity: "critical",
          impact: "No independent runtime observation is available.",
        });
        return;
      }
      if (normalizeValue(actual) === normalizeValue(expected)) return;
      drifts.push({
        parameter: key,
        expected,
        actual,
        severity: CRITICAL_PARAMETERS.has(key) ? "critical" : "warning",
        impact: PARAMETER_IMPACT[key],
      });
    },
  );

  const actualContractId = runtime?.contractId;
  if (typeof actualContractId !== "string" || !actualContractId.trim()) {
    drifts.push({
      parameter: "contractId",
      expected: provenance.contract.contractId,
      actual: "unavailable",
      severity: "critical",
      impact: "The active contract ID could not be observed.",
    });
  } else if (actualContractId !== provenance.contract.contractId) {
    drifts.push({
      parameter: "contractId",
      expected: provenance.contract.contractId,
      actual: actualContractId,
      severity: "critical",
      impact: "UI / indexer may be talking to a different on-chain deployment.",
    });
  }

  const hasCritical = drifts.some((d) => d.severity === "critical");
  const status: HealthState = !drifts.length
    ? "healthy"
    : hasCritical
      ? "degraded"
      : "stale";

  return {
    status,
    hasDrift: drifts.length > 0,
    drifts,
    checkedAt,
    remediationUrl,
  };
}

export function configDriftToDependency(
  report: ConfigDriftReport,
): DependencyCheck {
  return {
    id: "config_drift",
    name: "Configuration drift",
    kind: "config_drift",
    status: report.status,
    detail: report.hasDrift
      ? `${report.drifts.length} parameter${report.drifts.length === 1 ? "" : "s"} diverge from canonical provenance.`
      : "Runtime protocol parameters match canonical provenance.",
    checkedAt: report.checkedAt,
    remediationUrl: report.remediationUrl,
    metadata: { drifts: report.drifts },
  };
}

export function aggregateAdminHealth(input: {
  rpc: DependencyCheck;
  indexer: DependencyCheck;
  contract: DependencyCheck;
  configDrift: ConfigDriftReport;
  checkedAt?: string;
}): AdminHealthOverview {
  const driftDependency = configDriftToDependency(input.configDrift);
  const dependencies = [
    input.rpc,
    input.indexer,
    input.contract,
    driftDependency,
  ];
  const summary = {
    healthy: dependencies.filter((d) => d.status === "healthy").length,
    stale: dependencies.filter((d) => d.status === "stale").length,
    degraded: dependencies.filter((d) => d.status === "degraded").length,
    total: dependencies.length,
  };
  const status = worstHealth(...dependencies.map((d) => d.status));
  const checkedAt =
    input.checkedAt ||
    dependencies.map((d) => d.checkedAt).sort().at(-1) ||
    new Date().toISOString();

  return {
    status,
    checkedAt,
    summary,
    dependencies,
    configDrift: input.configDrift,
  };
}

function normalizeHash(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, "");
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
