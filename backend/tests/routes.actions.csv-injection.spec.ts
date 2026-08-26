import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestWallet } from "./helpers/wallet.js";

/**
 * Endpoint-level CSV formula injection test (issue #95).
 *
 * The vulnerability: `GET /actions/export?format=csv` mapped arbitrary
 * `actionPayload` fields (vault id, amount, token) straight into CSV cells,
 * only doubling quotes -- never neutralizing a leading `=`, `+`, `-`, or `@`.
 * A submitted action could therefore smuggle a formula into an operator's
 * or user's spreadsheet export. This test proves the fix at the HTTP
 * boundary, not just at the encoder-unit level.
 */

const INTERNAL_SECRET = "test-internal-secret-123456";

function getMockPrisma(rowsByWallet: Record<string, unknown[]> = {}) {
  return {
    actionLedger: {
      findMany: vi.fn().mockImplementation(async (args: { where?: { walletAddress?: string } }) => {
        const wallet = args?.where?.walletAddress ?? "";
        return (rowsByWallet[wallet] ?? []) as unknown[];
      }),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
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
  } as unknown as PrismaClient & { actionLedger: { findMany: ReturnType<typeof vi.fn> } };
}

function actionRow(walletAddress: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    walletAddress,
    actionType: "deposit",
    actionPayload: { vault_id: "v_usdc", amount: "100", token: "USDC" },
    status: "confirmed",
    txHash: "tx_abc123",
    sorobanEventId: null,
    correlationId: null,
    errorCode: null,
    errorDetail: null,
    retryCount: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    submittedAt: new Date("2026-01-01T00:00:00Z"),
    confirmedAt: new Date("2026-01-01T00:00:00Z"),
    redactedAt: null,
    ...overrides
  };
}

let ipCounter = 1;
function get(app: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: "GET", url, remoteAddress: `192.168.201.${ipCounter++ % 254}`, headers });
}

/** Splits a CSV export body into cells, tolerant of quoted commas/newlines. */
function parseCsv(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (inQuotes) {
      if (char === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe("GET /actions/export CSV formula injection (#95)", () => {
  const maliciousPayloads = [
    ["=", { vault_id: "=cmd|' /C calc'!A0", amount: "100", token: "USDC" }, 3],
    ["+", { vault_id: "v_usdc", amount: "+1+1", token: "USDC" }, 4],
    ["-", { vault_id: "v_usdc", amount: "100", token: "-2+3+cmd|' /C calc'!A0" }, 5],
    ["@", { vault_id: "@SUM(1+1)", amount: "100", token: "USDC" }, 3]
  ] as const;

  it.each(maliciousPayloads)(
    "neutralizes a %s-prefixed field so it cannot execute as a formula in the exported CSV",
    async (_char, payload, cellIndex) => {
      const wallet = createTestWallet();
      const prisma = getMockPrisma({
        [wallet.address]: [actionRow(wallet.address, { actionPayload: payload })]
      });
      const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET });

      const res = await get(
        app,
        `/actions/export?wallet=${wallet.address}&format=csv`,
        wallet.authHeaders()
      );

      expect(res.statusCode).toBe(200);
      const rows = parseCsv(res.body.trim());
      const dataRow = rows[1];
      expect(dataRow).toBeDefined();
      const cell = dataRow![cellIndex]!;

      // The decisive assertion: the cell content, once unquoted, must not
      // begin with a character a spreadsheet would evaluate as a formula.
      expect(["=", "+", "-", "@"]).not.toContain(cell.charAt(0));
      expect(cell.charAt(0)).toBe("'");

      await app.close();
    }
  );

  it("leaves a normal export untouched (no spurious guard on safe data)", async () => {
    const wallet = createTestWallet();
    const prisma = getMockPrisma({
      [wallet.address]: [actionRow(wallet.address, { actionPayload: { vault_id: "v_usdc", amount: "100", token: "USDC" } })]
    });
    const app = buildApp({ prisma, internalSecret: INTERNAL_SECRET });

    const res = await get(app, `/actions/export?wallet=${wallet.address}&format=csv`, wallet.authHeaders());

    expect(res.statusCode).toBe(200);
    const rows = parseCsv(res.body.trim());
    expect(rows[1]).toEqual([
      expect.any(String),
      expect.any(String),
      "deposit",
      "v_usdc",
      "100",
      "USDC",
      "confirmed",
      "tx_abc123",
      "",
      expect.any(String),
      expect.any(String)
    ]);

    await app.close();
  });
});
