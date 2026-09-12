/**
 * Client-side contract for the aggregated vault health endpoint (#115).
 *
 * The status panel used to decide every service state with `Math.random()`, so
 * the dashboard reported fictional operational status. It now reads
 * `/api/health/vault`, and this module owns the mapping from that payload to
 * the four states the UI can render: operational, degraded, outage, unknown.
 *
 * The rule that matters: anything that cannot be trusted renders `unknown`.
 * A missing row, an unparsable timestamp, a payload older than the freshness
 * window, a non-2xx response, a timeout and a body that is not the expected
 * shape all resolve to unknown. None of them may resolve to operational,
 * because "green" is a claim about the system and the client is not entitled
 * to make it without evidence.
 */

/** Same-origin proxy route that serves the backend aggregation. */
export const VAULT_HEALTH_URL = "/api/health/vault";

/** Abort the request after this long; a hung probe is not a healthy probe. */
export const DEFAULT_TIMEOUT_MS = 8000;

/** A payload older than this is treated as stale and rendered unknown. */
export const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

/** Refresh cadence for the panel. */
export const REFRESH_INTERVAL_MS = 30000;

/** Services the panel renders, in display order. */
export const VAULT_SERVICE_REGISTRY = [
  { id: "vault-contracts", name: "Vault Smart Contracts" },
  { id: "prize-oracle", name: "Prize Oracle" },
  { id: "data-indexer", name: "Data Indexer" },
];

export const VAULT_STATUSES = ["operational", "degraded", "outage"];

function toAgeMs(checkedAt, now) {
  if (typeof checkedAt !== "string" || checkedAt === "") return null;
  const parsed = Date.parse(checkedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

function unknownService(id, name, message) {
  return {
    id,
    name,
    status: "unknown",
    latencyMs: null,
    ageMs: null,
    stale: false,
    message,
  };
}

/**
 * Reduce a backend payload to the panel model.
 *
 * @param {unknown} payload Parsed `/api/health/vault` body (the endpoint wraps
 *   its data, so pass either the wrapper or the inner object).
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 * @returns {{ overall: string, services: Array<object>, checkedAt: string|null, reason: string|null }}
 */
export function normalizeVaultHealth(payload, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  const body = payload && typeof payload === "object" && payload.services ? payload : null;
  if (!body) {
    return {
      overall: "unknown",
      checkedAt: null,
      reason: "Health payload was missing or not in the expected shape.",
      services: VAULT_SERVICE_REGISTRY.map((svc) =>
        unknownService(svc.id, svc.name, "No trustworthy health payload received.")
      ),
    };
  }

  const payloadAge = toAgeMs(body.checked_at, now);
  const payloadStale = payloadAge === null || payloadAge > maxAgeMs;
  const reported = Array.isArray(body.services) ? body.services : [];

  const services = VAULT_SERVICE_REGISTRY.map((svc) => {
    const row = reported.find((r) => r && r.id === svc.id);
    if (!row) {
      return unknownService(svc.id, svc.name, "This service was not reported by the backend.");
    }

    const ageMs = toAgeMs(row.checked_at, now);
    const rowStale = row.stale === true || ageMs === null || ageMs > maxAgeMs;

    if (!VAULT_STATUSES.includes(row.status)) {
      return unknownService(svc.id, svc.name, "Backend reported an unrecognised status.");
    }
    if (rowStale) {
      return {
        id: svc.id,
        name: svc.name,
        status: "unknown",
        latencyMs: typeof row.latency_ms === "number" ? row.latency_ms : null,
        ageMs,
        stale: true,
        message: "Last reading is older than the freshness window.",
      };
    }

    return {
      id: svc.id,
      name: svc.name,
      status: row.status,
      latencyMs: typeof row.latency_ms === "number" ? row.latency_ms : null,
      ageMs,
      stale: false,
      message: typeof row.message === "string" && row.message ? row.message : null,
    };
  });

  if (payloadStale) {
    return {
      overall: "unknown",
      checkedAt: null,
      reason: "The health payload is older than the freshness window.",
      services: services.map((svc) =>
        svc.status === "unknown"
          ? svc
          : { ...svc, status: "unknown", stale: true, message: "Health payload is stale." }
      ),
    };
  }

  const overall = deriveOverallStatus(services);
  return { overall, services, checkedAt: body.checked_at, reason: null };
}

/** outage beats degraded beats all-unknown beats operational. */
export function deriveOverallStatus(services) {
  if (!Array.isArray(services) || services.length === 0) return "unknown";
  if (services.some((s) => s.status === "outage")) return "outage";
  if (services.some((s) => s.status === "degraded")) return "degraded";
  if (services.every((s) => s.status === "unknown")) return "unknown";
  return "operational";
}

/** Every row unknown — the state to show when the request itself failed. */
export function allUnknown(reason) {
  return {
    overall: "unknown",
    checkedAt: null,
    reason,
    services: VAULT_SERVICE_REGISTRY.map((svc) => unknownService(svc.id, svc.name, reason)),
  };
}

/**
 * Fetch and normalise the aggregated health contract. Never throws: a failed
 * request is a health result too, and it is rendered unknown.
 *
 * @param {{ fetcher?: typeof fetch, url?: string, timeoutMs?: number, now?: number, maxAgeMs?: number }} [options]
 */
export async function fetchVaultHealth(options = {}) {
  const fetcher = options.fetcher ?? (typeof fetch === "function" ? fetch : null);
  const url = options.url ?? VAULT_HEALTH_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!fetcher) {
    return allUnknown("No fetch implementation is available in this environment.");
  }

  const controller =
    typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  if (controller) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!response || typeof response.ok !== "boolean") {
      return allUnknown("Health endpoint returned an unreadable response.");
    }
    if (!response.ok) {
      return allUnknown(
        "Health endpoint returned HTTP " + String(response.status) + "."
      );
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return allUnknown("Health endpoint returned a body that is not valid JSON.");
    }

    const inner = body && typeof body === "object" && body.data ? body.data : body;
    return normalizeVaultHealth(inner, {
      now: options.now,
      maxAgeMs: options.maxAgeMs,
    });
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || err.name === "TimeoutError");
    return allUnknown(
      aborted
        ? "Health request timed out after " + String(timeoutMs) + "ms."
        : "Health request failed; service state is unknown."
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default { fetchVaultHealth, normalizeVaultHealth, deriveOverallStatus, VAULT_HEALTH_URL };
