import { describe, it, expect, vi } from 'vitest';
import { CacheService } from './cacheService.js';
import { RecordingCacheMetrics, type CacheMetricsSink } from './cache/metrics.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeMockPrisma() {
  return {
    indexerCheckpoint: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    pendingEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  } as any;
}

// A minimal in-memory Redis stand-in that tracks key→value pairs and TTLs.
// `set` honours a trailing `NX` flag (as `SET key val PX ttl NX` does): it
// returns 'OK' and writes only when the key is absent, null otherwise.
function makeMockRedis(online: boolean = true) {
  const store = new Map<string, string>();
  return {
    _store: store,
    _online: online,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._rest: unknown[]) => {
      const nx = _rest.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    ping: vi.fn(async () => 'PONG'),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    quit: vi.fn(async () => 'OK'),
    on: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Patch CacheService so we can inject a fake Redis without a real URL.
// We reach into the private fields directly for test isolation.
// ---------------------------------------------------------------------------

function buildService(
  redis: ReturnType<typeof makeMockRedis> | null,
  isOnline = true,
  metrics: CacheMetricsSink = new RecordingCacheMetrics()
): CacheService {
  const svc = new CacheService(makeMockPrisma(), makeMockLogger(), 'redis://fake:0');
  // Override the private fields that the constructor tries to create.
  (svc as any).redis = redis;
  (svc as any).isOnline = isOnline;
  (svc as any).metrics = metrics;
  return svc;
}

/**
 * Seeds Redis with an already-expired envelope so staleness tests do not have
 * to wait out a TTL.
 */
function seedExpiredEnvelope(
  redis: ReturnType<typeof makeMockRedis>,
  key: string,
  value: unknown,
  ttlSeconds: number,
  expiredAgoSeconds: number
): void {
  const now = Date.now();
  const e = now - expiredAgoSeconds * 1000;
  const c = e - ttlSeconds * 1000;
  redis._store.set(key, JSON.stringify({ $: 1, v: value, c, e }));
}

// ---------------------------------------------------------------------------
// Tests: getOrSet
// ---------------------------------------------------------------------------

describe('CacheService.getOrSet', () => {
  it('returns the cached value on the second call without invoking fetch again', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    const fetch = vi.fn().mockResolvedValue({ balance: 42 });

    // First call — cache miss, fetch is called.
    const first = await svc.getOrSet('wallet:abc:balance', 60, fetch);
    expect(first).toEqual({ balance: 42 });
    expect(fetch).toHaveBeenCalledTimes(1);

    // Second call — cache hit, fetch must NOT be called again.
    const second = await svc.getOrSet('wallet:abc:balance', 60, fetch);
    expect(second).toEqual({ balance: 42 });
    expect(fetch).toHaveBeenCalledTimes(1); // still 1

    // Redis.get should have been called twice; Redis.set only once.
    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('calls fetch on cache miss and stores the result as an envelope', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    const fetch = vi.fn().mockResolvedValue([1, 2, 3]);
    const result = await svc.getOrSet('some:key', 120, fetch);

    expect(result).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledOnce();
    const stored = JSON.parse(redis._store.get('some:key') as string) as {
      $: number;
      v: number[];
      c: number;
      e: number;
    };
    expect(stored.$).toBe(1);
    expect(stored.v).toEqual([1, 2, 3]);
    // Redis TTL covers the freshness TTL plus the default stale horizon.
    expect(redis.set).toHaveBeenCalledWith('some:key', expect.any(String), 'EX', expect.any(Number));
  });

  it('still returns the fetch result when Redis is offline (graceful degradation)', async () => {
    const svc = buildService(null, false); // no Redis
    const fetch = vi.fn().mockResolvedValue('fallback-value');

    const result = await svc.getOrSet('any:key', 30, fetch);
    expect(result).toBe('fallback-value');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('falls through to fetch when Redis.get throws, and logs a warning', async () => {
    const redis = makeMockRedis();
    redis.get.mockRejectedValueOnce(new Error('ECONNRESET'));

    const svc = buildService(redis);
    const logger = (svc as any).logger;
    const fetch = vi.fn().mockResolvedValue('fresh-data');

    const result = await svc.getOrSet('err:key', 60, fetch);
    expect(result).toBe('fresh-data');
    expect(fetch).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'err:key' }),
      expect.stringContaining('Redis get failed')
    );
  });

  it('serves the value when Redis.set throws, and logs a warning', async () => {
    const redis = makeMockRedis();
    redis.set.mockRejectedValueOnce(new Error('OOM'));

    const svc = buildService(redis);
    const logger = (svc as any).logger;
    const fetch = vi.fn().mockResolvedValue({ data: 'ok' });

    const result = await svc.getOrSet('set:fail:key', 60, fetch);
    expect(result).toEqual({ data: 'ok' }); // value still returned
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'set:fail:key' }),
      expect.stringContaining('Redis set failed')
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: single-flight coalescing (#111)
// ---------------------------------------------------------------------------

describe('CacheService.getOrSet single-flight', () => {
  it('serves concurrent misses with a single source fetch', async () => {
    const redis = makeMockRedis();
    const metrics = new RecordingCacheMetrics();
    const svc = buildService(redis, true, metrics);

    let resolveFetch: (value: { balance: number }) => void = () => {};
    const fetch = vi
      .fn()
      .mockImplementation(
        () => new Promise<{ balance: number }>((resolve) => {
          resolveFetch = resolve;
        })
      );

    const p1 = svc.getOrSet('hot:key', 60, fetch);
    const p2 = svc.getOrSet('hot:key', 60, fetch);
    const p3 = svc.getOrSet('hot:key', 60, fetch);

    // Give every request a chance to reach the single-flight gate.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(1);
    resolveFetch({ balance: 42 });

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual([{ balance: 42 }, { balance: 42 }, { balance: 42 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(metrics.misses).toEqual(['hot:key']);
    expect(metrics.coalesced.sort()).toEqual(['hot:key', 'hot:key']);
  });

  it('coalesces concurrent requests onto one fetch when Redis is offline', async () => {
    const metrics = new RecordingCacheMetrics();
    const svc = buildService(null, false, metrics);
    const fetch = vi.fn().mockResolvedValue('fallback');

    const results = await Promise.all([
      svc.getOrSet('k', 30, fetch),
      svc.getOrSet('k', 30, fetch),
      svc.getOrSet('k', 30, fetch),
    ]);

    expect(results).toEqual(['fallback', 'fallback', 'fallback']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(metrics.misses).toEqual(['k']);
    expect(metrics.coalesced).toHaveLength(2);
  });

  it('records fresh hits against the hit metric', async () => {
    const redis = makeMockRedis();
    const metrics = new RecordingCacheMetrics();
    const svc = buildService(redis, true, metrics);

    const fetch = vi.fn().mockResolvedValue('v');
    await svc.getOrSet('hit:key', 60, fetch);
    await svc.getOrSet('hit:key', 60, fetch);

    expect(metrics.misses).toEqual(['hit:key']);
    expect(metrics.hits).toEqual(['hit:key']);
    expect(metrics.coalesced).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: bounded failure backoff (#111)
// ---------------------------------------------------------------------------

describe('CacheService.getOrSet failure backoff', () => {
  it('does not re-poll a failed source inside the backoff window', async () => {
    vi.useFakeTimers();
    try {
      const redis = makeMockRedis();
      const metrics = new RecordingCacheMetrics();
      const svc = buildService(redis, true, metrics);
      const boom = new Error('upstream down');
      const fetch = vi.fn().mockRejectedValue(boom);

      await expect(
        svc.getOrSet('flaky:key', 60, fetch, { failureTtlSeconds: 30 })
      ).rejects.toThrow('upstream down');
      expect(fetch).toHaveBeenCalledTimes(1);

      // Inside the window: remembered error, no source call at all.
      await expect(
        svc.getOrSet('flaky:key', 60, fetch, { failureTtlSeconds: 30 })
      ).rejects.toThrow('upstream down');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(metrics.failures).toHaveLength(2);

      // Past the window the source is polled again (and fails again).
      vi.advanceTimersByTime(31_000);
      await expect(
        svc.getOrSet('flaky:key', 60, fetch, { failureTtlSeconds: 30 })
      ).rejects.toThrow('upstream down');
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves stale instead of erroring when the source is inside the backoff window', async () => {
    vi.useFakeTimers();
    try {
      const redis = makeMockRedis();
      const metrics = new RecordingCacheMetrics();
      const svc = buildService(redis, true, metrics);
      seedExpiredEnvelope(redis, 'bounce:key', 'stale', 60, 40);

      const boom = new Error('down');
      const fetch = vi.fn().mockRejectedValue(boom);
      const opts = {
        staleWhileRevalidateSeconds: 30,
        staleIfErrorSeconds: 60,
        jitterSeconds: 0,
        failureTtlSeconds: 30,
      };

      // First call: outside the SWR window, so it fetches and fails, then
      // serves the expired value via stale-if-error.
      const first = await svc.getOrSet('bounce:key', 60, fetch, opts);
      expect(first).toBe('stale');
      expect(fetch).toHaveBeenCalledTimes(1);

      // Second call: inside the backoff window — stale is served with no fetch.
      const second = await svc.getOrSet('bounce:key', 60, fetch, opts);
      expect(second).toBe('stale');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(metrics.failures).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: TTL jitter (#111)
// ---------------------------------------------------------------------------

describe('CacheService.getOrSet TTL jitter', () => {
  it('extends the stored expiry by the configured jitter', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      await svc.getOrSet('jitter:key', 100, async () => 'v', {
        jitterSeconds: 10,
        staleWhileRevalidateSeconds: 0,
        staleIfErrorSeconds: 0,
      });

      const stored = JSON.parse(redis._store.get('jitter:key') as string) as {
        $: number;
        v: string;
        c: number;
        e: number;
      };
      expect(stored.$).toBe(1);
      expect(stored.v).toBe('v');
      // 100s TTL + 0.5 * 10s jitter.
      expect(stored.e - stored.c).toBe(105_000);
      // Redis TTL is the jittered TTL plus the stale horizon (0 here).
      expect(redis.set).toHaveBeenCalledWith('jitter:key', expect.any(String), 'EX', 105);
    } finally {
      randomSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: stale boundaries (#111)
// ---------------------------------------------------------------------------

describe('CacheService.getOrSet staleness boundaries', () => {
  it('serves stale within the stale-while-revalidate window and refreshes in the background', async () => {
    vi.useFakeTimers();
    try {
      const redis = makeMockRedis();
      const metrics = new RecordingCacheMetrics();
      const svc = buildService(redis, true, metrics);
      seedExpiredEnvelope(redis, 'stale:key', { v: 'stale' }, 60, 10);

      const fetch = vi.fn().mockResolvedValue({ v: 'fresh' });
      const opts = { staleWhileRevalidateSeconds: 30, staleIfErrorSeconds: 30, jitterSeconds: 0 };

      const result = await svc.getOrSet('stale:key', 60, fetch, opts);
      expect(result).toEqual({ v: 'stale' });
      expect(metrics.stale).toEqual(['stale:key']);
      expect(fetch).toHaveBeenCalledTimes(1); // background refresh kicked off

      // Let the background refresh finish writing the fresh value.
      await vi.advanceTimersByTimeAsync(0);
      const stored = JSON.parse(redis._store.get('stale:key') as string) as { v: unknown };
      expect(stored.v).toEqual({ v: 'fresh' });

      // The next call is a fresh hit again — no second fetch.
      const second = await svc.getOrSet('stale:key', 60, fetch, opts);
      expect(second).toEqual({ v: 'fresh' });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an entry past the stale window as a miss and refetches', async () => {
    vi.useFakeTimers();
    try {
      const redis = makeMockRedis();
      const metrics = new RecordingCacheMetrics();
      const svc = buildService(redis, true, metrics);
      seedExpiredEnvelope(redis, 'old:key', 'ancient', 60, 100);

      const fetch = vi.fn().mockResolvedValue('fresh');
      const result = await svc.getOrSet('old:key', 60, fetch, {
        staleWhileRevalidateSeconds: 30,
        jitterSeconds: 0,
      });

      expect(result).toBe('fresh');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(metrics.stale).toEqual([]);
      expect(metrics.misses).toEqual(['old:key']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves stale-if-error when the source fails inside the stale-if-error window', async () => {
    vi.useFakeTimers();
    try {
      const redis = makeMockRedis();
      const metrics = new RecordingCacheMetrics();
      const svc = buildService(redis, true, metrics);
      // Expired 40s ago: outside the SWR window (30s), inside SFR (60s).
      seedExpiredEnvelope(redis, 'sfr:key', 'stale-but-tolerable', 60, 40);

      const fetch = vi.fn().mockRejectedValue(new Error('source on fire'));
      const opts = { staleWhileRevalidateSeconds: 30, staleIfErrorSeconds: 60, jitterSeconds: 0 };

      const result = await svc.getOrSet('sfr:key', 60, fetch, opts);
      expect(result).toBe('stale-but-tolerable');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(metrics.failures).toHaveLength(1);
      expect(metrics.stale).toEqual(['sfr:key']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates the error when the source fails beyond the stale-if-error window', async () => {
    vi.useFakeTimers();
    try {
      const redis = makeMockRedis();
      const metrics = new RecordingCacheMetrics();
      const svc = buildService(redis, true, metrics);
      seedExpiredEnvelope(redis, 'dead:key', 'too-old', 60, 100);

      const fetch = vi.fn().mockRejectedValue(new Error('source gone'));
      const opts = { staleWhileRevalidateSeconds: 30, staleIfErrorSeconds: 60, jitterSeconds: 0 };

      await expect(svc.getOrSet('dead:key', 60, fetch, opts)).rejects.toThrow('source gone');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(metrics.failures).toHaveLength(1);
      expect(metrics.stale).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: invalidate
// ---------------------------------------------------------------------------

describe('CacheService.invalidate', () => {
  it('removes the key from Redis', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    // Seed a value so we can verify removal.
    await svc.getOrSet('to:remove', 60, async () => 'cached');
    expect(redis._store.has('to:remove')).toBe(true);

    await svc.invalidate('to:remove');
    expect(redis.del).toHaveBeenCalledWith('to:remove');
    expect(redis._store.has('to:remove')).toBe(false);
  });

  it('is a no-op when Redis is offline (does not throw)', async () => {
    const svc = buildService(null, false);
    await expect(svc.invalidate('some:key')).resolves.toBeUndefined();
  });

  it('logs a warning and does not throw when Redis.del fails', async () => {
    const redis = makeMockRedis();
    redis.del.mockRejectedValueOnce(new Error('write error'));

    const svc = buildService(redis);
    const logger = (svc as any).logger;

    await expect(svc.invalidate('bad:key')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'bad:key' }),
      expect.stringContaining('Redis invalidate failed')
    );
  });
});

describe('CacheService.ping', () => {
  it('reports not configured when no Redis URL was provided (no live Redis needed)', async () => {
    const svc = new CacheService(makeMockPrisma(), makeMockLogger());
    const result = await svc.ping();
    expect(result).toEqual({ configured: false, healthy: true, latencyMs: 0 });
  });

  it('reports healthy with round-trip latency when PING succeeds', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    const result = await svc.ping();

    expect(redis.ping).toHaveBeenCalled();
    expect(result.configured).toBe(true);
    expect(result.healthy).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('reports unhealthy with the error message when PING rejects, without throwing', async () => {
    const redis = makeMockRedis();
    redis.ping.mockRejectedValueOnce(new Error('connection reset'));
    const svc = buildService(redis);

    const result = await svc.ping();

    expect(result.configured).toBe(true);
    expect(result.healthy).toBe(false);
    expect(result.error).toBe('connection reset');
  });

  it('attempts a live PING rather than trusting a stale isOnline=false flag', async () => {
    // isOnline can lag the real connection state (it is only updated by
    // connect/error events); ping() must not short-circuit on it.
    const redis = makeMockRedis();
    const svc = buildService(redis, false);

    const result = await svc.ping();

    expect(redis.ping).toHaveBeenCalled();
    expect(result.healthy).toBe(true);
  });
});

describe('CacheService.consumeOnce', () => {
  it('allows the first consumption and rejects a second within the ttl (Redis-backed)', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    await expect(svc.consumeOnce('nonce:a', 60_000)).resolves.toBe(true);
    await expect(svc.consumeOnce('nonce:a', 60_000)).resolves.toBe(false);
    expect(redis.set).toHaveBeenCalledWith('replay:nonce:a', '1', 'PX', 60_000, 'NX');
  });

  it('settles concurrent redemptions of the same key to exactly one success (Redis-backed)', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    const results = await Promise.all([
      svc.consumeOnce('nonce:concurrent', 60_000),
      svc.consumeOnce('nonce:concurrent', 60_000),
      svc.consumeOnce('nonce:concurrent', 60_000)
    ]);

    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(2);
  });

  it('shares consumption across instances backed by the same Redis store', async () => {
    const redis = makeMockRedis();
    // Two separate CacheService instances standing in for two app instances,
    // both backed by the same (mocked) Redis - i.e. cross-instance replay.
    const instanceA = buildService(redis);
    const instanceB = buildService(redis);

    await expect(instanceA.consumeOnce('nonce:cross', 60_000)).resolves.toBe(true);
    await expect(instanceB.consumeOnce('nonce:cross', 60_000)).resolves.toBe(false);
  });

  it('falls back to an in-memory store and still rejects a replay when Redis is offline', async () => {
    const svc = buildService(null, false);

    await expect(svc.consumeOnce('nonce:offline', 60_000)).resolves.toBe(true);
    await expect(svc.consumeOnce('nonce:offline', 60_000)).resolves.toBe(false);
  });

  it('allows reconsumption once the ttl has elapsed (in-memory fallback)', async () => {
    const svc = buildService(null, false);

    await expect(svc.consumeOnce('nonce:expiring', 10)).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(svc.consumeOnce('nonce:expiring', 10)).resolves.toBe(true);
  });

  it('falls back to memory and logs a warning when Redis.set fails', async () => {
    const redis = makeMockRedis();
    redis.set.mockRejectedValueOnce(new Error('write error'));
    const svc = buildService(redis);
    const logger = (svc as any).logger;

    await expect(svc.consumeOnce('nonce:broken', 60_000)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'nonce:broken' }),
      expect.stringContaining('consumeOnce failed')
    );
  });
});
