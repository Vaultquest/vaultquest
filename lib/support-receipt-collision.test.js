import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import {
  FileSupportTicketStore,
  MemorySupportTicketStore,
} from "./support-ticket-store.js";

const now = () => Date.parse("2026-10-04T08:00:00Z");
const input = (label) => ({
  name: "Receipt Check",
  email: "receipt-check@example.com",
  category: "general",
  description: `Distinct support request ${label}`,
  idempotency_key: `form-${label}`,
});
const meta = { clientKey: "receipt-check" };

it("keeps the original receipt and retry identity when a new ID collides", async () => {
  const samples = [0.1, 0.1, 0.2];
  let calls = 0;
  const store = new MemorySupportTicketStore({
    now,
    random: () => samples[calls++],
  });
  const first = await store.create(input("first"), meta);
  const second = await store.create(input("second"), meta);

  assert.notEqual(second.ticket.id, first.ticket.id);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.equal(calls, 3);
  assert.deepEqual(await store.get(first.ticket.id), first.ticket);
  assert.deepEqual(await store.get(second.ticket.id), second.ticket);
  assert.deepEqual(await store.create(input("first"), meta), {
    ticket: first.ticket,
    duplicate: true,
  });
  assert.equal(calls, 3, "an idempotent retry must not allocate a receipt");
});

it("checks restored and newly queued receipts before appending after restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vq-receipt-"));
  try {
    const filePath = path.join(directory, "tickets.jsonl");
    const original = new FileSupportTicketStore(filePath, {
      now,
      random: () => 0.1,
    });
    const first = await original.create(input("first"), meta);
    const samples = [0.1, 0.2, 0.2, 0.3];
    let calls = 0;
    const restarted = new FileSupportTicketStore(filePath, {
      now,
      random: () => samples[calls++],
    });
    const [second, third] = await Promise.all([
      restarted.create(input("second"), meta),
      restarted.create(input("third"), meta),
    ]);
    const tickets = [first.ticket, second.ticket, third.ticket];

    assert.equal(new Set(tickets.map((ticket) => ticket.id)).size, 3);
    assert.equal(calls, 4);
    const bytes = await fs.readFile(filePath, "utf8");
    assert.deepEqual(bytes.trim().split("\n").map(JSON.parse), tickets);
    const readback = new FileSupportTicketStore(filePath, {
      now,
      random: () => assert.fail("restored retries must not allocate IDs"),
    });
    for (const [index, label] of ["first", "second", "third"].entries()) {
      assert.deepEqual(await readback.get(tickets[index].id), tickets[index]);
      assert.deepEqual(await readback.create(input(label), meta), {
        ticket: tickets[index],
        duplicate: true,
      });
    }
    assert.equal(await fs.readFile(filePath, "utf8"), bytes);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("fails bounded collision exhaustion without accepting and permits a later retry", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vq-receipt-"));
  try {
    const filePath = path.join(directory, "tickets.jsonl");
    let sample = 0.1;
    let calls = 0;
    const store = new FileSupportTicketStore(filePath, {
      now,
      random: () => {
        calls += 1;
        return sample;
      },
    });
    const first = await store.create(input("first"), meta);
    const bytes = await fs.readFile(filePath, "utf8");
    const initialCalls = calls;
    await assert.rejects(store.create(input("second"), meta), {
      code: "STORE_UNAVAILABLE",
    });

    assert.equal(calls - initialCalls, 8);
    assert.equal(await fs.readFile(filePath, "utf8"), bytes);
    assert.equal(store.tickets.size, 1);
    assert.equal(store.duplicates.size, 1);
    assert.equal(store.byIdempotency.has("form-second"), false);
    assert.deepEqual(await store.get(first.ticket.id), first.ticket);

    sample = 0.2;
    const retry = await store.create(input("second"), meta);
    assert.equal(retry.duplicate, false);
    assert.notEqual(retry.ticket.id, first.ticket.id);
    const readback = new FileSupportTicketStore(filePath, { now });
    assert.deepEqual(await readback.get(first.ticket.id), first.ticket);
    assert.deepEqual(await readback.get(retry.ticket.id), retry.ticket);
    assert.deepEqual(await readback.create(input("second"), meta), {
      ticket: retry.ticket,
      duplicate: true,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
