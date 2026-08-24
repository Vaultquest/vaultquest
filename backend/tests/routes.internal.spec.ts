/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { injectWithCsrf as origInjectWithCsrf } from "./helpers/csrf.js";
const injectWithCsrf = (app: any, method: any, url: any, payload?: any, headers = {}) => origInjectWithCsrf(app, method, url, payload, { ...headers, "x-internal-secret": "very-secret-123" });

describe("/internal/reconcile", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: "very-secret-123" });
  });
  afterAll(async () => {
    await app.close();
    await db.stop();
  });
  beforeEach(async () => { await resetDb(db.prisma); });

  const validEventPayload = { schema_version: 1, event_type: "deposit", vault_id: "v1", amount: "100" };

  it("rejects without secret", async () => {
    const res = await app.inject({
      method: "POST", url: "/internal/reconcile",
      headers: { "content-type": "application/json" },
      payload: { tx_hash: "tx", soroban_event_id: "e", event_payload: validEventPayload, status_hint: "confirmed" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("matches a submitted action and confirms it", async () => {
    const key = randomUUID();
    const create = await injectWithCsrf(app, "POST", "/actions", {
      wallet_address: "GA",
      action_type: "deposit",
      action_payload: { schema_version: 1, vault_id: "v1", amount: "100", token: "USDC" }
    }, { "idempotency-key": key });
    if (create.statusCode !== 201 && create.statusCode !== 200) throw new Error("create failed: " + JSON.stringify(create.json()));
    const id = create.json().data.id;
    await injectWithCsrf(app, "PATCH", `/actions/${id}/submitted`, { tx_hash: "tx_match" });

    const res = await app.inject({
      method: "POST", url: "/internal/reconcile",
      headers: { "x-internal-secret": "very-secret-123", "content-type": "application/json" },
      payload: { tx_hash: "tx_match", soroban_event_id: "evt_1", event_payload: validEventPayload, status_hint: "confirmed" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.matched).toBe(true);

    const row = await app.inject({ headers: { "x-internal-secret": "very-secret-123" }, method: "GET", url: `/actions/${id}` });
    expect(row.json().data.status).toBe("confirmed");
  });

  it("parks unknown tx_hash", async () => {
    const res = await app.inject({
      method: "POST", url: "/internal/reconcile",
      headers: { "x-internal-secret": "very-secret-123", "content-type": "application/json" },
      payload: { tx_hash: "tx_unknown", soroban_event_id: "evt", event_payload: validEventPayload, status_hint: "confirmed" }
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.parked).toBe(true);
  });
});
