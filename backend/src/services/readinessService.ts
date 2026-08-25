import type { PrismaClient } from "@prisma/client";
import type { CacheService } from "./cacheService.js";
import type { LedgerService } from "./ledger.js";

export type CheckStatus = "healthy" | "degraded" | "unhealthy" | "not_configured";

export interface DependencyCheckResult {
  status: CheckStatus;
  latency_ms: number;
  error?: string;
}

export interface IndexerCheckResult extends DependencyCheckResult {
  sync_lag: number;
}

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: {
    database: DependencyCheckResult;
    cache: DependencyCheckResult;
    indexer: IndexerCheckResult;
  };
  timestamp: string;
}

export interface ReadinessOptions {
  /** Max time allowed for the database ping before it counts as unhealthy. */
  databaseTimeoutMs?: number;
  /** Max time allowed for the cache ping before it counts as degraded. */
  cacheTimeoutMs?: number;
  /** Max time allowed for the indexer checkpoint read before it counts as unhealthy. */
  indexerTimeoutMs?: number;
  /** Forwarded to LedgerService.getIndexerHealth's own freshness threshold. */
  indexerStaleAfterMs?: number;
  now?: Date;
}

const DEFAULT_DATABASE_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TIMEOUT_MS = 1000;
const DEFAULT_INDEXER_TIMEOUT_MS = 2000;

class CheckTimeoutError extends Error {
  constructor(dependency: string, ms: number) {
    super(`${dependency} check timed out after ${ms}ms`);
    this.name = "CheckTimeoutError";
  }
}

/**
 * Races `run` against a timer so a hung dependency can never make the
 * readiness endpoint itself hang. This bounds how long the *caller* waits;
 * it does not cancel the underlying I/O (`$queryRaw`/`PING` have no
 * portable cancellation token here), so an already-in-flight query can
 * still complete on the database/Redis side after this rejects. That is an
 * accepted trade-off — the goal is a fast, deterministic answer to "can we
 * serve traffic right now," not aborting server-side work.
 *
 * Time: O(1) beyond the wrapped call itself — one timer, one race.
 */
async function withTimeout<T>(run: () => Promise<T>, ms: number, dependency: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeoutError(dependency, ms)), ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pings the database with the cheapest possible query. `SELECT 1` touches
 * no table and does no I/O beyond round-tripping the connection, so this
 * carries negligible load even when polled every few seconds by a load
 * balancer or orchestrator.
 */
async function checkDatabase(prisma: PrismaClient, timeoutMs: number): Promise<DependencyCheckResult> {
  const start = Date.now();
  try {
    await withTimeout(() => prisma.$queryRaw`SELECT 1`, timeoutMs, "database");
    return { status: "healthy", latency_ms: Date.now() - start };
  } catch (err) {
    return { status: "unhealthy", latency_ms: Date.now() - start, error: errorMessage(err) };
  }
}

/**
 * Pings the cache via `CacheService.ping()`. A configured-but-unreachable
 * Redis is reported `degraded`, not `unhealthy` — `CacheService` already
 * falls back to PostgreSQL (checkpoint) or the source (generic cache)
 * whenever Redis is down, so this cannot by itself make the service unable
 * to serve traffic. An unconfigured Redis (`redisUrl` omitted) is a
 * deliberate deployment mode, reported `not_configured`.
 */
async function checkCache(
  cacheService: CacheService | undefined,
  timeoutMs: number
): Promise<DependencyCheckResult> {
  if (!cacheService) {
    return { status: "not_configured", latency_ms: 0 };
  }
  const start = Date.now();
  try {
    const result = await withTimeout(() => cacheService.ping(), timeoutMs, "cache");
    if (!result.configured) return { status: "not_configured", latency_ms: 0 };
    if (result.healthy) return { status: "healthy", latency_ms: result.latencyMs };
    return { status: "degraded", latency_ms: result.latencyMs, error: result.error };
  } catch (err) {
    return { status: "degraded", latency_ms: Date.now() - start, error: errorMessage(err) };
  }
}

/**
 * Reads indexer freshness via the existing `LedgerService.getIndexerHealth`
 * (already backed by a single checkpoint lookup — Redis when configured,
 * Postgres otherwise). `lagging`/`degraded` map to this check's `unhealthy`:
 * per the issue this guards against, a stale indexer can serve outdated
 * on-chain state, which is a correctness problem for traffic routed here,
 * not a mere performance one — unlike the cache check above.
 */
async function checkIndexer(
  ledgerService: LedgerService,
  timeoutMs: number,
  staleAfterMs: number | undefined,
  now: Date | undefined
): Promise<IndexerCheckResult> {
  const start = Date.now();
  try {
    const health = await withTimeout(
      () => ledgerService.getIndexerHealth({ staleAfterMs, now }),
      timeoutMs,
      "indexer"
    );
    const status: CheckStatus = health.status === "healthy" ? "healthy" : "unhealthy";
    return {
      status,
      latency_ms: Date.now() - start,
      sync_lag: health.sync_lag ?? 0,
      ...(health.status !== "healthy" ? { error: health.message } : {})
    };
  } catch (err) {
    return { status: "unhealthy", latency_ms: Date.now() - start, sync_lag: 0, error: errorMessage(err) };
  }
}

/**
 * Aggregates bounded, parallel dependency checks into a single readiness
 * verdict. Database and indexer freshness are required — either being
 * unhealthy flips the overall status to `not_ready` so a load balancer
 * stops routing traffic here. Cache is best-effort and never gates
 * readiness on its own (see `checkCache`).
 *
 * Time: O(1) — three fixed-cost checks run concurrently via `Promise.all`,
 * so wall-clock latency is bounded by the *slowest* single check's timeout
 * (default max 2s), not their sum. Space: O(1) — a fixed-shape result
 * object, no accumulation across calls or requests.
 */
export async function getReadiness(
  prisma: PrismaClient,
  ledgerService: LedgerService,
  cacheService: CacheService | undefined,
  options: ReadinessOptions = {}
): Promise<ReadinessResult> {
  const [database, cache, indexer] = await Promise.all([
    checkDatabase(prisma, options.databaseTimeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS),
    checkCache(cacheService, options.cacheTimeoutMs ?? DEFAULT_CACHE_TIMEOUT_MS),
    checkIndexer(
      ledgerService,
      options.indexerTimeoutMs ?? DEFAULT_INDEXER_TIMEOUT_MS,
      options.indexerStaleAfterMs,
      options.now
    )
  ]);

  const status = database.status === "healthy" && indexer.status === "healthy" ? "ready" : "not_ready";

  return {
    status,
    checks: { database, cache, indexer },
    timestamp: (options.now ?? new Date()).toISOString()
  };
}
