/**
 * Probe targets measured by the same-origin `/health/probe` endpoint (#116).
 *
 * The browser status banner can no longer rely on `mode: "no-cors"` fetches
 * to third-party hosts: an opaque response hides the real status and the old
 * code marked every resolved fetch "operational". Probing now happens
 * server-side, where CORS does not apply, using the method each endpoint
 * actually accepts:
 * - Horizon serves plain GET requests.
 * - Soroban RPC and the Avalanche C-Chain RPC are JSON-RPC endpoints and only
 *   answer POST; their base URLs return 405 for GET/HEAD.
 */
export const DEFAULT_PROBE_TARGETS = [
  {
    id: "stellar-horizon",
    name: "Stellar Horizon API",
    url: "https://horizon.stellar.org",
    method: "GET",
  },
  {
    id: "stellar-rpc",
    name: "Stellar RPC",
    url: "https://soroban-testnet.stellar.org",
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "getHealth" },
  },
  {
    id: "avalanche-rpc",
    name: "Avalanche RPC",
    url: "https://api.avax.network/ext/bc/C/rpc",
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
  },
] as const;

export type ProbeStatus = "operational" | "degraded" | "outage";

export const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export const DEFAULT_SLOW_THRESHOLD_MS = 1500;

/**
 * Minimal fetch contract the probe depends on. The real global `fetch`
 * satisfies it structurally, and tests inject a stub so probes never touch
 * the network.
 */
export interface ProbeFetcher {
  (url: string, init?: RequestInit): Promise<{ ok: boolean; status: number }>;
}

export interface ProbeTarget {
  id: string;
  name: string;
  url: string;
  method?: "GET" | "HEAD" | "POST";
  body?: Record<string, unknown>;
}

export interface ProbeCheck {
  id: string;
  name: string;
  url: string;
  status: ProbeStatus;
  latency_ms: number;
  error?: string;
}

export interface ProbeResult {
  status: ProbeStatus;
  checked_at: string;
  checks: ProbeCheck[];
}

export interface ProbeOptions {
  targets?: readonly ProbeTarget[];
  timeoutMs?: number;
  slowThresholdMs?: number;
  fetchFn?: ProbeFetcher;
  now?: () => Date;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

/**
 * Probes one target with a bounded timeout and reports the *elapsed* latency
 * (never a `Date.now()` wall-clock stamp). `latency_ms` is clamped to the
 * timeout so a hung upstream can never report a latency larger than the wait.
 *
 * Classification:
 * - 2xx within `slowThresholdMs`           -> operational
 * - 2xx slower than `slowThresholdMs`      -> degraded  (slow success)
 * - request aborted by the timeout         -> degraded  (timeout)
 * - non-2xx HTTP status                    -> outage    (HTTP error)
 * - network/other rejection                -> outage
 */
async function probeTarget(
  target: ProbeTarget,
  fetchFn: ProbeFetcher,
  timeoutMs: number,
  slowThresholdMs: number
): Promise<ProbeCheck> {
  const started = performance.now();
  const base = { id: target.id, name: target.name, url: target.url };

  try {
    const response = await fetchFn(target.url, {
      method: target.method ?? "GET",
      ...(target.body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(target.body),
          }
        : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Math.min(
      Math.round(performance.now() - started),
      timeoutMs
    );

    if (!response.ok) {
      return {
        ...base,
        status: "outage",
        latency_ms: latencyMs,
        error: `HTTP ${response.status}`,
      };
    }

    return {
      ...base,
      status: latencyMs > slowThresholdMs ? "degraded" : "operational",
      latency_ms: latencyMs,
      ...(latencyMs > slowThresholdMs
        ? { error: `Slow response (${latencyMs}ms)` }
        : {}),
    };
  } catch (err) {
    const latencyMs = Math.min(
      Math.round(performance.now() - started),
      timeoutMs
    );
    if (isTimeoutError(err)) {
      return {
        ...base,
        status: "degraded",
        latency_ms: latencyMs,
        error: `Probe timed out after ${timeoutMs}ms`,
      };
    }
    return {
      ...base,
      status: "outage",
      latency_ms: latencyMs,
      error: errorMessage(err),
    };
  }
}

/**
 * Worst-status aggregation: any outage flips the aggregate to outage, any
 * degraded flips it to degraded, otherwise operational.
 */
export function aggregateProbeStatus(
  checks: readonly ProbeCheck[]
): ProbeStatus {
  if (checks.some((check) => check.status === "outage")) return "outage";
  if (checks.some((check) => check.status === "degraded")) return "degraded";
  return "operational";
}

/**
 * Server-side dependency probe for the browser status banner.
 *
 * Probes every target concurrently so wall-clock cost is bounded by the
 * slowest single check (default 5s), never the sum. The response includes an
 * explicit `checked_at` probe timestamp so the consuming banner can display
 * freshness instead of the client's own wall-clock time, and a synthetic
 * "backend" check proving the probe itself executed.
 *
 * Time: O(1) beyond the probes themselves — a fixed target set, one round of
 * `Promise.all`, and per-check timers. Space: O(targets) — a fixed-shape
 * result, no accumulation across calls.
 */
export async function probeDependencies(
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const targets =
    options.targets ?? (DEFAULT_PROBE_TARGETS as unknown as readonly ProbeTarget[]);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const slowThresholdMs = options.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const fetchFn =
    options.fetchFn ?? (globalThis.fetch.bind(globalThis) as ProbeFetcher);
  const now = options.now ?? (() => new Date());

  const started = performance.now();
  const remoteChecks = await Promise.all(
    targets.map((target) =>
      probeTarget(target, fetchFn, timeoutMs, slowThresholdMs)
    )
  );
  const elapsedMs = Math.min(
    Math.round(performance.now() - started),
    timeoutMs
  );

  const checks: ProbeCheck[] = [
    ...remoteChecks,
    {
      id: "backend",
      name: "VaultQuest Backend",
      url: "/health/probe",
      status: "operational",
      latency_ms: elapsedMs,
    },
  ];

  return {
    status: aggregateProbeStatus(checks),
    checked_at: now().toISOString(),
    checks,
  };
}