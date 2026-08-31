import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { injectWithCsrf as origInjectWithCsrf } from "./helpers/csrf.js";
const injectWithCsrf = (app: any, method: any, url: any, payload?: any, headers = {}) => origInjectWithCsrf(app, method, url, payload, { ...headers, "x-internal-secret": "test-secret" });

describe("public /actions routes", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: "test-secret", allowUnauthenticatedDevApi: true });
  });
  afterAll(async () => {
    await app.close();
    await db.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  const validDeposit = { schema_version: 1, vault_id: "1", amount: "100", token: "USDC" };

  it("POST /actions requires Idempotency-Key", async () => {
    const res = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GABC",
      action_type: "deposit",
      action_payload: validDeposit
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("POST /actions creates a pending action", async () => {
    const res = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GABC",
      action_type: "deposit",
      action_payload: validDeposit
    }, { "idempotency-key": randomUUID() });
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.status).toBe("pending");
    expect(body.correlation_id).toBeDefined();
  });

  it("POST /actions returns 200 on idempotent replay", async () => {
    const payload = {
      wallet_address: "GABC",
      action_type: "deposit",
      action_payload: validDeposit
    };
    const key = randomUUID();
    const first = await injectWithCsrf(app, "POST", "/actions", payload, { "idempotency-key": key });
    const second = await injectWithCsrf(app, "POST", "/actions", payload, { "idempotency-key": key });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.id).toBe(first.json().data.id);
  });

  it("POST /actions returns 409 on key reuse with different payload", async () => {
    const key = randomUUID();
    const first = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GABC",
      action_type: "deposit",
      action_payload: validDeposit
    }, { "idempotency-key": key });
    const second = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GABC",
      action_type: "deposit",
      action_payload: { schema_version: 1, vault_id: "999", amount: "100", token: "USDC" }
    }, { "idempotency-key": key });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
  });

  it("PATCH /actions/:id/submitted transitions to submitted", async () => {
    const create = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GABC",
      action_type: "deposit",
      action_payload: validDeposit
    }, { "idempotency-key": randomUUID() });
    const id = create.json().data.id;
    const patch = await injectWithCsrf(app, "PATCH", `/actions/${id}/submitted`, { tx_hash: "tx_1" });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.status).toBe("submitted");
    expect(patch.json().data.tx_hash).toBe("tx_1");
  });

  it("POST /actions/:id/cancel transitions to failed", async () => {
    const create = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GABC",
      action_type: "deposit",
      action_payload: validDeposit
    }, { "idempotency-key": randomUUID() });
    const id = create.json().data.id;
    const cancel = await injectWithCsrf(app, "POST", `/actions/${id}/cancel`, {
      error_code: "WALLET_REJECTED",
      error_detail: "user denied"
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.status).toBe("failed");
    expect(cancel.json().data.error_code).toBe("WALLET_REJECTED");
  });

  it("GET /actions/:id returns record", async () => {
    const create = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GABC",
      action_type: "deposit",
      action_payload: validDeposit
    }, { "idempotency-key": randomUUID() });
    const id = create.json().data.id;
    const get = await app.inject({ headers: { "x-internal-secret": "test-secret" }, method: "GET", url: `/actions/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.id).toBe(id);
  });

  it("GET /actions lists by wallet", async () => {
    for (let i = 0; i < 2; i++) {
      await injectWithCsrf(app, "POST", "/actions", {
        wallet_address: "GWALLET",
        action_type: "deposit",
        action_payload: { schema_version: 1, vault_id: `v${i}`, amount: "100", token: "USDC" }
      }, { "idempotency-key": randomUUID() });
    }
    const list = await app.inject({ headers: { "x-internal-secret": "test-secret" }, method: "GET", url: "/actions?wallet=GWALLET&limit=10" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(2);
    expect(list.json().meta.pagination).toMatchObject({ limit: 10, has_more: false, next_cursor: null });
  });

  it("DELETE /actions?wallet=G... scrubs payload", async () => {
    const create = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GSCRUB",
      action_type: "deposit",
      action_payload: validDeposit
    }, { "idempotency-key": randomUUID() });
    const id = create.json().data.id;
    const del = await injectWithCsrf(app, "DELETE", "/actions?wallet=GSCRUB");
    expect(del.statusCode).toBe(200);
    expect(del.json().data.scrubbed).toBe(1);

    const get = await app.inject({ headers: { "x-internal-secret": "test-secret" }, method: "GET", url: `/actions/${id}` });
    expect(get.json().data.action_payload).toBeNull();
    expect(get.json().data.redacted_at).not.toBeNull();
  });
});
