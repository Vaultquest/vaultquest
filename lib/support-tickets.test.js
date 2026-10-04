import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  validateTicketInput,
  mintReceiptId,
  duplicateFingerprint,
  MAX_DESCRIPTION_CHARS,
} from "./support-tickets.js";
import {
  MemorySupportTicketStore,
  FileSupportTicketStore,
  clientRateKey,
  DUPLICATE_WINDOW_MS,
} from "./support-ticket-store.js";

const base = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  category: "wallet",
  description: "Cannot connect Freighter on mobile Safari.",
};

const temporaryDirectories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryStorePath() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "vaultquest-support-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "tickets.jsonl");
}

function deferred() {
  let resolve;
  const promise = new Promise((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

describe("validateTicketInput", () => {
  it("accepts a well-formed ticket and normalizes email", () => {
    const result = validateTicketInput({ ...base, email: "Ada@Example.COM" });
    expect(result.ok).toBe(true);
    expect(result.ticket.email).toBe("ada@example.com");
    expect(result.ticket.wallet_address).toBeNull();
  });

  it("binds a stellar wallet hint without treating it as proof", () => {
    const wallet = "G".padEnd(56, "A");
    const result = validateTicketInput({ ...base, wallet_address: wallet });
    expect(result.ok).toBe(true);
    expect(result.ticket.wallet_address).toBe(wallet);
  });

  it("rejects oversized content", () => {
    const result = validateTicketInput({
      ...base,
      description: "x".repeat(MAX_DESCRIPTION_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.description).toMatch(/at most/);
  });

  it("rejects anonymous empty payloads", () => {
    const result = validateTicketInput({});
    expect(result.ok).toBe(false);
    expect(result.fieldErrors.name).toBeTruthy();
    expect(result.fieldErrors.email).toBeTruthy();
    expect(result.fieldErrors.description).toBeTruthy();
  });
});

describe("mintReceiptId", () => {
  it("returns a stable-looking receipt id", () => {
    const id = mintReceiptId({ now: () => Date.parse("2026-09-24T12:00:00Z"), random: () => 0.5 });
    expect(id).toMatch(/^VQ-20260924-[0-9A-Z]{6}$/);
  });
});

describe("MemorySupportTicketStore", () => {
  it("persists a ticket and returns a receipt id", async () => {
    const store = new MemorySupportTicketStore({
      now: () => 1_000_000,
      random: () => 0.1,
    });
    const { ticket, duplicate } = await store.create(base, { clientKey: "a" });
    expect(duplicate).toBe(false);
    expect(ticket.id).toMatch(/^VQ-/);
    expect(ticket.status).toBe("accepted");
    expect(await store.get(ticket.id)).toEqual(ticket);
  });

  it("returns the same ticket for an idempotency key with the same normalized content", async () => {
    const store = new MemorySupportTicketStore();
    const first = await store.create(
      { ...base, idempotency_key: "form-1" },
      { clientKey: "a" },
    );
    const second = await store.create(
      { ...base, idempotency_key: "form-1", email: " Ada@Example.COM " },
      { clientKey: "a" },
    );
    expect(second.duplicate).toBe(true);
    expect(second.ticket.id).toBe(first.ticket.id);
  });

  it("rate limits repeated submissions from the same client key", async () => {
    const store = new MemorySupportTicketStore({
      rateLimit: { max: 2, windowMs: 60_000 },
      now: (() => {
        let t = 0;
        return () => t;
      })(),
    });
    await store.create({ ...base, description: "one" }, { clientKey: "ip1" });
    await store.create({ ...base, description: "two" }, { clientKey: "ip1" });
    await expect(
      store.create({ ...base, description: "three" }, { clientKey: "ip1" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("renews the quota at its reset instant without admitting an early retry", async () => {
    let now = 1_000_000;
    let random = 0;
    const store = new MemorySupportTicketStore({
      rateLimit: { max: 2, windowMs: 1_000 },
      now: () => now,
      random: () => (random += 0.01),
    });
    const submit = (description) =>
      store.create({ ...base, description }, { clientKey: "boundary-client" });

    await submit("First ticket");
    await submit("Second ticket");
    now += 999;
    await expect(submit("Early retry")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 1,
    });

    now += 1;
    expect((await submit("Ticket at reset")).duplicate).toBe(false);
    expect((await submit("Second ticket after reset")).duplicate).toBe(false);
    await expect(submit("Exhausted new quota")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfterMs: 1_000,
    });
  });

  it("shares a quota for equivalent emails while separating other clients", async () => {
    let random = 0;
    const store = new MemorySupportTicketStore({
      now: () => 1_000_000,
      random: () => (random += 0.01),
    });
    const ip = "203.0.113.7";
    const submit = (email, description, clientIp = ip) =>
      store.create(
        { ...base, email, description },
        { clientKey: clientRateKey({ ip: clientIp, email }) },
      );

    for (let i = 0; i < 5; i += 1) {
      await submit(base.email, `Initial request ${i}`);
    }
    for (const email of [
      "Ada@Example.COM",
      " ada@example.com ",
      "\tAda@Example.COM\r\n",
      "\u00a0Ada@Example.COM\u00a0",
    ]) {
      const validated = validateTicketInput({ ...base, email });
      expect(validated.ok).toBe(true);
      expect(validated.ticket.email).toBe(base.email);
      await expect(submit(email, `Retry from ${email}`)).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
    }

    const otherEmail = await submit("other@example.com", "Another email");
    expect(otherEmail.ticket.email).toBe("other@example.com");
    expect(otherEmail.duplicate).toBe(false);
    const otherIp = await submit(base.email, "Another IP", "203.0.113.8");
    expect(otherIp.ticket.email).toBe(base.email);
    expect(otherIp.duplicate).toBe(false);
  });

  it("dedupes identical content inside the duplicate window", async () => {
    const store = new MemorySupportTicketStore({ now: () => 50 });
    const first = await store.create(base, { clientKey: "a" });
    const second = await store.create(base, { clientKey: "b" });
    expect(second.duplicate).toBe(true);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(duplicateFingerprint(base)).toBe(
      duplicateFingerprint({
        email: base.email,
        category: base.category,
        description: base.description,
      }),
    );
  });

  it("surfaces provider outages without accepting", async () => {
    const store = new MemorySupportTicketStore();
    store.simulateOutage();
    await expect(store.create(base, { clientKey: "a" })).rejects.toMatchObject({
      code: "STORE_UNAVAILABLE",
    });
  });

  it("accepts anonymous tickets (no wallet) and wallet-authenticated hints", async () => {
    const store = new MemorySupportTicketStore();
    const anon = await store.create(base, { clientKey: "anon" });
    expect(anon.ticket.wallet_address).toBeNull();

    const wallet = "G".padEnd(56, "B");
    const withWallet = await store.create(
      { ...base, email: "other@example.com", description: "wallet path", wallet_address: wallet },
      { clientKey: "wallet" },
    );
    expect(withWallet.ticket.wallet_address).toBe(wallet);
  });
});

describe("clientRateKey", () => {
  it("hashes ip+email without echoing secrets", () => {
    const key = clientRateKey({ ip: "1.2.3.4", email: "ada@example.com" });
    expect(key).toHaveLength(32);
    expect(key).not.toContain("ada");
    expect(key).not.toContain("1.2.3.4");
  });
});

describe("FileSupportTicketStore", () => {
  it("skips incomplete rows without replacing receipts or seeding idempotency aliases", async () => {
    const filePath = await temporaryStorePath();
    const input = { ...base, idempotency_key: "original-form" };
    const writer = new FileSupportTicketStore(filePath, { random: () => 0.1 });
    const original = await writer.create(input, { clientKey: "a" });
    await fs.appendFile(
      filePath,
      `${JSON.stringify({
        id: original.ticket.id,
        idempotency_key: "corrupt-alias",
      })}\n`,
    );
    const restarted = new FileSupportTicketStore(filePath, { random: () => 0.2 });

    const recoveredOriginal = await restarted.get(original.ticket.id);
    const accepted = await restarted.create(
      { ...base, description: "A distinct support request.", idempotency_key: "corrupt-alias" },
      { clientKey: "a" },
    );

    expect(recoveredOriginal).toEqual(original.ticket);
    expect(accepted.duplicate).toBe(false);
    expect(accepted.ticket.id).not.toBe(original.ticket.id);
    expect(accepted.ticket.email).toBe(base.email);
    expect(await restarted.create(input, { clientKey: "a" })).toEqual({
      ticket: original.ticket,
      duplicate: true,
    });
    const readback = new FileSupportTicketStore(filePath);
    expect(await readback.get(original.ticket.id)).toEqual(original.ticket);
    expect(await readback.get(accepted.ticket.id)).toEqual(accepted.ticket);
  });

  it("preserves a valid final receipt without a newline when appending after restart", async () => {
    const filePath = await temporaryStorePath();
    const input = { ...base, idempotency_key: "original-form" };
    const writer = new FileSupportTicketStore(filePath, { random: () => 0.1 });
    const original = await writer.create(input, { clientKey: "a" });
    const initialBytes = (await fs.readFile(filePath, "utf8")).slice(0, -1);
    await fs.writeFile(filePath, initialBytes);
    const restarted = new FileSupportTicketStore(filePath, { random: () => 0.2 });
    expect(await restarted.get(original.ticket.id)).toEqual(original.ticket);

    const accepted = await restarted.create(
      { ...base, description: "A different support request.", idempotency_key: "next-form" },
      { clientKey: "a" },
    );

    expect(accepted.duplicate).toBe(false);
    const finalBytes = await fs.readFile(filePath, "utf8");
    expect(finalBytes.startsWith(initialBytes)).toBe(true);
    expect(finalBytes.trim().split("\n").map(JSON.parse)).toEqual([
      original.ticket,
      accepted.ticket,
    ]);
    const readback = new FileSupportTicketStore(filePath);
    expect(await readback.get(original.ticket.id)).toEqual(original.ticket);
    expect(await readback.get(accepted.ticket.id)).toEqual(accepted.ticket);
    const replay = await readback.create(input, { clientKey: "a" });
    expect(replay).toEqual({ ticket: original.ticket, duplicate: true });
    expect(await fs.readFile(filePath, "utf8")).toBe(finalBytes);
  });

  it("separates accepted receipts from a truncated tail without changing prior bytes", async () => {
    const filePath = await temporaryStorePath();
    const writer = new FileSupportTicketStore(filePath, { random: () => 0.1 });
    const original = await writer.create(base, { clientKey: "a" });
    await fs.appendFile(filePath, '{"id":"interrupted');
    const initialBytes = await fs.readFile(filePath, "utf8");
    const restarted = new FileSupportTicketStore(filePath, { random: () => 0.2 });

    const accepted = await restarted.create(
      { ...base, description: "A different support request.", idempotency_key: "next-form" },
      { clientKey: "a" },
    );

    expect(accepted.duplicate).toBe(false);
    const finalBytes = await fs.readFile(filePath, "utf8");
    expect(finalBytes.startsWith(initialBytes)).toBe(true);
    const readback = new FileSupportTicketStore(filePath);
    expect(await readback.get(original.ticket.id)).toEqual(original.ticket);
    expect(await readback.get(accepted.ticket.id)).toEqual(accepted.ticket);
    expect(await fs.readFile(filePath, "utf8")).toBe(finalBytes);
  });

  it("recovers a receipt on retry after a rejected append left partial bytes", async () => {
    const filePath = await temporaryStorePath();
    let random = 0;
    const store = new FileSupportTicketStore(filePath, { random: () => (random += 0.1) });
    const original = await store.create(base, { clientKey: "a" });
    const input = {
      ...base,
      description: "A different support request.",
      idempotency_key: "partial-write-retry",
    };
    const appendFile = fs.appendFile.bind(fs);
    let attemptedTicket;
    vi.spyOn(fs, "appendFile").mockImplementationOnce(async (file, data, encoding) => {
      attemptedTicket = JSON.parse(data);
      await appendFile(file, data.slice(0, 30), encoding);
      throw Object.assign(new Error("append interrupted after partial write"), { code: "EIO" });
    });

    await expect(store.create(input, { clientKey: "a" })).rejects.toMatchObject({ code: "EIO" });
    expect(await store.get(attemptedTicket.id)).toBeNull();
    const partialBytes = await fs.readFile(filePath, "utf8");
    const recovered = await store.create(input, { clientKey: "a" });

    expect(recovered.duplicate).toBe(false);
    expect(recovered.ticket.id).not.toBe(attemptedTicket.id);
    const finalBytes = await fs.readFile(filePath, "utf8");
    expect(finalBytes.startsWith(partialBytes)).toBe(true);
    const readback = new FileSupportTicketStore(filePath);
    expect(await readback.get(original.ticket.id)).toEqual(original.ticket);
    expect(await readback.get(recovered.ticket.id)).toEqual(recovered.ticket);
    expect(await readback.get(attemptedTicket.id)).toBeNull();
    expect(await readback.create(input, { clientKey: "a" })).toEqual({
      ticket: recovered.ticket,
      duplicate: true,
    });
    expect(await fs.readFile(filePath, "utf8")).toBe(finalBytes);
  });

  it.each([null, "new-form-key"])(
    "reloads duplicate content without the original form key (%s)",
    async (idempotencyKey) => {
      const filePath = await temporaryStorePath();
      const createdAt = 1_000_000;
      const writer = new FileSupportTicketStore(filePath, {
        now: () => createdAt,
        random: () => 0.1,
      });
      const first = await writer.create(
        { ...base, idempotency_key: "original-form-key" },
        { clientKey: "a" },
      );
      const restarted = new FileSupportTicketStore(filePath, {
        now: () => createdAt + DUPLICATE_WINDOW_MS - 1,
        random: () => 0.2,
      });

      const retry = await restarted.create(
        { ...base, idempotency_key: idempotencyKey },
        { clientKey: "a" },
      );

      expect(retry.duplicate).toBe(true);
      expect(retry.ticket).toEqual(first.ticket);
      const rows = (await fs.readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse);
      expect(rows.filter((row) => row.id)).toEqual([first.ticket]);
      expect(rows).toHaveLength(idempotencyKey ? 2 : 1);
      if (idempotencyKey) {
        expect(rows[1]).toMatchObject({
          record_type: "idempotency_alias",
          idempotency_key: idempotencyKey,
          ticket_id: first.ticket.id,
        });
      }
    },
  );

  it("reloads normalized duplicate identity across casing and whitespace changes", async () => {
    const filePath = await temporaryStorePath();
    const writer = new FileSupportTicketStore(filePath, {
      now: () => 1_000_000,
      random: () => 0.1,
    });
    const first = await writer.create(base, { clientKey: "a" });
    const restarted = new FileSupportTicketStore(filePath, {
      now: () => 1_001_000,
      random: () => 0.2,
    });

    const retry = await restarted.create(
      {
        ...base,
        email: base.email.toUpperCase(),
        description: base.description.toUpperCase().replace(/\s+/g, "  "),
      },
      { clientKey: "a" },
    );

    expect(retry.duplicate).toBe(true);
    expect(retry.ticket).toEqual(first.ticket);
    expect((await fs.readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it.each([0, 1])("does not renew the duplicate window on restart (expiry + %i ms)", async (offset) => {
    const filePath = await temporaryStorePath();
    const createdAt = 1_000_000;
    const writer = new FileSupportTicketStore(filePath, {
      now: () => createdAt,
      random: () => 0.1,
    });
    const first = await writer.create(base, { clientKey: "a" });
    const restarted = new FileSupportTicketStore(filePath, {
      now: () => createdAt + DUPLICATE_WINDOW_MS + offset,
      random: () => 0.2,
    });

    const retry = await restarted.create(base, { clientKey: "a" });

    expect(retry.duplicate).toBe(false);
    expect(retry.ticket.id).not.toBe(first.ticket.id);
    expect(retry.ticket.created_at).toBe(createdAt + DUPLICATE_WINDOW_MS + offset);
    expect((await fs.readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("reloads the latest accepted receipt for repeated content", async () => {
    const filePath = await temporaryStorePath();
    let now = 1_000_000;
    let random = 0.1;
    const writer = new FileSupportTicketStore(filePath, {
      now: () => now,
      random: () => (random += 0.1),
    });
    const first = await writer.create(base, { clientKey: "a" });
    now += DUPLICATE_WINDOW_MS;
    const latest = await writer.create(base, { clientKey: "a" });
    expect(latest.duplicate).toBe(false);
    expect(latest.ticket.id).not.toBe(first.ticket.id);
    const restarted = new FileSupportTicketStore(filePath, {
      now: () => now + 1_000,
      random: () => 0.4,
    });

    const retry = await restarted.create(base, { clientKey: "a" });

    expect(retry.duplicate).toBe(true);
    expect(retry.ticket).toEqual(latest.ticket);
    expect((await fs.readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  it("retains explicit idempotency after the content window expires on restart", async () => {
    const filePath = await temporaryStorePath();
    const input = { ...base, idempotency_key: "original-form-key" };
    const writer = new FileSupportTicketStore(filePath, {
      now: () => 1_000_000,
      random: () => 0.1,
    });
    const first = await writer.create(input, { clientKey: "a" });
    const restarted = new FileSupportTicketStore(filePath, {
      now: () => 1_000_000 + DUPLICATE_WINDOW_MS + 1,
      random: () => 0.2,
    });

    const retry = await restarted.create(input, { clientKey: "a" });

    expect(retry.duplicate).toBe(true);
    expect(retry.ticket).toEqual(first.ticket);
    expect((await fs.readFile(filePath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("persists distinct ticket content when short fingerprints would collide", async () => {
    const filePath = await temporaryStorePath();
    let random = 0.1;
    const store = new FileSupportTicketStore(filePath, {
      random: () => (random += 0.1),
    });
    const firstInput = {
      ...base,
      description: "Please check reference a~.",
      idempotency_key: "separate-form-a",
    };
    const secondInput = {
      ...base,
      description: "Please check reference b_.",
      idempotency_key: "separate-form-b",
    };

    const first = await store.create(firstInput, { clientKey: "a" });
    const second = await store.create(secondInput, { clientKey: "a" });

    expect(second.duplicate).toBe(false);
    expect(second.ticket.id).not.toBe(first.ticket.id);
    const rows = (await fs.readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    expect(rows.map((row) => row.description)).toEqual([
      firstInput.description,
      secondInput.description,
    ]);
    const restarted = new FileSupportTicketStore(filePath);
    expect(await restarted.get(first.ticket.id)).toEqual(first.ticket);
    expect(await restarted.get(second.ticket.id)).toEqual(second.ticket);
  });

  it("keeps case and whitespace equivalent submissions as duplicates", async () => {
    const filePath = await temporaryStorePath();
    const store = new FileSupportTicketStore(filePath);
    const first = await store.create(
      { ...base, idempotency_key: "normalized-first" },
      { clientKey: "a" },
    );
    const second = await store.create(
      {
        ...base,
        email: base.email.toUpperCase(),
        description: base.description.toUpperCase().replace(/\s+/g, "  "),
        idempotency_key: "normalized-retry",
      },
      { clientKey: "a" },
    );

    expect(second.duplicate).toBe(true);
    expect(second.ticket.id).toBe(first.ticket.id);
    const rows = (await fs.readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse);
    expect(rows.filter((row) => row.id)).toEqual([first.ticket]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      record_type: "idempotency_alias",
      idempotency_key: "normalized-retry",
      ticket_id: first.ticket.id,
    });
  });

  it.each(["form-retry", null])(
    "does not accept a failed append on retry (idempotency key: %s)",
    async (idempotencyKey) => {
      const filePath = await temporaryStorePath();
      const store = new FileSupportTicketStore(filePath);
      const input = { ...base, idempotency_key: idempotencyKey };
      await store.ensureLoaded();
      await fs.mkdir(filePath);

      await expect(store.create(input, { clientKey: "a" })).rejects.toThrow();
      await expect(store.create(input, { clientKey: "a" })).rejects.toThrow();

      await fs.rmdir(filePath);
      const recovered = await store.create(input, { clientKey: "a" });
      expect(recovered.duplicate).toBe(false);
      const restarted = new FileSupportTicketStore(filePath);
      expect(await restarted.get(recovered.ticket.id)).toEqual(recovered.ticket);
      const rows = (await fs.readFile(filePath, "utf8")).trim().split("\n");
      expect(rows).toHaveLength(1);
    },
  );

  it("makes a concurrent duplicate wait for the persisted receipt", async () => {
    const filePath = await temporaryStorePath();
    const store = new FileSupportTicketStore(filePath);
    const input = { ...base, idempotency_key: "concurrent-form" };
    const appendStarted = deferred();
    const releaseAppend = deferred();
    const appendFile = fs.appendFile.bind(fs);
    vi.spyOn(fs, "appendFile").mockImplementationOnce(async (...args) => {
      appendStarted.resolve();
      await releaseAppend.promise;
      return appendFile(...args);
    });

    const first = store.create(input, { clientKey: "a" });
    await appendStarted.promise;
    let duplicateCompleted = false;
    const second = store.create(input, { clientKey: "a" }).then((result) => {
      duplicateCompleted = true;
      return result;
    });
    await nextTurn();
    const completedBeforePersistence = duplicateCompleted;
    releaseAppend.resolve();
    const [created, duplicate] = await Promise.all([first, second]);

    expect(completedBeforePersistence).toBe(false);
    expect(created.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.ticket.id).toBe(created.ticket.id);
    const rows = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(rows).toHaveLength(1);
  });

  it("loads existing receipts before a concurrent startup retry", async () => {
    const filePath = await temporaryStorePath();
    const input = { ...base, idempotency_key: "existing-form" };
    const seedStore = new FileSupportTicketStore(filePath, { random: () => 0.1 });
    const existing = await seedStore.create(input, { clientKey: "a" });
    const store = new FileSupportTicketStore(filePath, { random: () => 0.2 });
    const readStarted = deferred();
    const releaseRead = deferred();
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
      readStarted.resolve();
      await releaseRead.promise;
      return readFile(...args);
    });

    const loading = store.get(existing.ticket.id);
    await readStarted.promise;
    let retryCompleted = false;
    const retry = store.create(input, { clientKey: "a" }).then((result) => {
      retryCompleted = true;
      return result;
    });
    await nextTurn();
    const completedBeforeLoad = retryCompleted;
    releaseRead.resolve();
    const [loaded, retried] = await Promise.all([loading, retry]);

    expect(completedBeforeLoad).toBe(false);
    expect(loaded).toEqual(existing.ticket);
    expect(retried.duplicate).toBe(true);
    expect(retried.ticket.id).toBe(existing.ticket.id);
    const rows = (await fs.readFile(filePath, "utf8")).trim().split("\n");
    expect(rows).toHaveLength(1);
  });

  it("shares a failed initial read and retries after storage recovers", async () => {
    const filePath = await temporaryStorePath();
    await fs.mkdir(filePath);
    const store = new FileSupportTicketStore(filePath);
    const initial = await Promise.allSettled([store.get("missing"), store.get("missing")]);

    await fs.rmdir(filePath);
    const writer = new FileSupportTicketStore(filePath);
    const accepted = await writer.create(base, { clientKey: "a" });
    const recovered = await store.get(accepted.ticket.id);

    expect(initial.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(recovered).toEqual(accepted.ticket);
  });
});
