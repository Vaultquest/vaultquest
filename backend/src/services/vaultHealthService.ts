/**
 * Aggregated vault health contract for the status panel (#115).
 *
 * The panel used to decide every service state with `Math.random()`, so a user
 * reading "Vault Smart Contracts: Healthy" was reading a dice roll. This
 * module aggregates the signals that actually exist in the backend and, when a
 * dependency has no trustworthy probe, reports `unknown` instead of guessing.
 *
 * Deliberately injectable: `indexer`, `probes` and `now` all default to the
 * production wiring but can be replaced in tests, and an oracle probe can be
 * added later without changing the response shape.
 */
import { probeDependencies, type ProbeOptions, type ProbeResult } from "./probeService.js";

export type VaultServiceStatus = "operational" | "degraded" | "outage" | "unknown";

export interface VaultServiceHealth {
  id: string;
  name: string;
  status: VaultServiceStatus;
  /** Round-trip time of the probe that produced this state, when one ran. */
  latency_ms: number | null;
  /** When the underlying signal was captured, ISO-8601. */
  checked_at: string | null;
  /** Age of that signal at aggregation time, in milliseconds. */
  age_ms: number | null;
  /** True when the signal is older than `staleAfterMs`. */
  stale: boolean;
  /** Which backend signal produced this row. `none` means "no probe". */
  source: "indexer" | "probe" | "none";
  /** Human-readable reason for `degraded` / `outage` / `unknown`. */
  message?: string;
}

export interface VaultHealthResult {
  status: VaultServiceStatus;
  checked_at: string;
  services: VaultServiceHealth[];
}

/** Shape of `LedgerService.getIndexerHealth()` we depend on. */
export interface IndexerHealthLike {
  status?: string;
  latency_ms?: number;
  last_success_sync_time?: string | Date | null;
  sync_lag?: number;
  message?: string;
}

export interface VaultHealthOptions {
  indexer?: () => Promise<IndexerHealthLike>;
  probes?: () => Promise<ProbeResult>;
  now?: () => Date;
  /** A signal older than this is reported `stale`. Default 5 minutes. */
  staleAfterMs?: number;
  probeOptions?: ProbeOptions;
}

export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;

/** Soroban RPC is the endpoint the vault contracts are read through. */
export const CONTRACTS_PROBE_ID = "stellar-rpc";

function ageOf(checkedAt: Date | null, now: Date): number | null {
  if (!checkedAt) return null;
  const ms = checkedAt.getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, now.getTime() - ms);
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Map the indexer's own vocabulary onto the panel's four states. */
function mapIndexerStatus(status: string | undefined): VaultServiceStatus {
  if (status === "healthy") return "operational";
  if (status === "degraded") return "degraded";
  if (status === "unhealthy") return "outage";
  return "unknown";
}

function unknownRow(id: string, name: string, message: string): VaultServiceHealth {
  return {
    id,
    name,
    status: "unknown",
    latency_ms: null,
    checked_at: null,
    age_ms: null,
    stale: false,
    source: "none",
    message,
  };
}

function aggregateStatus(services: VaultServiceHealth[]): VaultServiceStatus {
  if (services.some((s) => s.status === "outage")) return "outage";
  if (services.some((s) => s.status === "degraded")) return "degraded";
  if (services.length > 0 && services.every((s) => s.status === "unknown")) return "unknown";
  return "operational";
}

export async function getVaultHealth(
  options: VaultHealthOptions = {}
): Promise<VaultHealthResult> {
  const now = options.now ?? (() => new Date());
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const nowDate = now();

  const services: VaultServiceHealth[] = [];

  // 1. Data indexer — the backend already tracks a real checkpoint, lag and
  //    last successful sync, so this row reflects stored state.
  if (options.indexer) {
    try {
      const health = await options.indexer();
      const lastSuccess = toDate(health.last_success_sync_time);
      const age = ageOf(lastSuccess, nowDate);
      const status = mapIndexerStatus(health.status);
      services.push({
        id: "data-indexer",
        name: "Data Indexer",
        status,
        latency_ms: typeof health.latency_ms === "number" ? health.latency_ms : null,
        checked_at: lastSuccess ? lastSuccess.toISOString() : null,
        age_ms: age,
        stale: age !== null && age > staleAfterMs,
        source: "indexer",
        ...(health.message || health.sync_lag
          ? {
              message:
                health.message ??
                "Indexer is " + String(health.sync_lag) + " ledgers behind",
            }
          : {}),
      });
    } catch (err) {
      services.push({
        id: "data-indexer",
        name: "Data Indexer",
        status: "outage",
        latency_ms: null,
        checked_at: null,
        age_ms: null,
        stale: false,
        source: "indexer",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    services.push(
      unknownRow("data-indexer", "Data Indexer", "No indexer health source is wired up.")
    );
  }

  // 2. Vault contracts — read through Soroban RPC, so the RPC probe result is
  //    the reachability signal. A missing probe is reported as unknown.
  let probes: ProbeResult | null = null;
  let probeError: string | null = null;
  if (options.probes) {
    try {
      probes = await options.probes();
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
    }
  }

  const contractsCheck = probes?.checks?.find((c) => c.id === CONTRACTS_PROBE_ID);
  const probeCheckedAt = toDate(probes?.checked_at);
  const probeAge = ageOf(probeCheckedAt, nowDate);

  if (probeError) {
    services.push({
      id: "vault-contracts",
      name: "Vault Smart Contracts",
      status: "outage",
      latency_ms: null,
      checked_at: null,
      age_ms: null,
      stale: false,
      source: "probe",
      message: probeError,
    });
  } else if (contractsCheck) {
    services.push({
      id: "vault-contracts",
      name: "Vault Smart Contracts",
      status: contractsCheck.status,
      latency_ms:
        typeof contractsCheck.latency_ms === "number" ? contractsCheck.latency_ms : null,
      checked_at: probeCheckedAt ? probeCheckedAt.toISOString() : null,
      age_ms: probeAge,
      stale: probeAge !== null && probeAge > staleAfterMs,
      source: "probe",
      ...(contractsCheck.error ? { message: contractsCheck.error } : {}),
    });
  } else {
    services.push(
      unknownRow(
        "vault-contracts",
        "Vault Smart Contracts",
        "No Soroban RPC probe result was available for this aggregation."
      )
    );
  }

  // 3. Prize oracle — no probe exists in this build yet. Reporting unknown is
  //    the point of the contract: the row must not invent a state, and the
  //    aggregation is injectable so a real oracle probe can replace this
  //    without changing the response shape.
  services.push(
    unknownRow(
      "prize-oracle",
      "Prize Oracle",
      "No oracle probe is configured, so the oracle state is unknown."
    )
  );

  return {
    status: aggregateStatus(services),
    checked_at: nowDate.toISOString(),
    services,
  };
}

/** Production wiring: real indexer state, real network probes. */
export function defaultVaultHealthOptions(
  indexer: () => Promise<IndexerHealthLike>,
  probeOptions: ProbeOptions = {}
): VaultHealthOptions {
  return {
    indexer,
    probes: () => probeDependencies(probeOptions),
  };
}
