import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getReadiness } from "../src/services/readinessService.js";
import type { LedgerService } from "../src/services/ledger.js";
import type { CacheService } from "../src/services/cacheService.js";
import { buildApp } from "../src/app.js";

// ---------------------------------------------------------------------------
// Helpers — minimal mocks satisfying only the members getReadiness actually
// calls, cast through `unknown` rather than typed `any` (matches this file's
// stricter typing; other spec files in this repo use bare `as any` mocks —
// see implementation.md for why that convention was left alone elsewhere).
// ---------------------------------------------------------------------------

function healthyPrisma(): PrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    indexerCheckpoint: {
      findUnique: vi.fn().mockResolvedValue({
        id: "singleton",
        latestLedger: 100,
        lastProcessedEventId: "evt-100",
        lastSyncTime: new Date(),
        lastError: null,
        lastSuccessSyncTime: new Date()
      })
    }
  } as unknown as PrismaClient;
}

function healthyLedgerService(): LedgerService {
  return {
    getIndexerHealth: vi.fn().mockResolvedValue({
      status: "healthy",
      latest_ledger: 100,
      sync_lag: 0,
      last_error: null,
      message: "Indexer is healthy and syncing"
    })
  } as unknown as LedgerService;
}

function healthyCacheService(): CacheService {
  return { ping: vi.fn().mockResolvedValue({ configured: true, healthy: true, latencyMs: 3 }) } as unknown as CacheService;
}

const internalSecret = "test-secret-readiness";

