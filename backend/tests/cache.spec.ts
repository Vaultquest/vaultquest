import { describe, it, expect, vi, beforeEach } from "vitest";
import { CacheService } from "../src/services/cacheService.js";

// Mock ioredis
const mockRedisInstance = {
  on: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  ping: vi.fn(),
  quit: vi.fn()
};

vi.mock("ioredis", () => {
  return {
    Redis: vi.fn().mockImplementation(() => mockRedisInstance)
  };
});

describe("CacheService Fallback & Caching Logic Tests", () => {
  let mockPrisma: any;
  let mockLogger: any;

  beforeEach(() => {
    mockPrisma = {
      indexerCheckpoint: {
        findUnique: vi.fn(),
        upsert: vi.fn()
      },
      pendingEvent: {
        findUnique: vi.fn(),
        upsert: vi.fn()
      }
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    vi.clearAllMocks();
  });

  it("falls back to PostgreSQL when Redis is offline", async () => {
    // Instantiate CacheService
    const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
    
    // Simulate offline state: isOnline is set to false because connection failed (we can trigger error callback)
    const errorCallback = mockRedisInstance.on.mock.calls.find(c => c[0] === "error")?.[1];
    if (errorCallback) {
      errorCallback(new Error("Connection refused"));
    }

    mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
      id: "singleton",
      latestLedger: 9999
    });

    const checkpoint = await service.getCheckpoint();
    
    // Redis get should NOT be called (or if it fails/offline, fallback happens)
    expect(checkpoint?.latestLedger).toBe(9999);
    expect(mockPrisma.indexerCheckpoint.findUnique).toHaveBeenCalledTimes(1);
  });

  it("uses Redis cache when online", async () => {
    const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
    
    // Simulate online state
    const connectCallback = mockRedisInstance.on.mock.calls.find(c => c[0] === "connect")?.[1];
    if (connectCallback) {
      connectCallback();
    }

    // Set mock data in Redis
    mockRedisInstance.get.mockImplementation(async (key: string) => {
      if (key === "indexer:checkpoint") {
        return JSON.stringify({
          latestLedger: 54321,
          lastSyncTime: new Date().toISOString(),
          lastSuccessSyncTime: new Date().toISOString(),
          lastError: null
        });
      }
      return null;
    });

    const checkpoint = await service.getCheckpoint();

    expect(checkpoint?.latestLedger).toBe(54321);
    // Database query is offloaded! Prisma findUnique should NOT be called.
    expect(mockPrisma.indexerCheckpoint.findUnique).not.toHaveBeenCalled();
  });

  it("caches pending events and handles write-through/invalidation", async () => {
    const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
    
    // Simulate online state
    const connectCallback = mockRedisInstance.on.mock.calls.find(c => c[0] === "connect")?.[1];
    if (connectCallback) {
      connectCallback();
    }

    const txHash = "0xabc123";
    const pendingEvent: Parameters<CacheService["setPendingEvent"]>[0] = {
      txHash,
      sorobanEventId: "evt_1",
      eventPayload: { amount: 50 },
      statusHint: "confirmed",
      receivedAt: new Date(),
      consumedAt: null
    };

    // setPendingEvent writes-through to both database and cache
    await service.setPendingEvent(pendingEvent);

    expect(mockPrisma.pendingEvent.upsert).toHaveBeenCalledTimes(1);
    expect(mockRedisInstance.set).toHaveBeenCalledTimes(1); // caches active event

    // Simulate event being consumed (consumedAt is set)
    pendingEvent.consumedAt = new Date();
    await service.setPendingEvent(pendingEvent);

    // Deletes from cache because it is consumed
    expect(mockRedisInstance.del).toHaveBeenCalled();
  });

  describe("getOrSet wallet-scoped cache keys", () => {
    it("keeps cache entries isolated per wallet-scoped key", async () => {
      const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
      const connectCallback = mockRedisInstance.on.mock.calls.find((c) => c[0] === "connect")?.[1];
      if (connectCallback) connectCallback();

      const store = new Map<string, string>();
      mockRedisInstance.get.mockImplementation(async (key: string) => store.get(key) ?? null);
      mockRedisInstance.set.mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      });
      mockRedisInstance.del.mockImplementation(async (key: string) => {
        const existed = store.has(key);
        store.delete(key);
        return existed ? 1 : 0;
      });

      const fetchA = vi.fn().mockResolvedValue({ pools: ["a-1"] });
      const fetchB = vi.fn().mockResolvedValue({ pools: ["b-1"] });

      const resultA = await service.getOrSet("saved-pools:walletA", 60, fetchA);
      const resultB = await service.getOrSet("saved-pools:walletB", 60, fetchB);

      expect(resultA).toEqual({ pools: ["a-1"] });
      expect(resultB).toEqual({ pools: ["b-1"] });
      expect(fetchA).toHaveBeenCalledTimes(1);
      expect(fetchB).toHaveBeenCalledTimes(1);

      // Evicting wallet A's key must not affect wallet B's cached entry.
      await service.invalidate("saved-pools:walletA");
      expect(store.has("saved-pools:walletA")).toBe(false);
      expect(store.has("saved-pools:walletB")).toBe(true);

      const refetchB = await service.getOrSet("saved-pools:walletB", 60, fetchB);
      expect(refetchB).toEqual({ pools: ["b-1"] });
      expect(fetchB).toHaveBeenCalledTimes(1); // still cached, no re-fetch
    });
  });

  describe("pending event eviction", () => {
    it("removes only the consumed event from cache, leaving other pending events intact", async () => {
      const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
      const connectCallback = mockRedisInstance.on.mock.calls.find((c) => c[0] === "connect")?.[1];
      if (connectCallback) connectCallback();

      const store = new Map<string, string>();
      mockRedisInstance.set.mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      });
      mockRedisInstance.del.mockImplementation(async (key: string) => {
        const existed = store.has(key);
        store.delete(key);
        return existed ? 1 : 0;
      });
      mockRedisInstance.get.mockImplementation(async (key: string) => store.get(key) ?? null);

      const eventA: Parameters<CacheService["setPendingEvent"]>[0] = {
        txHash: "0xaaa",
        sorobanEventId: "evt_a",
        eventPayload: { amount: 10 },
        statusHint: "confirmed",
        receivedAt: new Date(),
        consumedAt: null
      };
      const eventB: Parameters<CacheService["setPendingEvent"]>[0] = {
        txHash: "0xbbb",
        sorobanEventId: "evt_b",
        eventPayload: { amount: 20 },
        statusHint: "confirmed",
        receivedAt: new Date(),
        consumedAt: null
      };

      await service.setPendingEvent(eventA);
      await service.setPendingEvent(eventB);
      expect(store.has("pending-event:0xaaa")).toBe(true);
      expect(store.has("pending-event:0xbbb")).toBe(true);

      await service.setPendingEvent({ ...eventA, consumedAt: new Date() });

      expect(store.has("pending-event:0xaaa")).toBe(false);
      expect(store.has("pending-event:0xbbb")).toBe(true);

      const remaining = await service.getPendingEvent("0xbbb");
      expect(remaining?.txHash).toBe("0xbbb");
    });
  });
});
