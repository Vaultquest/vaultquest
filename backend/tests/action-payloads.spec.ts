import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { injectWithCsrf } from "./helpers/csrf.js";
import {
  parseActionPayload,
  parseEventPayload,
  toActionPayloadView,
  ACTION_SCHEMA_VERSION
} from "../src/schemas/actionPayloads.js";
import type { ZodIssue } from "zod";

const VALID_WINNER = "GABCDEF1234567890123456789012345678901234567890123456789";

describe("versioned action payload schemas (#109)", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: "test-secret" });
  });
  afterAll(async () => {
    await app.close();
    await db.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  type InjectResponse = Awaited<ReturnType<typeof injectWithCsrf>>;

  async function postAction(
    type: string,
    payload: unknown
  ): Promise<InjectResponse> {
    return injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GABC",
      action_type: type,
      action_payload: payload
    }, { "idempotency-key": randomUUID() });
  }

  describe("valid per-type v1 fixtures", () => {
    const fixtures: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: "deposit", payload: { schema_version: 1, vault_id: "vault-1", amount: "1000000", token: "USDC" } },
      { type: "withdraw", payload: { schema_version: 1, vault_id: "vault-1", amount: "250000", token: "USDC" } },
      { type: "create_vault", payload: { schema_version: 1, vault_id: "vault-1", token: "USDC" } },
      { type: "claim", payload: { schema_version: 1, vault_id: "vault-1", amount: "500", token: "USDC" } },
      { type: "select_winner", payload: { schema_version: 1, vault_id: "vault-1", winner: VALID_WINNER } }
    ];

    it.each(fixtures)("accepts a valid $type payload and stores schema_version", async ({ type, payload }) => {
      const res = await postAction(type, payload);
      expect(res.statusCode).toBe(201);
      const stored = res.json().data.action_payload;
      expect(stored.schema_version).toBe(ACTION_SCHEMA_VERSION);
      expect(stored).toMatchObject(payload);
    });

    it("stores exact-unit amounts as strings for financial actions", async () => {
      const res = await postAction("deposit", {
        schema_version: 1,
        vault_id: "vault-1",
        amount: "0.1",
        token: "BTC"
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.action_payload.amount).toBe("0.1");
    });
  });

  describe("adversarial versioned payloads", () => {
    it("rejects unknown fields with a structured error", async () => {
      const res = await postAction("deposit", {
        schema_version: 1,
        vault_id: "vault-1",
        amount: "100",
        token: "USDC",
        malicious_field: "x"
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.message).toBe("invalid action_payload");
      expect(body.error.issues.some((i: ZodIssue) => i.keys?.includes("malicious_field") || String(i.path[0]) === "malicious_field")).toBe(true);
    });

    it("rejects an unsupported schema_version", async () => {
      const res = await postAction("deposit", {
        schema_version: 99,
        vault_id: "vault-1",
        amount: "100",
        token: "USDC"
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.issues[0].path).toContain("schema_version");
      expect(body.error.details).toBeUndefined();
    });

    it("rejects float amounts in versioned payloads (exact units required)", async () => {
      const res = await postAction("deposit", {
        schema_version: 1,
        vault_id: "vault-1",
        amount: 100.5,
        token: "USDC"
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.issues[0].path).toContain("amount");
    });

    it("rejects a deposit missing the required asset identity", async () => {
      const res = await postAction("deposit", {
        schema_version: 1,
        vault_id: "vault-1",
        amount: "100"
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.issues[0].path).toContain("token");
    });

    it("rejects a non-object payload", async () => {
      const res = await postAction("deposit", "not-an-object");
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_PAYLOAD");
    });
  });

  describe("oversized payload bounds", () => {
    it("rejects deeply nested payloads", async () => {
      const nested: Record<string, unknown> = { v: 1 };
      let cur: Record<string, unknown> = nested;
      for (let i = 0; i < 8; i++) {
        cur["next"] = {};
        cur = cur["next"] as Record<string, unknown>;
      }
      const res = await postAction("deposit", {
        vault_id: "vault-1",
        amount: "100",
        token: "USDC",
        nested
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.issues[0].message).toContain("nesting");
    });

    it("rejects payloads with too many keys", async () => {
      const payload: Record<string, unknown> = { vault_id: "vault-1", amount: "100", token: "USDC" };
      for (let i = 0; i < 35; i++) payload[`extra_${i}`] = i;
      const res = await postAction("deposit", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.issues[0].message).toContain("keys");
    });

    it("rejects overlong string values", async () => {
      const res = await postAction("deposit", {
        vault_id: "vault-1",
        amount: "100",
        token: "USDC",
        note: "x".repeat(300)
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.issues[0].message).toContain("characters");
    });

    it("rejects payloads that serialize over the byte budget", async () => {
      const res = await postAction("deposit", {
        vault_id: "vault-1",
        amount: "100",
        token: "USDC",
        blob: "x".repeat(20_000)
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.issues[0].message).toContain("bytes");
    });
  });

  describe("legacy migration and quarantine", () => {
    it("migrates an unversioned deposit payload into v1 and stores schema_version", async () => {
      const res = await postAction("deposit", { vault_id: "p1", amount: 100, asset: "XLM" });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.action_payload).toEqual({
        schema_version: 1,
        vault_id: "p1",
        amount: "100",
        token: "XLM"
      });
    });

    it("migrates pool_id to vault_id for legacy deposits", async () => {
      const res = await postAction("deposit", { pool_id: "pool-a", amount: "40" });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.action_payload).toEqual({
        schema_version: 1,
        vault_id: "pool-a",
        amount: "40",
        token: "USDC"
      });
    });

    it("quarantines a legacy payload that cannot be migrated", async () => {
      const res = await postAction("deposit", {});
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("INVALID_PAYLOAD");
      expect(body.error.details).toEqual({ quarantined: true, reason: expect.stringContaining("legacy") });
    });

    it("quarantines a legacy select_winner without a winner", async () => {
      const res = await postAction("select_winner", { vault_id: "vault-1" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.details.quarantined).toBe(true);
    });
  });

  describe("versioned event payloads", () => {
    const INTERNAL_HEADERS = { "x-internal-secret": "test-secret", "content-type": "application/json" };

    async function reconcile(payload: unknown, txHash = `tx_${randomUUID()}`) {
      return app.inject({
        method: "POST",
        url: "/internal/reconcile",
        remoteAddress: `192.168.70.${Math.floor(Math.random() * 200) + 1}`,
        headers: INTERNAL_HEADERS,
        payload: { tx_hash: txHash, soroban_event_id: "evt_1", event_payload: payload, status_hint: "confirmed" }
      });
    }

    it("parks a valid v1 event and stores schema_version", async () => {
      const res = await reconcile({ schema_version: 1, event_type: "deposit", vault_id: "v1", amount: "100" });
      expect(res.statusCode).toBe(202);
      expect(res.json().data.parked).toBe(true);

      const rows = await db.prisma.pendingEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 1 });
      expect(rows[0]?.eventPayload).toEqual({
        schema_version: 1,
        event_type: "deposit",
        vault_id: "v1",
        amount: "100"
      });
    });

    it("migrates a legacy event payload (type -> event_type)", async () => {
      const res = await reconcile({ type: "withdraw", vault_id: "v1", amount: "250" });
      expect(res.statusCode).toBe(202);
      const rows = await db.prisma.pendingEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 1 });
      expect(rows[0]?.eventPayload).toEqual({
        schema_version: 1,
        event_type: "withdraw",
        vault_id: "v1",
        amount: "250"
      });
    });

    it("rejects an event payload with unknown fields", async () => {
      const res = await reconcile({
        schema_version: 1,
        event_type: "deposit",
        vault_id: "v1",
        amount: "100",
        rogue: true
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe("invalid event_payload");
      expect(res.json().error.issues.some((i: ZodIssue) => i.keys?.includes("rogue") || String(i.path[0]) === "rogue")).toBe(true);
    });

    it("rejects an unsupported event_type", async () => {
      const res = await reconcile({ schema_version: 1, event_type: "swap", vault_id: "v1", amount: "100" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.issues[0].path).toContain("event_type");
    });

    it("rejects an oversized event payload", async () => {
      const res = await reconcile({
        schema_version: 1,
        event_type: "deposit",
        vault_id: "v1",
        amount: "100",
        note: "x".repeat(500)
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.issues[0].message).toContain("characters");
    });
  });
});

describe("payload parse helpers (unit)", () => {
  it("parses each action type and normalizes legacy payloads", () => {
    const migrated = parseActionPayload("deposit", { pool_id: "p", amount: 50, asset: "yXLM" });
    expect(migrated).toEqual({
      ok: true,
      payload: { schema_version: 1, vault_id: "p", amount: "50", token: "yXLM" }
    });
  });

  it("quarantines unmigratable legacy payloads", () => {
    const result = parseActionPayload("claim", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.quarantined).toBe(true);
  });

  it("rejects unknown versions without quarantining", () => {
    const result = parseActionPayload("deposit", { schema_version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.quarantined).toBe(false);
      expect(result.issues[0]?.path).toContain("schema_version");
    }
  });

  it("rejects event payloads with unsupported event types", () => {
    const result = parseEventPayload({ schema_version: 1, event_type: "mint" });
    expect(result.ok).toBe(false);
  });

  it("exposes a read-side view for versioned and legacy payloads", () => {
    expect(toActionPayloadView("deposit", { schema_version: 1, vault_id: "v1", amount: "100", token: "USDC" })).toEqual({
      vaultId: "v1",
      amount: "100",
      token: "USDC"
    });
    expect(toActionPayloadView("withdraw", { vault_id: "v1", amount: "40", asset: "XLM" })).toEqual({
      vaultId: "v1",
      amount: "40",
      token: "XLM"
    });
    expect(toActionPayloadView("select_winner", { vault_id: "v1", winner: VALID_WINNER })).toEqual({
      vaultId: "v1",
      amount: "0",
      token: "USDC"
    });
    expect(toActionPayloadView("deposit", null)).toBeNull();
  });
});
