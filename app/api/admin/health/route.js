import { NextResponse } from "next/server";
import {
  CANONICAL_PROVENANCE,
  aggregateAdminHealth,
  detectConfigDrift,
  evaluateIndexerHealth,
  evaluateRpcHealth,
  verifyContractProvenance,
  worstHealth,
} from "@/lib/deployment-provenance";
import {
  contractInstanceLedgerKey,
  wasmHashFromContractInstance,
} from "@vaultquest/stellar-wallet-connect/admin-provenance";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";
const PROBE_TIMEOUT_MS = 6000;
const CONFIG_MAX_AGE_MS = 5 * 60 * 1000;

// Share only an observation that is still running in this process. A settled
// result is never cached, so the next refresh always probes dependencies again.
let inFlightOverview = null;

export async function GET() {
  if (!inFlightOverview) {
    inFlightOverview = collectOverview().finally(() => {
      inFlightOverview = null;
    });
  }
  const overview = await inFlightOverview;

  // Each caller owns its response body even when the observation was shared.
  return NextResponse.json(overview, {
    status: overview.status === "degraded" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Each dependency is observed independently. Missing or invalid observations
 * are degraded; an expected release value can never stand in for a live value.
 */
async function collectOverview() {
  const provenance = CANONICAL_PROVENANCE;
  const now = new Date();
  const [horizonProbe, sorobanProbe, indexerProbe, observedWasmHash, runtimeConfig] =
    await Promise.all([
      probeHorizon(provenance.network.horizonUrl),
      probeSoroban(provenance.network.sorobanRpcUrl),
      probeIndexer(),
      probeContractHash(
        provenance.network.sorobanRpcUrl,
        provenance.contract.contractId,
      ),
      probeRuntimeConfig(now),
    ]);

  const horizon = evaluateRpcHealth(
    { ...horizonProbe, endpoint: provenance.network.horizonUrl },
    provenance,
    now,
  );
  const soroban = evaluateRpcHealth(
    { ...sorobanProbe, endpoint: provenance.network.sorobanRpcUrl },
    provenance,
    now,
  );
  const rpc = {
    ...horizon,
    status: worstHealth(horizon.status, soroban.status),
    detail: "Horizon: " + horizon.detail + " Soroban: " + soroban.detail,
    latencyMs: Math.max(horizon.latencyMs || 0, soroban.latencyMs || 0),
    metadata: { horizon: horizon.metadata, soroban: soroban.metadata },
  };
  const indexer = evaluateIndexerHealth(indexerProbe, provenance, now);
  const contract = verifyContractProvenance(observedWasmHash, provenance, now);
  const configDrift = detectConfigDrift(runtimeConfig, provenance, now);
  const overview = aggregateAdminHealth({
    rpc,
    indexer,
    contract,
    configDrift,
    checkedAt: now.toISOString(),
  });

  return overview;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postSoroban(rpcUrl, method, params = {}) {
  const data = await fetchJson(rpcUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (data?.error || !data?.result) {
    throw new Error(data?.error?.message || "Invalid " + method + " RPC response");
  }
  return data.result;
}

async function probeSoroban(rpcUrl) {
  const started = Date.now();
  try {
    const [health, network] = await Promise.all([
      postSoroban(rpcUrl, "getHealth"),
      postSoroban(rpcUrl, "getNetwork"),
    ]);
    if (health.status !== "healthy" || !network.passphrase) {
      throw new Error("Soroban RPC unhealthy or missing network passphrase");
    }
    return {
      ok: true,
      latencyMs: Date.now() - started,
      networkPassphrase: network.passphrase,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Soroban RPC failed",
    };
  }
}

async function probeContractHash(rpcUrl, contractId) {
  try {
    const key = contractInstanceLedgerKey(contractId);
    const result = await postSoroban(rpcUrl, "getLedgerEntries", { keys: [key] });
    const entryXdr = result.entries?.[0]?.xdr;
    return typeof entryXdr === "string"
      ? wasmHashFromContractInstance(entryXdr)
      : null;
  } catch {
    return null;
  }
}

async function probeRuntimeConfig(now) {
  // This endpoint must expose observed runtime/on-chain values independently
  // of this route's canonical release baseline.
  const url = process.env.ADMIN_RUNTIME_CONFIG_URL;
  if (!url) return null;
  try {
    const payload = await fetchJson(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const data = payload?.data ?? payload;
    const observedAt = Date.parse(data?.observedAt ?? "");
    if (
      !Number.isFinite(observedAt) ||
      observedAt > now.getTime() + 60_000 ||
      now.getTime() - observedAt > CONFIG_MAX_AGE_MS
    ) {
      return null;
    }
    if (!data?.protocolParameters || typeof data.protocolParameters !== "object") {
      return null;
    }
    return { ...data.protocolParameters, contractId: data.contractId };
  } catch {
    return null;
  }
}

async function probeHorizon(horizonUrl) {
  const started = Date.now();
  try {
    const data = await fetchJson(horizonUrl, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      networkPassphrase: data?.network_passphrase ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Horizon probe failed",
    };
  }
}

async function probeIndexer() {
  try {
    const payload = await fetchJson(BACKEND_URL + "/health/indexer", {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const data = payload?.data ?? payload;
    return {
      status: data?.status ?? null,
      latestLedger: data?.latest_ledger ?? null,
      syncLag: data?.sync_lag ?? null,
      lastSyncTime: data?.last_sync_time ?? null,
      lastSuccessSyncTime: data?.last_success_sync_time ?? null,
      lastError: data?.last_error ?? null,
      message: data?.message ?? null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Indexer health probe failed";
    return { status: "degraded", lastError: message, message };
  }
}
