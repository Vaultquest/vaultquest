import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import { hashIdentifier, REDACTED } from "../src/utils/logRedaction.js";

/**
 * Capture-log tests for issue #105: whatever a caller puts in a query string,
 * the log stream must never contain it verbatim.
 */

const WALLET = "GA" + "B".repeat(54);
const CURSOR = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const SECRET = "sk-live-super-secret-value-0123456789";

type Captured = { lines: Record<string, unknown>[]; raw: string };

function createCapture(): { destination: Writable; captured: Captured } {
  const captured: Captured = { lines: [], raw: "" };
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString();
      captured.raw += text;
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          captured.lines.push(JSON.parse(line));
        } catch {
          // pino always emits NDJSON here; ignore anything else.
        }
      }
      callback();
    }
  });
  return { destination, captured };
}

function getMockPrisma() {
  return {
    actionLedger: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([])
    },
    savedPool: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0)
    },
    indexerCheckpoint: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "singleton" })
    }
  } as never;
}

describe("request log redaction (issue #105)", () => {
  let app: FastifyInstance;
  let captured: Captured;

  beforeEach(async () => {
    const capture = createCapture();
    captured = capture.captured;
    app = buildApp({
      prisma: getMockPrisma(),
      internalSecret: "test-internal-secret-123456",
      logger: createLogger("debug", capture.destination)
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const requestLines = () =>
    captured.lines.filter(
      (line) => line.event === "request_incoming" || line.event === "request_completed"
    );

  it("logs a route template and hashed identifiers instead of the raw URL", async () => {
    await app.inject({
      method: "GET",
      url: `/actions?wallet=${WALLET}&cursor=${CURSOR}&limit=10&status=confirmed`
    });

    const lines = requestLines();
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      expect(line.route).toBe("/actions");
      expect(line.method).toBe("GET");
      expect(line.url).toBeUndefined();
      expect(line.query).toEqual({
        wallet: hashIdentifier(WALLET),
        cursor: hashIdentifier(CURSOR),
        limit: "10",
        status: "confirmed"
      });
    }

    expect(captured.raw).not.toContain(WALLET);
    expect(captured.raw).not.toContain(CURSOR);
    expect(captured.raw).not.toContain("?wallet=");
  });

  it("keeps correlation ids and status codes usable for debugging", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/actions?wallet=${WALLET}`,
      headers: { "correlation-id": "corr-123" }
    });

    const completed = requestLines().find((line) => line.event === "request_completed");
    expect(completed?.correlation_id).toBe("corr-123");
    expect(completed?.status_code).toBe(res.statusCode);
    expect(typeof completed?.duration_ms).toBe("number");
  });

  it("redacts secret-like query keys without hashing them", async () => {
    await app.inject({ method: "GET", url: `/health?api_key=${SECRET}&signature=${SECRET}` });

    for (const line of requestLines()) {
      expect(line.query).toEqual({ api_key: REDACTED, signature: REDACTED });
    }
    expect(captured.raw).not.toContain(SECRET);
    expect(captured.raw).not.toContain(hashIdentifier(SECRET));
  });

  it("redacts percent-encoded and repeated query values", async () => {
    const encoded = encodeURIComponent(WALLET);
    await app.inject({
      method: "GET",
      url: `/actions?wallet=${encoded}&wallet=${encoded}&unknown=${encoded}`
    });

    for (const line of requestLines()) {
      const query = line.query as Record<string, string>;
      expect(query.unknown).toBe(REDACTED);
      expect(query.wallet).toMatch(/^sha256:[0-9a-f]{12}$/);
    }
    expect(captured.raw).not.toContain(WALLET);
    expect(captured.raw).not.toContain(encoded);
  });

  it("neutralizes log-forging attempts in query values", async () => {
    await app.inject({
      method: "GET",
      url: `/health?status=${encodeURIComponent('ok"}\n{"event":"forged')}`
    });

    expect(captured.raw).not.toContain('"event":"forged"');
    for (const line of requestLines()) {
      expect((line.query as Record<string, string>).status).toBe('ok"}{"event":"forged');
    }
  });

  it("redacts on the not-found path, where no route template exists", async () => {
    await app.inject({ method: "GET", url: `/no/such/${WALLET}?wallet=${WALLET}` });

    for (const line of requestLines()) {
      expect(line.route).toBe("/no/such/:wallet");
      expect(line.query).toEqual({ wallet: hashIdentifier(WALLET) });
    }
    expect(captured.raw).not.toContain(WALLET);
  });

  it("redacts on the validation-error path", async () => {
    const res = await app.inject({ method: "GET", url: `/portfolio/summary?wallet=not-a-wallet` });

    expect(res.statusCode).toBe(400);
    const errorLine = captured.lines.find((line) => line.level === 50);
    expect(errorLine).toBeDefined();
    expect(errorLine?.route).toBe("/portfolio/summary");
    expect(errorLine?.error_type).toBe("ZodError");
    expect(errorLine?.issues).toEqual([{ code: "invalid_string", path: "wallet" }]);
    expect(captured.raw).not.toContain("not-a-wallet");
  });

  it("redacts on the internal-error path", async () => {
    const prisma = getMockPrisma() as unknown as {
      actionLedger: { findMany: ReturnType<typeof vi.fn> };
    };
    prisma.actionLedger.findMany.mockRejectedValue(new Error("boom"));

    const capture = createCapture();
    const errorApp = buildApp({
      prisma: prisma as never,
      internalSecret: "test-internal-secret-123456",
      logger: createLogger("debug", capture.destination)
    });
    await errorApp.ready();

    const res = await errorApp.inject({ method: "GET", url: `/actions?wallet=${WALLET}&limit=5` });
    expect(res.statusCode).toBe(500);

    const errorLine = capture.captured.lines.find((line) => line.level === 50);
    expect(errorLine?.route).toBe("/actions");
    expect(errorLine?.query).toEqual({ wallet: hashIdentifier(WALLET), limit: "5" });
    expect(capture.captured.raw).not.toContain(WALLET);

    await errorApp.close();
  });

  it("redacts a raw url even when a log statement bypasses the helpers", () => {
    const capture = createCapture();
    const logger = createLogger("info", capture.destination);

    logger.info({ url: `/actions?wallet=${WALLET}`, wallet: WALLET, cursor: CURSOR }, "legacy call site");

    expect(capture.captured.raw).not.toContain(WALLET);
    expect(capture.captured.raw).not.toContain(CURSOR);
    expect(capture.captured.lines[0]?.url).toBe(REDACTED);
    expect(capture.captured.lines[0]?.wallet).toBe(REDACTED);
  });
});
