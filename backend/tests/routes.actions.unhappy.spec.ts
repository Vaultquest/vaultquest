import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { randomUUID } from "node:crypto";

const VALID_API_KEY = "a".repeat(32);
const INTERNAL_SECRET = "test-internal-secret-123456";

// Export now authenticates before it validates (#10), so these query-validation
// cases present a service credential to reach the schema at all.
const EXPORT_SERVICE_HEADERS = { "x-internal-secret": INTERNAL_SECRET };

function getMockPrisma() {
  return {
    actionLedger: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: randomUUID(),
        idempotencyKey: randomUUID(),
        walletAddress: "GABC",
        actionType: "deposit",
        actionPayload: {},
        status: "pending",
        createdAt: new Date(),
        updatedAt: new Date()
      }),
      update: vi.fn().mockResolvedValue({
        id: randomUUID(),
        status: "submitted",
        txHash: "tx_12345",
        createdAt: new Date(),
        updatedAt: new Date()
      }),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([])
    },
    savedPool: { findMany: vi.fn().mockResolvedValue([]) },
    indexerCheckpoint: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "singleton" })
    },
    vaultSettlement: { findMany: vi.fn().mockResolvedValue([]) },
    userQuest: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation(async (args: unknown) => {
      if (Array.isArray(args)) return [0, []];
      return (args as (tx: unknown) => unknown)(null);
    })
  } as any;
}

let ipCounter = 1;

// Helper to inject requests with a unique IP address to prevent rate-limit cross-test pollution
async function injectWithUniqueIp(app: any, method: string, url: string, payload?: any, headers?: any) {
  const ip = `192.168.100.${ipCounter++}`;

  // For state-changing methods (POST, PATCH, DELETE) that are not internal, we need CSRF headers
  const isStateChanging = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
  const isInternal = url.startsWith("/internal/");

  if (isStateChanging && !isInternal) {
    // 1. Fetch CSRF token using GET with the same IP
    const getRes = await app.inject({
      method: "GET",
      url: "/health",
      remoteAddress: ip
    });
    const csrfToken = getRes.headers["x-csrf-token"] as string;
    const setCookie = getRes.headers["set-cookie"] as string;

    // 2. Return the actual request with CSRF headers
    return app.inject({
      method,
      url,
      remoteAddress: ip,
      headers: {
        "x-csrf-token": csrfToken,
        cookie: setCookie,
        ...headers
      },
      payload
    });
  }

  // Otherwise, just perform a standard injection with unique IP
  return app.inject({
    method,
    url,
    remoteAddress: ip,
    headers,
    payload
  });
}

