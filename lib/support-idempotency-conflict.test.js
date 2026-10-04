import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  MemorySupportTicketStore,
  FileSupportTicketStore,
  DUPLICATE_WINDOW_MS,
} from "./support-ticket-store.js";

const input = {
  name: "Ada",
  email: "ada@example.test",
  category: "transaction",
  description: "Transfer ABC did not arrive.",
  wallet_address: "0x" + "a".repeat(40),
  idempotency_key: "submitted-form-1",
};
const meta = { clientKey: "one-client" };

describe("support idempotency content", () => {
  it("replays normalized matches and rejects changed content without consuming quota", async () => {
    const store = new MemorySupportTicketStore({
      rateLimit: { max: 1, windowMs: 60000 },
      now: () => 1000,
      random: () => 0.1,
    });
    const original = await store.create(input, meta);
    const match = await store.create({
      ...input,
      name: " Ada ",
      email: " ADA@EXAMPLE.TEST ",
      description: " Transfer ABC did not arrive. ",
      wallet_address: "0x" + "A".repeat(40),
    }, meta);
    assert.equal(match.duplicate, true);
    assert.deepEqual(match.ticket, original.ticket);

    // These are distinct accepted fields, even when the similarity-based
    // duplicate fingerprint would deliberately treat some as equivalent.
    for (const change of [
      { name: "Grace" },
      { email: "grace@example.test" },
      { category: "wallet" },
      { description: "transfer abc did not arrive." },
      { wallet_address: "0x" + "b".repeat(40) },
    ]) {
      await assert.rejects(store.create({ ...input, ...change }, meta), {
        code: "IDEMPOTENCY_CONFLICT",
      });
      assert.equal(store.tickets.size, 1);
      assert.deepEqual(await store.get(original.ticket.id), original.ticket);
      assert.equal(store.rate.get(meta.clientKey).count, 1);
    }
    const retry = await store.create(input, meta);
    assert.equal(retry.ticket.id, original.ticket.id);
    assert.equal(retry.duplicate, true);
  });

  it("preserves durable acceptance across queued conflicts, restart and fresh-key recovery", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "support-conflict-"));
    const filePath = path.join(directory, "tickets.jsonl");
    try {
      const store = new FileSupportTicketStore(filePath, { random: () => 0.1 });
      const changed = { ...input, description: "A different transfer did not arrive." };
      const outcomes = await Promise.allSettled([
        store.create(input, meta),
        store.create(changed, meta),
      ]);
      assert.equal(outcomes[0].status, "fulfilled");
      assert.equal(outcomes[1].status, "rejected");
      assert.equal(outcomes[1].reason.code, "IDEMPOTENCY_CONFLICT");
      const original = outcomes[0].value;
      const acceptedBytes = await fs.readFile(filePath, "utf8");
      assert.equal(acceptedBytes.trim().split("\n").length, 1);

      const restarted = new FileSupportTicketStore(filePath, { random: () => 0.2 });
      await assert.rejects(restarted.create(changed, meta), {
        code: "IDEMPOTENCY_CONFLICT",
      });
      assert.equal(await fs.readFile(filePath, "utf8"), acceptedBytes);
      assert.deepEqual((await restarted.create(input, meta)).ticket, original.ticket);
      assert.equal(restarted.rate.size, 0);

      const recovery = await restarted.create({
        ...changed,
        idempotency_key: "submitted-form-2",
      }, meta);
      assert.equal(recovery.duplicate, false);
      assert.notEqual(recovery.ticket.id, original.ticket.id);
      assert.equal(recovery.ticket.description, changed.description);
      assert.deepEqual(await restarted.get(original.ticket.id), original.ticket);
      assert.equal((await fs.readFile(filePath, "utf8")).trim().split("\n").length, 2);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("durable duplicate idempotency keys", () => {
  it("replays an acknowledged duplicate after restart and window expiry without renewing the window", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "support-alias-"));
    const filePath = path.join(directory, "tickets.jsonl");
    let now = 1_000_000;
    const createdAt = now;
    const aliasInput = {
      ...input,
      description: input.description.toUpperCase().replace(/\s+/g, "  "),
      idempotency_key: "acknowledged-duplicate",
    };
    try {
      const store = new FileSupportTicketStore(filePath, { now: () => now, random: () => 0.1 });
      const original = await store.create(input, meta);
      now = createdAt + DUPLICATE_WINDOW_MS - 1;
      assert.deepEqual(await store.create(aliasInput, meta), { ticket: original.ticket, duplicate: true });
      const acceptedBytes = await fs.readFile(filePath, "utf8");
      const rows = acceptedBytes.trim().split("\n").map(JSON.parse);
      assert.deepEqual(rows.filter((row) => row.id), [original.ticket]);
      assert.equal(rows.length, 2);
      assert.equal(rows[1].record_type, "idempotency_alias");
      assert.equal(rows[1].idempotency_key, aliasInput.idempotency_key);
      assert.equal(rows[1].ticket_id, original.ticket.id);

      now = createdAt + DUPLICATE_WINDOW_MS + 1;
      const restarted = new FileSupportTicketStore(filePath, { now: () => now, random: () => 0.2 });
      assert.deepEqual(await restarted.create(aliasInput, meta), { ticket: original.ticket, duplicate: true });
      assert.equal(restarted.rate.size, 0);
      assert.equal(await fs.readFile(filePath, "utf8"), acceptedBytes);
      assert.deepEqual(await restarted.get(original.ticket.id), original.ticket);

      const fresh = await restarted.create({ ...aliasInput, idempotency_key: "fresh-after-window" }, meta);
      assert.equal(fresh.duplicate, false);
      assert.notEqual(fresh.ticket.id, original.ticket.id);
      assert.equal(fresh.ticket.created_at, now);
      assert.deepEqual(await restarted.get(original.ticket.id), original.ticket);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("binds conflicts to the accepted alias payload while preserving bytes, receipts and quota", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "support-alias-conflict-"));
    const filePath = path.join(directory, "tickets.jsonl");
    const aliasInput = {
      ...input,
      description: input.description.toUpperCase().replace(/\s+/g, "  "),
      idempotency_key: "alias-with-distinct-validated-text",
    };
    try {
      const store = new FileSupportTicketStore(filePath, { now: () => 1_000_000, random: () => 0.1 });
      const original = await store.create(input, meta);
      assert.equal((await store.create(aliasInput, meta)).ticket.id, original.ticket.id);
      const acceptedBytes = await fs.readFile(filePath, "utf8");
      const restarted = new FileSupportTicketStore(filePath, {
        now: () => 1_000_000 + DUPLICATE_WINDOW_MS + 1,
        random: () => 0.2,
      });
      for (const reader of [store, restarted]) {
        const quota = reader.rate.get(meta.clientKey)?.count;
        await assert.rejects(reader.create({ ...aliasInput, description: input.description }, meta), {
          code: "IDEMPOTENCY_CONFLICT",
        });
        assert.equal(reader.rate.get(meta.clientKey)?.count, quota);
        assert.equal(await fs.readFile(filePath, "utf8"), acceptedBytes);
        assert.deepEqual(await reader.get(original.ticket.id), original.ticket);
        assert.deepEqual(await reader.create(aliasInput, meta), { ticket: original.ticket, duplicate: true });
        assert.equal(reader.rate.get(meta.clientKey)?.count, quota);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not acknowledge or reserve an alias when its append fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "support-alias-failure-"));
    const filePath = path.join(directory, "tickets.jsonl");
    const appendFile = fs.appendFile;
    let random = 0;
    try {
      const store = new FileSupportTicketStore(filePath, {
        now: () => 1_000_000,
        random: () => (random += 0.1),
      });
      const original = await store.create(input, meta);
      const acceptedBytes = await fs.readFile(filePath, "utf8");
      const aliasInput = { ...input, idempotency_key: "unacknowledged-duplicate" };
      fs.appendFile = async () => {
        throw Object.assign(new Error("alias append unavailable"), { code: "STORE_UNAVAILABLE" });
      };
      await assert.rejects(store.create(aliasInput, meta), { code: "STORE_UNAVAILABLE" });
      fs.appendFile = appendFile;
      assert.equal(await fs.readFile(filePath, "utf8"), acceptedBytes);
      assert.deepEqual(await store.get(original.ticket.id), original.ticket);
      assert.equal(store.byIdempotency.has(aliasInput.idempotency_key), false);

      const different = { ...aliasInput, description: "A different transfer did not arrive." };
      const accepted = await store.create(different, meta);
      assert.equal(accepted.duplicate, false);
      assert.notEqual(accepted.ticket.id, original.ticket.id);
      const restarted = new FileSupportTicketStore(filePath);
      assert.deepEqual(await restarted.get(original.ticket.id), original.ticket);
      assert.deepEqual((await restarted.create(different, meta)).ticket, accepted.ticket);
    } finally {
      fs.appendFile = appendFile;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