describe("getReadiness", () => {
  it("is ready when database, indexer, and cache are all healthy", async () => {
    const result = await getReadiness(healthyPrisma(), healthyLedgerService(), healthyCacheService());

    expect(result.status).toBe("ready");
    expect(result.checks.database.status).toBe("healthy");
    expect(result.checks.indexer.status).toBe("healthy");
    expect(result.checks.cache.status).toBe("healthy");
  });

  it("is ready when cache is not configured (deliberate deployment mode, not a failure)", async () => {
    const result = await getReadiness(healthyPrisma(), healthyLedgerService(), undefined);

    expect(result.status).toBe("ready");
    expect(result.checks.cache).toEqual({ status: "not_configured", latency_ms: 0 });
  });

  describe("database down", () => {
    it("is not_ready when the database query rejects", async () => {
      const prisma = {
        $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused"))
      } as unknown as PrismaClient;

      const result = await getReadiness(prisma, healthyLedgerService(), healthyCacheService());

      expect(result.status).toBe("not_ready");
      expect(result.checks.database.status).toBe("unhealthy");
      expect(result.checks.database.error).toBe("connection refused");
    });
  });

  describe("cache degraded", () => {
    it("stays ready when cache is configured but unreachable — CacheService already falls back to Postgres", async () => {
      const cacheService = {
        ping: vi.fn().mockResolvedValue({ configured: true, healthy: false, latencyMs: 12, error: "ECONNREFUSED" })
      } as unknown as CacheService;

      const result = await getReadiness(healthyPrisma(), healthyLedgerService(), cacheService);

      expect(result.status).toBe("ready");
      expect(result.checks.cache.status).toBe("degraded");
      expect(result.checks.cache.error).toBe("ECONNREFUSED");
    });

    it("stays ready and reports degraded when cache.ping() itself throws", async () => {
      const cacheService = { ping: vi.fn().mockRejectedValue(new Error("socket closed")) } as unknown as CacheService;

      const result = await getReadiness(healthyPrisma(), healthyLedgerService(), cacheService);

      expect(result.status).toBe("ready");
      expect(result.checks.cache.status).toBe("degraded");
      expect(result.checks.cache.error).toBe("socket closed");
    });
  });

  describe("stale indexer", () => {
    it("is not_ready when the indexer has fallen behind the freshness threshold", async () => {
      const ledgerService = {
        getIndexerHealth: vi.fn().mockResolvedValue({
          status: "lagging",
          latest_ledger: 100,
          sync_lag: 72,
          last_error: null,
          message: "Indexer is lagging. Last successful sync was 360s ago"
        })
      } as unknown as LedgerService;

      const result = await getReadiness(healthyPrisma(), ledgerService, healthyCacheService());

      expect(result.status).toBe("not_ready");
      expect(result.checks.indexer.status).toBe("unhealthy");
      expect(result.checks.indexer.sync_lag).toBe(72);
      expect(result.checks.indexer.error).toContain("lagging");
    });

    it("is not_ready when the indexer checkpoint itself is missing or erroring", async () => {
      const ledgerService = {
        getIndexerHealth: vi.fn().mockResolvedValue({
          status: "degraded",
          latest_ledger: 0,
          sync_lag: 0,
          last_error: "Horizon RPC 429 Rate Limit Exceeded",
          message: "Indexer reported error: Horizon RPC 429 Rate Limit Exceeded"
        })
      } as unknown as LedgerService;

      const result = await getReadiness(healthyPrisma(), ledgerService, healthyCacheService());

      expect(result.status).toBe("not_ready");
      expect(result.checks.indexer.status).toBe("unhealthy");
    });
  });

  describe("dependency timeout", () => {
    it("bounds a hung database check to the configured timeout instead of hanging the endpoint", async () => {
      const prisma = {
        $queryRaw: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([{ ok: 1 }]), 2000)))
      } as unknown as PrismaClient;

      const start = Date.now();
      const result = await getReadiness(prisma, healthyLedgerService(), healthyCacheService(), {
        databaseTimeoutMs: 50
      });
      const elapsed = Date.now() - start;

      expect(result.status).toBe("not_ready");
      expect(result.checks.database.status).toBe("unhealthy");
      expect(result.checks.database.error).toContain("timed out after 50ms");
      // Generous upper bound: proves the endpoint did not wait out the full
      // 2000ms hung query, without being a flaky exact-timing assertion.
      expect(elapsed).toBeLessThan(500);
    });

    it("bounds a hung indexer check independently of the database and cache checks", async () => {
      const ledgerService = {
        getIndexerHealth: vi.fn(() => new Promise(() => {})) // never resolves
      } as unknown as LedgerService;

      const result = await getReadiness(healthyPrisma(), ledgerService, healthyCacheService(), {
        indexerTimeoutMs: 50
      });

      expect(result.status).toBe("not_ready");
      expect(result.checks.indexer.status).toBe("unhealthy");
      expect(result.checks.indexer.error).toContain("timed out after 50ms");
    });

    it("bounds a hung cache check and still reports it as degraded, not blocking readiness", async () => {
      const cacheService = { ping: vi.fn(() => new Promise(() => {})) } as unknown as CacheService; // never resolves

      const result = await getReadiness(healthyPrisma(), healthyLedgerService(), cacheService, {
        cacheTimeoutMs: 50
      });

      expect(result.status).toBe("ready");
      expect(result.checks.cache.status).toBe("degraded");
      expect(result.checks.cache.error).toContain("timed out after 50ms");
    });
  });

  describe("healthy recovery", () => {
    it("returns ready again on the next call once a previously-failing database recovers", async () => {
      const prisma = {
        $queryRaw: vi
          .fn()
          .mockRejectedValueOnce(new Error("connection refused"))
          .mockResolvedValueOnce([{ "?column?": 1 }])
      } as unknown as PrismaClient;
      const ledgerService = healthyLedgerService();
      const cacheService = healthyCacheService();

      const first = await getReadiness(prisma, ledgerService, cacheService);
      expect(first.status).toBe("not_ready");

      const second = await getReadiness(prisma, ledgerService, cacheService);
      expect(second.status).toBe("ready");
      expect(second.checks.database.status).toBe("healthy");
    });
  });

  it("runs the three checks concurrently, bounded by the slowest single timeout rather than their sum", async () => {
    const slow = (ms: number) => () => new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
    const prisma = { $queryRaw: vi.fn(slow(80)) } as unknown as PrismaClient;
    const ledgerService = { getIndexerHealth: vi.fn(slow(80)) } as unknown as LedgerService;
    const cacheService = { ping: vi.fn(slow(80)) } as unknown as CacheService;

    const start = Date.now();
    await getReadiness(prisma, ledgerService, cacheService, {
      databaseTimeoutMs: 500,
      indexerTimeoutMs: 500,
      cacheTimeoutMs: 500
    });
    const elapsed = Date.now() - start;

    // Sequential would be ~240ms+; concurrent should land close to the
    // single 80ms delay. Generous ceiling to avoid CI flakiness.
    expect(elapsed).toBeLessThan(200);
  });
});

describe("GET /health/ready (route)", () => {
  it("returns 200 and status ready when all dependencies are healthy", async () => {
    const app = buildApp({ prisma: healthyPrisma(), internalSecret });

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.data.status).toBe("ready");
    expect(payload.data.checks.database.status).toBe("healthy");
    expect(payload.data.checks.indexer.status).toBe("healthy");
    await app.close();
  });

  it("returns 503 and status not_ready when the database is unreachable", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")),
      indexerCheckpoint: { findUnique: vi.fn().mockResolvedValue(null) }
    } as unknown as PrismaClient;
    const app = buildApp({ prisma, internalSecret });

    const res = await app.inject({ method: "GET", url: "/health/ready" });

    expect(res.statusCode).toBe(503);
    const payload = res.json();
    expect(payload.data.status).toBe("not_ready");
    expect(payload.data.checks.database.status).toBe("unhealthy");
    await app.close();
  });

  it("does not change /health (liveness) behavior or status code", async () => {
    const app = buildApp({ prisma: healthyPrisma(), internalSecret });

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe("ok");
    await app.close();
  });
});
