import { Redis } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { NULL_METRICS, type CacheMetricsSink } from "./cache/metrics.js";

/**
 * Caching layer for frequently requested on-chain and indexer data.
 *
 * Backs the indexer checkpoint and generic key/value cache with Redis when a
 * REDIS_URL is configured, falling back to PostgreSQL (checkpoint) or serving
 * straight from the source (generic cache) whenever Redis is unavailable.
 * Pending events, asset metadata, and protocol config use a small in-memory
 * LRU map since they are hot, short-lived, per-process lookups.
 */

export interface IndexerCheckpoint {
  id?: string;
  latestLedger: number;
  lastProcessedEventId?: string | null;
  lastSyncTime: Date;
  lastSuccessSyncTime?: Date;
  lastError?: string | null;
}

export interface PendingEvent {
  txHash: string;
  sorobanEventId: string;
  eventPayload: unknown;
  statusHint: "confirmed" | "reverted";
  receivedAt: Date;
  consumedAt?: Date | null;
}

export interface AssetMetadata {
  asset: string;
  decimals: number;
  lastUpdated: Date;
}

export interface ProtocolConfigRecord {
  key: string;
  value: unknown;
  updatedAt: Date;
}

interface Logger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}

type CacheEntry<T> = { value: T; accessedAt: Date };

/**
 * On-wire format for values stored by `getOrSet`. Redis keys are kept alive
 * for the full freshness horizon (`ttl + max(stale window)`) so an expired
 * entry can still be served stale; the envelope's `e` field is what decides
 * freshness, not the Redis TTL itself.
 */
interface StoredEnvelope<T> {
  /** Version marker so legacy plain-value entries are still readable. */
  $: 1;
  v: T;
  /** Epoch ms the value was written. */
  c: number;
  /** Epoch ms at which the value is considered expired. */
  e: number;
}

/**
 * Tunables for `getOrSet`'s stale and backoff behavior. All windows are
 * explicit so stale data is never served outside a caller-declared limit.
 */
export interface GetOrSetOptions {
  /**
   * Seconds past the TTL an expired value may still be served while a
   * background refresh runs. Defaults to the TTL itself.
   */
  staleWhileRevalidateSeconds?: number;
  /**
   * Seconds past the TTL an expired value may be served when the source fetch
   * fails. Defaults to `staleWhileRevalidateSeconds`.
   */
  staleIfErrorSeconds?: number;
  /**
   * Maximum random jitter (seconds) added to the TTL on write, to
   * desynchronize hot-key expiries. Defaults to 10% of `ttlSeconds` (min 1s);
   * pass 0 to disable.
   */
  jitterSeconds?: number;
  /**
   * How long a failed source fetch is remembered so callers do not hammer the
   * source again inside the window (bounded retry backoff). Defaults to 5s.
   */
  failureTtlSeconds?: number;
}

/**
 * Caching service combining a Redis-backed cache with an in-memory LRU
 * fallback for hot data.
 */
export class CacheService {
  private readonly prisma: PrismaClient;
  private readonly logger: Logger;
  private redis: Redis | null = null;
  private isOnline = false;

  private readonly pendingMap = new Map<string, CacheEntry<PendingEvent>>();
  private readonly assetMap = new Map<string, CacheEntry<AssetMetadata>>();
  private readonly configMap = new Map<string, CacheEntry<ProtocolConfigRecord>>();
  private readonly maxEntries: number;
  private readonly metrics: CacheMetricsSink;

  /** Per-key in-flight source fetch, so concurrent misses coalesce onto one call. */
  private readonly inFlight = new Map<string, Promise<unknown>>();
  /** Remembered source failures, bounding how fast a broken source is re-polled. */
  private readonly lastFailures = new Map<string, { at: number; error: unknown }>();