describe("Unhappy-path tests for action and internal routes", () => {

  describe("POST /actions payloads & headers", () => {
    it("rejects request missing idempotency-key header", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/actions", {
        wallet_address: "GABC",
        action_type: "deposit",
        action_payload: {}
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.message).toContain("Idempotency-Key");
      await app.close();
    });

    it("rejects request with malformed idempotency-key header (non-UUID)", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/actions", {
        wallet_address: "GABC",
        action_type: "deposit",
        action_payload: {}
      }, { "idempotency-key": "not-a-uuid" });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.message).toContain("Idempotency-Key");
      await app.close();
    });

    it("rejects missing wallet_address in request body", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/actions", {
        action_type: "deposit",
        action_payload: {}
      }, { "idempotency-key": randomUUID() });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.message).toBe("validation failed");
      expect(body.error.issues[0].path).toContain("wallet_address");
      await app.close();
    });

    it("rejects invalid action_type in request body", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/actions", {
        wallet_address: "GABC",
        action_type: "invalid_action_type",
        action_payload: {}
      }, { "idempotency-key": randomUUID() });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("action_type");
      await app.close();
    });
  });

  describe("PATCH /actions/:id/submitted payload validation", () => {
    it("rejects malformed tx_hash that is too short", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "PATCH", `/actions/${randomUUID()}/submitted`, { tx_hash: "abc" });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("tx_hash");
      await app.close();
    });

    it("rejects request missing tx_hash", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "PATCH", `/actions/${randomUUID()}/submitted`, {});
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      await app.close();
    });
  });

  describe("POST /actions/:id/cancel payload validation", () => {
    it("rejects cancel request missing error_code", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", `/actions/${randomUUID()}/cancel`, { error_detail: "some detail" });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("error_code");
      await app.close();
    });

    it("rejects cancel request with error_code that is too long", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", `/actions/${randomUUID()}/cancel`, { error_code: "a".repeat(65) });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("error_code");
      await app.close();
    });
  });

  describe("API Key Authentication failures on /api/* routes", () => {
    it("rejects GET /api/actions/:walletAddress with missing key header", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET, apiKey: VALID_API_KEY });
      const res = await injectWithUniqueIp(app, "GET", "/api/actions/GABC");
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(body.error.message).toBe("unauthorized");
      await app.close();
    });

    it("rejects GET /api/actions/:walletAddress with wrong key header", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET, apiKey: VALID_API_KEY });
      const res = await injectWithUniqueIp(app, "GET", "/api/actions/GABC", undefined, { "x-api-key": "invalid-key-value" });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      await app.close();
    });
  });

  describe("Internal endpoints authentication failures", () => {
    it("rejects POST /internal/reconcile with missing internal secret header", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/internal/reconcile", {
        tx_hash: "tx_12345",
        soroban_event_id: "evt_1",
        event_payload: {},
        status_hint: "confirmed"
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      await app.close();
    });

    it("rejects POST /internal/reconcile with wrong internal secret header", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/internal/reconcile", {
        tx_hash: "tx_12345",
        soroban_event_id: "evt_1",
        event_payload: {},
        status_hint: "confirmed"
      }, { "x-internal-secret": "wrong-secret-value" });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      await app.close();
    });

    it("rejects POST /internal/checkpoint with missing internal secret header", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/internal/checkpoint", {
        latest_ledger: 1000,
        success: true
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      await app.close();
    });

    it("rejects POST /internal/checkpoint with wrong internal secret header", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/internal/checkpoint", {
        latest_ledger: 1000,
        success: true
      }, { "x-internal-secret": "wrong-secret-value" });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      await app.close();
    });
  });

  describe("Internal endpoints malformed payloads", () => {
    it("rejects POST /internal/reconcile with too short tx_hash", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/internal/reconcile", {
        tx_hash: "abc",
        soroban_event_id: "evt_1",
        event_payload: {},
        status_hint: "confirmed"
      }, { "x-internal-secret": INTERNAL_SECRET });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("tx_hash");
      await app.close();
    });

    it("rejects POST /internal/reconcile with invalid status_hint", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/internal/reconcile", {
        tx_hash: "tx_12345",
        soroban_event_id: "evt_1",
        event_payload: {},
        status_hint: "invalid_status"
      }, { "x-internal-secret": INTERNAL_SECRET });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("status_hint");
      await app.close();
    });

    it("rejects POST /internal/checkpoint with negative latest_ledger", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "POST", "/internal/checkpoint", {
        latest_ledger: -1,
        success: true
      }, { "x-internal-secret": INTERNAL_SECRET });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("latest_ledger");
      await app.close();
    });
  });

  describe("List/history query parameters validation", () => {
    it("rejects GET /actions missing wallet parameter", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/actions");
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("wallet");
      await app.close();
    });

    it("rejects GET /actions with invalid status", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/actions?wallet=GABC&status=invalid_status");
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("status");
      await app.close();
    });

    it("rejects GET /actions with invalid cursor (not UUID)", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/actions?wallet=GABC&cursor=invalid_uuid");
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("cursor");
      await app.close();
    });

    it("rejects GET /actions with invalid limit (limit 0)", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/actions?wallet=GABC&limit=0");
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("limit");
      await app.close();
    });

    it("rejects GET /api/actions/:walletAddress with invalid limit (limit 101)", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET, apiKey: VALID_API_KEY });
      const res = await injectWithUniqueIp(app, "GET", "/api/actions/GABC?limit=101", undefined, { "x-api-key": VALID_API_KEY });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("limit");
      await app.close();
    });

    it("rejects GET /api/actions/:walletAddress with invalid action type", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET, apiKey: VALID_API_KEY });
      const res = await injectWithUniqueIp(app, "GET", "/api/actions/GABC?type=invalid_type", undefined, { "x-api-key": VALID_API_KEY });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("type");
      await app.close();
    });
  });

  describe("Dashboard, portfolio and export query validation", () => {
    it("rejects GET /portfolio/summary with invalid Stellar address regex pattern", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/portfolio/summary?wallet=not-a-valid-stellar-key");
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("wallet");
      await app.close();
    });

    it("rejects GET /dashboard/summary with negative stale_after_ms", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/dashboard/summary?wallet=GABC&stale_after_ms=-100");
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("stale_after_ms");
      await app.close();
    });

    it("rejects GET /actions/export with invalid format", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/actions/export?wallet=GABC&format=pdf", undefined, EXPORT_SERVICE_HEADERS);
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("format");
      await app.close();
    });

    it("rejects GET /actions/export with non-ISO8601 offset datetime", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/actions/export?wallet=GABC&from=2026-07-20", undefined, EXPORT_SERVICE_HEADERS);
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("from");
      await app.close();
    });

    it("rejects GET /actions/export with too high limit (limit 1001)", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const res = await injectWithUniqueIp(app, "GET", "/actions/export?wallet=GABC&limit=1001", undefined, EXPORT_SERVICE_HEADERS);
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.issues[0].path).toContain("limit");
      await app.close();
    });
  });

  describe("Per-route rate limiting behavior", () => {
    it("blocks sensitive POST /actions requests after limit is reached (limit is 10)", async () => {
      const app = buildApp({ prisma: getMockPrisma(), internalSecret: INTERNAL_SECRET });
      const testIp = `192.168.200.${ipCounter++}`;

      let lastStatus = 0;
      let lastBody: any = null;

      // Rate limit for sensitive routes is 10. Let's send 12 requests.
      // Since they are from the same IP, they will hit the rate limit.
      // We also need matching CSRF tokens and cookies for the POST requests.
      const getRes = await app.inject({
        method: "GET",
        url: "/health",
        remoteAddress: testIp
      });
      const csrfToken = getRes.headers["x-csrf-token"] as string;
      const setCookie = getRes.headers["set-cookie"] as string;

      for (let i = 0; i < 12; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/actions",
          remoteAddress: testIp,
          headers: {
            "idempotency-key": randomUUID(),
            "x-csrf-token": csrfToken,
            cookie: setCookie
          },
          payload: {
            wallet_address: "GABC",
            action_type: "deposit",
            action_payload: {}
          }
        });
        lastStatus = res.statusCode;
        lastBody = res.json();
        if (lastStatus === 429) {
          break;
        }
      }

      expect(lastStatus).toBe(429);
      expect(lastBody.error.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(lastBody.error.message).toContain("Rate limit exceeded");
      await app.close();
    });
  });
});
