import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/app.js";

describe("CORS origin policy and defensive security headers (#126)", () => {
  const internalSecret = "test-internal-secret-123456";

  const getMockPrisma = () => {
    return {
      actionLedger: {
        findUnique: vi.fn(),
        create: vi.fn(),
        groupBy: vi.fn(),
        findMany: vi.fn(),
      },
      savedPool: { findMany: vi.fn() },
      indexerCheckpoint: {
        findUnique: vi.fn(),
        upsert: vi.fn().mockResolvedValue({ id: "singleton" }),
      },
    } as any;
  };

  it("sets defensive security headers on every response", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret, allowUnauthenticatedDevApi: true });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    await app.close();
  });

  it("sets HSTS in production", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret, allowUnauthenticatedDevApi: true, environment: "production" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["strict-transport-security"]).toBe("max-age=63072000; includeSubDomains; preload");
    await app.close();
  });

  it("allows credentialed requests from approved origins", async () => {
    const prev = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = "https://app.vaultquest.com";
    const app = buildApp({ prisma: getMockPrisma(), internalSecret, allowUnauthenticatedDevApi: true });
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://app.vaultquest.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.vaultquest.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toContain("Origin");
    await app.close();
    process.env.ALLOWED_ORIGINS = prev;
  });

  it("denies unapproved origins by omitting CORS headers", async () => {
    const prev = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = "https://app.vaultquest.com";
    const app = buildApp({ prisma: getMockPrisma(), internalSecret, allowUnauthenticatedDevApi: true });
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
    process.env.ALLOWED_ORIGINS = prev;
  });

  it("responds to preflight OPTIONS from allowed origin", async () => {
    const prev = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = "https://app.vaultquest.com";
    const app = buildApp({ prisma: getMockPrisma(), internalSecret, allowUnauthenticatedDevApi: true });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/actions",
      headers: { origin: "https://app.vaultquest.com", "access-control-request-method": "POST" },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.vaultquest.com");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    await app.close();
    process.env.ALLOWED_ORIGINS = prev;
  });
});