  /**
   * @param prisma - Prisma client for database fallback access
   * @param logger - Logger used for non-fatal Redis warnings
   * @param redisUrl - Redis connection string; caching degrades gracefully when omitted
   * @param maxEntries - Maximum number of entries per in-memory cache map before eviction
   * @param metrics - Optional sink for hit/coalesced/stale/failure metrics
   */
  constructor(
    prisma: PrismaClient,
    logger: Logger,
    redisUrl?: string | null,
    maxEntries = 500,
    metrics: CacheMetricsSink = NULL_METRICS
  ) {
    this.prisma = prisma;
    this.logger = logger;
    this.maxEntries = maxEntries;
    this.metrics = metrics;

    if (redisUrl) {
      this.redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 1 });
      this.redis.on("connect", () => {
        this.isOnline = true;
      });
      this.redis.on("error", (err: Error) => {
        this.isOnline = false;
        this.logger.warn({ err }, "Redis connection error");
      });
    }
  }

  // --- helpers ---

  private touch<K, V>(map: Map<K, CacheEntry<V>>, key: K, value: V): void {
    const now = new Date();
    map.set(key, { value, accessedAt: now });
    this.evictIfNeeded(map);
  }

  private evictIfNeeded<K, V>(map: Map<K, CacheEntry<V>>): void {
    if (map.size <= this.maxEntries) return;
    let oldestKey: K | undefined;
    let oldest = new Date(map.size ? Infinity : 0);
    for (const [k, entry] of map.entries()) {
      if (entry.accessedAt < oldest) {
        oldest = entry.accessedAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) map.delete(oldestKey);
  }

  // --- indexer checkpoint ---

  async getCheckpoint(): Promise<Partial<IndexerCheckpoint> | null> {
    if (this.redis && this.isOnline) {
      try {
        const data = await this.redis.get("indexer:checkpoint");
        if (data) {
          const parsed = JSON.parse(data);
          return {
            id: "singleton",
            latestLedger: parsed.latestLedger,
            lastProcessedEventId: parsed.lastProcessedEventId ?? null,
            lastSyncTime: new Date(parsed.lastSyncTime),
            lastSuccessSyncTime: new Date(parsed.lastSuccessSyncTime),
            lastError: parsed.lastError
          };
        }
      } catch (err) {
        this.logger.warn({ err }, "Redis getCheckpoint failed, falling back to database");
      }
    }
    // Fallback to PostgreSQL
    return this.prisma.indexerCheckpoint.findUnique({ where: { id: "singleton" } });
  }

  async setCheckpoint(checkpoint: {
    latestLedger: number;
    lastProcessedEventId: string | null;
    lastSyncTime: Date;
    lastSuccessSyncTime: Date;
    lastError: string | null;
  }): Promise<void> {
    if (this.redis && this.isOnline) {
      try {
        await this.redis.set(
          "indexer:checkpoint",
          JSON.stringify({
            latestLedger: checkpoint.latestLedger,
            lastProcessedEventId: checkpoint.lastProcessedEventId,
            lastSyncTime: checkpoint.lastSyncTime.toISOString(),
            lastSuccessSyncTime: checkpoint.lastSuccessSyncTime.toISOString(),
            lastError: checkpoint.lastError
          })
        );
        await this.redis.set("indexer:checkpoint:dirty", "true");
        return;
      } catch (err) {
        this.logger.warn({ err }, "Redis setCheckpoint failed, writing directly to database");
      }
    }

    // Fallback direct DB write
    await this.prisma.indexerCheckpoint.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        latestLedger: checkpoint.latestLedger,
        lastProcessedEventId: checkpoint.lastProcessedEventId,
        lastSyncTime: checkpoint.lastSyncTime,
        lastError: checkpoint.lastError,
        lastSuccessSyncTime: checkpoint.lastSuccessSyncTime
      },
      update: {
        latestLedger: checkpoint.latestLedger,
        lastProcessedEventId: checkpoint.lastProcessedEventId,
        lastSyncTime: checkpoint.lastSyncTime,
        lastError: checkpoint.lastError,
        lastSuccessSyncTime: checkpoint.lastSuccessSyncTime
      }
    });
  }

  async syncCheckpointToDb(): Promise<void> {
    if (!this.redis || !this.isOnline) return;
    try {
      const isDirty = await this.redis.get("indexer:checkpoint:dirty");
      if (isDirty !== "true") return;

      const data = await this.redis.get("indexer:checkpoint");
      if (!data) return;

      const parsed = JSON.parse(data);
      await this.prisma.indexerCheckpoint.upsert({
        where: { id: "singleton" },
        create: {
          id: "singleton",
          latestLedger: parsed.latestLedger,
          lastProcessedEventId: parsed.lastProcessedEventId ?? null,
          lastSyncTime: new Date(parsed.lastSyncTime),
          lastError: parsed.lastError,
          lastSuccessSyncTime: new Date(parsed.lastSuccessSyncTime)
        },
        update: {
          latestLedger: parsed.latestLedger,
          lastProcessedEventId: parsed.lastProcessedEventId ?? null,
          lastSyncTime: new Date(parsed.lastSyncTime),
          lastError: parsed.lastError,
          lastSuccessSyncTime: new Date(parsed.lastSuccessSyncTime)
        }
      });
      await this.redis.del("indexer:checkpoint:dirty");
      this.logger.info("Synced indexer checkpoint from Redis to PostgreSQL");
    } catch (err) {
      this.logger.error({ err }, "Failed to sync checkpoint from Redis to PostgreSQL");
    }
  }

  // --- pending events ---

  private pendingEventCacheKey(txHash: string): string {
    return `pending-event:${txHash}`;
  }

  /**
   * Retrieves a pending event by transaction hash. Reads through Redis when
   * online, falling back to the in-memory map.
   *
   * @param txHash - On-chain transaction hash
   * @returns Pending event or null if absent
   */
  async getPendingEvent(txHash: string): Promise<PendingEvent | null> {
    if (this.redis && this.isOnline) {
      try {
        const data = await this.redis.get(this.pendingEventCacheKey(txHash));
        if (data) return JSON.parse(data) as PendingEvent;
      } catch (err) {
        this.logger.warn({ err, txHash }, "Redis getPendingEvent failed, falling back to memory");
      }
    }
    const entry = this.pendingMap.get(txHash);
    if (!entry) return null;
    entry.accessedAt = new Date();
    return entry.value;
  }

  /**
   * Writes a pending event through to the database and the cache. Once an
   * event is consumed (`consumedAt` set), it is evicted from the cache
   * instead of being kept around.
   *
   * @param event - Pending event payload
   */
  async setPendingEvent(event: PendingEvent): Promise<void> {
    await this.prisma.pendingEvent.upsert({
      where: { txHash: event.txHash },
      create: {
        txHash: event.txHash,
        sorobanEventId: event.sorobanEventId,
        eventPayload: event.eventPayload as object,
        statusHint: event.statusHint,
        receivedAt: event.receivedAt,
        consumedAt: event.consumedAt ?? null
      },
      update: {
        sorobanEventId: event.sorobanEventId,
        eventPayload: event.eventPayload as object,
        statusHint: event.statusHint,
        consumedAt: event.consumedAt ?? null
      }
    });

    if (event.consumedAt) {
      await this.deletePendingEvent(event.txHash);
      return;
    }

    this.touch(this.pendingMap, event.txHash, event);
    if (this.redis && this.isOnline) {
      try {
        await this.redis.set(this.pendingEventCacheKey(event.txHash), JSON.stringify(event));
      } catch (err) {
        this.logger.warn({ err, txHash: event.txHash }, "Redis setPendingEvent failed, cached in memory only");
      }
    }
  }

  /**
   * Removes a pending event from cache after reconciliation.
   *
   * @param txHash - Transaction hash to remove
   */
  async deletePendingEvent(txHash: string): Promise<void> {
    this.pendingMap.delete(txHash);
    if (this.redis && this.isOnline) {
      try {
        await this.redis.del(this.pendingEventCacheKey(txHash));
      } catch (err) {
        this.logger.warn({ err, txHash }, "Redis deletePendingEvent failed");
      }
    }
  }

  // --- asset metadata ---

  /**
   * Retrieves cached asset metadata by asset code.
   *
   * @param asset - Asset code or `native` for XLM
   * @returns Cached metadata or null
   */
  async getAssetMetadata(asset: string): Promise<AssetMetadata | null> {
    const entry = this.assetMap.get(asset);
    if (!entry) return null;
    entry.accessedAt = new Date();
    return entry.value;
  }

  /**
   * Caches asset metadata.
   *
   * @param metadata - Asset metadata record
   */
  async setAssetMetadata(metadata: AssetMetadata): Promise<void> {
    this.touch(this.assetMap, metadata.asset, metadata);
  }

  // --- generic Redis-backed cache ---

  /**
   * Returns the cached value for `key`, or invokes `fetch` on a miss and
   * caches the result for `ttlSeconds`.
   *
   * Protection against cache-miss stampedes (issue #111):
   *
   * - **Single-flight (per-process)**: concurrent misses for the same key
   *   coalesce onto one in-flight source fetch, so a hot-key expiry or Redis
   *   outage fans out at most one fetch per key per process.
   * - **Stale-while-revalidate**: an entry expired within
   *   `staleWhileRevalidateSeconds` is served immediately while a background
   *   refresh runs.
   * - **Stale-if-error**: when the source fetch fails, an entry expired within
   *   `staleIfErrorSeconds` is served instead of erroring.
   * - **TTL jitter**: `jitterSeconds` is added to the TTL on write so keys
   *   written together do not all expire together.
   * - **Bounded failure backoff**: a failed fetch is remembered for
   *   `failureTtlSeconds`; callers inside that window are rejected with the
   *   remembered error instead of re-polling a broken source.
   *
   * Distributed (cross-process) fill coordination is out of scope; the
   * coalescing here is per-process.
   *
   * @param key - Cache key
   * @param ttlSeconds - Freshness TTL in seconds
   * @param fetch - Source fetch invoked on a miss
   * @param options - Stale/backoff/jitter tuning; defaults are documented on
   *   `GetOrSetOptions`
   */
  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    fetch: () => Promise<T>,
    options: GetOrSetOptions = {}
  ): Promise<T> {
    const opts = this.normalizeOptions(ttlSeconds, options);
    const now = Date.now();

    // 1. Try a cached read (fresh or expired) from Redis.
    let cached: StoredEnvelope<T> | null = null;
    if (this.redis && this.isOnline) {
      try {
        const raw = await this.redis.get(key);
        if (raw !== null) {
          const parsed = this.parseCached<T>(raw);
          if (parsed) {
            if (parsed.envelope) {
              if (now < parsed.envelope.e) {
                this.metrics.onHit(key);
                return parsed.envelope.v;
              }
              cached = parsed.envelope;
            } else {
              // Legacy plain-value entry: no envelope metadata, so it is
              // bounded by Redis's own TTL and always counts as fresh here.
              this.metrics.onHit(key);
              return parsed.value;
            }
          }
        }
      } catch (err: unknown) {
        this.logger.warn({ err, key }, "Redis get failed — falling through to source");
      }
    }

    // 2. Stale-while-revalidate: serve the expired value now, refresh in the
    //    background. Never runs a second fetch while one is already in flight.
    if (cached && now < cached.e + opts.staleWhileRevalidateSeconds * 1000) {
      this.metrics.onStale(key);
      this.triggerBackgroundRefresh(key, ttlSeconds, fetch, opts);
      return cached.v;
    }

    // 3. Coalesce onto an in-flight fetch for the same key.
    const inflight = this.inFlight.get(key);
    if (inflight) {
      this.metrics.onCoalesced(key);
      return (await inflight) as T;
    }

    // 4. Bounded failure backoff: do not re-poll a source that just failed.
    //    If the expired entry is still inside the stale-if-error window it can
    //    be served without any fetch at all.
    const lastFailure = this.lastFailures.get(key);
    if (lastFailure && now < lastFailure.at + opts.failureTtlSeconds * 1000) {
      if (cached && now < cached.e + opts.staleIfErrorSeconds * 1000) {
        this.metrics.onStale(key);
        return cached.v;
      }
      this.metrics.onSourceFailure(key, lastFailure.error);
      throw lastFailure.error;
    }

    // 5. Real miss: own the source fetch and share it with any waiters.
    this.metrics.onMiss(key);
    const promise = this.fetchAndCache(key, ttlSeconds, fetch, opts, cached);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key) === promise) {
        this.inFlight.delete(key);
      }
    }
  }

  private normalizeOptions(ttlSeconds: number, options: GetOrSetOptions): Required<GetOrSetOptions> {
    const staleWhileRevalidateSeconds = options.staleWhileRevalidateSeconds ?? ttlSeconds;
    return {
      staleWhileRevalidateSeconds,
      staleIfErrorSeconds: options.staleIfErrorSeconds ?? staleWhileRevalidateSeconds,
      jitterSeconds: options.jitterSeconds ?? Math.max(1, Math.round(ttlSeconds * 0.1)),
      failureTtlSeconds: options.failureTtlSeconds ?? 5
    };
  }

  private parseCached<T>(raw: string): { value: T; envelope: StoredEnvelope<T> | null } | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>)["$"] === 1 &&
        "v" in (parsed as Record<string, unknown>) &&
        typeof (parsed as Record<string, unknown>)["e"] === "number"
      ) {
        return { value: (parsed as StoredEnvelope<T>).v, envelope: parsed as StoredEnvelope<T> };
      }
      return { value: parsed as T, envelope: null };
    } catch {
      // Unparseable payload: treat as a miss and refetch from the source.
      return null;
    }
  }

  private isInBackoff(key: string, opts: Required<GetOrSetOptions>): boolean {
    const failure = this.lastFailures.get(key);
    if (!failure) return false;
    if (Date.now() < failure.at + opts.failureTtlSeconds * 1000) return true;
    this.lastFailures.delete(key);
    return false;
  }

  private recordFailure(key: string, error: unknown): void {
    if (!this.lastFailures.has(key) && this.lastFailures.size >= this.maxEntries) {
      // Bound memory: evict the oldest remembered failure.
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [k, f] of this.lastFailures) {
        if (f.at < oldest) {
          oldest = f.at;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) this.lastFailures.delete(oldestKey);
    }
    this.lastFailures.set(key, { at: Date.now(), error });
  }

  /**
   * Kicks off a background revalidation for a stale-served key. Skips when a
   * refresh is already in flight or the source is inside the failure backoff
   * window, so a broken source is not hammered by revalidation either.
   */
  private triggerBackgroundRefresh<T>(
    key: string,
    ttlSeconds: number,
    fetch: () => Promise<T>,
    opts: Required<GetOrSetOptions>
  ): void {
    if (this.inFlight.has(key) || this.isInBackoff(key, opts)) return;
    this.metrics.onMiss(key);
    const promise = this.fetchAndCache(key, ttlSeconds, fetch, opts);
    this.inFlight.set(key, promise);
    promise
      .catch((err: unknown) => {
        this.logger.warn({ err, key }, "Background revalidation failed; stale value remains served");
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });
  }

  /**
   * Runs the source fetch, then writes the result to Redis with a jittered
   * TTL. On failure, records the failure for backoff purposes and either
   * serves the expired entry (stale-if-error) or rethrows.
   */
  private async fetchAndCache<T>(
    key: string,
    ttlSeconds: number,
    fetch: () => Promise<T>,
    opts: Required<GetOrSetOptions>,
    staleFallback: StoredEnvelope<T> | null = null
  ): Promise<T> {
    let value: T;
    try {
      value = await fetch();
    } catch (err: unknown) {
      this.recordFailure(key, err);
      this.metrics.onSourceFailure(key, err);
      if (staleFallback && Date.now() < staleFallback.e + opts.staleIfErrorSeconds * 1000) {
        this.metrics.onStale(key);
        return staleFallback.v;
      }
      throw err;
    }

    this.lastFailures.delete(key);
    if (this.redis && this.isOnline) {
      try {
        const now = Date.now();
        const jitteredTtlSeconds = ttlSeconds + Math.random() * opts.jitterSeconds;
        const expiresAtMs = now + Math.floor(jitteredTtlSeconds * 1000);
        const staleHorizonSeconds = Math.max(
          opts.staleWhileRevalidateSeconds,
          opts.staleIfErrorSeconds
        );
        const envelope: StoredEnvelope<T> = { $: 1, v: value, c: now, e: expiresAtMs };
        await this.redis.set(
          key,
          JSON.stringify(envelope),
          "EX",
          Math.ceil(jitteredTtlSeconds + staleHorizonSeconds)
        );
      } catch (err: unknown) {
        this.logger.warn({ err, key }, "Redis set failed — response served uncached");
      }
    }
    return value;
  }

  /**
   * Evicts a single key from the Redis-backed cache and cancels any pending
   * single-flight or backoff state for it. No-op when Redis is offline; never
   * throws.
   */
  async invalidate(key: string): Promise<void> {
    this.inFlight.delete(key);
    this.lastFailures.delete(key);
    if (this.redis && this.isOnline) {
      try {
        await this.redis.del(key);
      } catch (err: unknown) {
        this.logger.warn({ err, key }, "Redis invalidate failed");
      }
    }
  }

  // --- protocol config ---

  /**
   * Reads a cached protocol config value by key.
   *
   * @param key - Config key
   * @returns Cached config record or null
   */
  async getProtocolConfig(key: string): Promise<ProtocolConfigRecord | null> {
    const entry = this.configMap.get(key);
    if (!entry) return null;
    entry.accessedAt = new Date();
    return entry.value;
  }

  /**
   * Writes a protocol config record to cache.
   *
   * @param record - Config record
   */
  async setProtocolConfig(record: ProtocolConfigRecord): Promise<void> {
    this.touch(this.configMap, record.key, record);
  }

  /**
   * Invalidates protocol config by key when underlying config changes.
   *
   * @param key - Config key to evict
   */
  async invalidateProtocolConfig(key: string): Promise<void> {
    this.configMap.delete(key);
  }

  /**
   * Resets all in-memory caches (context: config refresh/restart). Does not
   * touch Redis-backed state.
   */
  async reset(): Promise<void> {
    this.pendingMap.clear();
    this.assetMap.clear();
    this.configMap.clear();
  }

  /**
   * Lightweight connectivity probe for readiness checks. Sends a single
   * Redis `PING` and reports round-trip latency; does not rely on the
   * `isOnline` flag from the connect/error event listeners, since a live
   * round trip is the authoritative signal and that flag can lag the
   * connection's real state.
   *
   * When no `redisUrl` was configured this resolves immediately with
   * `configured: false` — that is a deliberate deployment mode (this class
   * already degrades to PostgreSQL / in-memory fallbacks without Redis),
   * not a failure, so callers should not treat it as unhealthy.
   */
  async ping(): Promise<{ configured: boolean; healthy: boolean; latencyMs: number; error?: string }> {
    if (!this.redis) {
      return { configured: false, healthy: true, latencyMs: 0 };
    }
    const start = Date.now();
    try {
      await this.redis.ping();
      return { configured: true, healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        configured: true,
        healthy: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * Closes the Redis connection (if any) and clears in-memory caches.
   */
  async disconnect(): Promise<void> {
    await this.reset();
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // best-effort close
      }
    }
  }
}
