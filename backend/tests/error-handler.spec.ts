import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../src/errors.js";
import { ERROR_CODES } from "../src/constants.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import correlation from "../src/middleware/correlation.js";
import { createLogger } from "../src/logger.js";

/**
 * Issue #131: the error envelope is public. Whatever a route constructs as an
 * error - an AppError with internal `detail`, a native Fastify error, a
 * Prisma/provider failure, a validation error - only the safe, schema-checked
 * view of it may reach the caller. The full picture stays under the error ID
 * in the log for investigation.
 */

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

async function buildApp(logger?: ReturnType<typeof createLogger>): Promise<FastifyInstance> {
  const app = Fastify({ logger: (logger ?? false) as never });
  await app.register(correlation);
  app.setErrorHandler(errorHandler);
  await app.ready();
  return app;
}

describe("error handler public/private separation (issue #131)", () => {
  it("drops an AppError detail that fails the public schema, keeping it in the log", async () => {
    const { destination, captured } = createCapture();
    const app = await buildApp(createLogger("debug", destination));
    app.get("/boom", async () => {
      throw new AppError(
        ERROR_CODES.INVALID_PAYLOAD,
        400,
        "payload rejected",
        "PRIVATE_SQL\nSELECT * FROM secrets;\napi_key=sk_live_X"
      );
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("INVALID_PAYLOAD");
    expect(body.error.message).toBe("payload rejected");
    expect(typeof body.error.error_id).toBe("string");
    expect(body.error.details).toBeUndefined();
    expect(res.body).not.toContain("PRIVATE_SQL");
    expect(res.body).not.toContain("sk_live_X");

    const errorLine = captured.lines.find((line) => line.level === 50 && line.error_type === "AppError");
    expect(errorLine?.error_id).toBe(body.error.error_id);
    expect(String(errorLine?.detail)).toContain("PRIVATE_SQL");
    await app.close();
  });

  it("drops a public detail whose object key is secret-like", async () => {
    const app = await buildApp();
    app.get("/boom", async () => {
      throw new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, "rejected", {
        token: "sk_live_Z",
        reason: "unacceptable"
      });
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.message).toBe("rejected");
    expect(body.error.details).toBeUndefined();
    expect(res.body).not.toContain("sk_live_Z");
    await app.close();
  });

  it("keeps a schema-valid public detail", async () => {
    const app = await buildApp();
    app.get("/boom", async () => {
      throw new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, "rejected", {
        quarantined: true,
        reason: "legacy payload could not be migrated"
      });
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.details).toEqual({
      quarantined: true,
      reason: "legacy payload could not be migrated"
    });
    await app.close();
  });

  it("logs AppError logContext privately and never returns it", async () => {
    const { destination, captured } = createCapture();
    const app = await buildApp(createLogger("debug", destination));
    app.get("/boom", async () => {
      throw new AppError(
        ERROR_CODES.INVALID_PAYLOAD,
        400,
        "rejected",
        undefined,
        { actionId: "act_123", query: "SELECT * FROM users" }
      );
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    const body = res.json();
    expect(res.body).not.toContain("act_123");
    expect(res.body).not.toContain("SELECT * FROM users");
    expect(body.error.details).toBeUndefined();

    const errorLine = captured.lines.find((line) => line.level === 50 && line.error_type === "AppError");
    expect(errorLine?.log_context).toEqual({ actionId: "act_123", query: "SELECT * FROM users" });
    await app.close();
  });

  it("sanitizes control characters out of an AppError message", async () => {
    const app = await buildApp();
    app.get("/boom", async () => {
      throw new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, "bad\nX-Injected: evil\r\npayload");
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    const body = res.json();
    expect(body.error.message).toBe("badX-Injected: evilpayload");
    expect(body.error.message).not.toContain("\n");
    expect(body.error.message).not.toContain("\r");
    await app.close();
  });

  it("keeps the envelope error_id aligned with an incoming correlation id", async () => {
    const app = await buildApp();
    app.get("/boom", async () => {
      throw new AppError(ERROR_CODES.FORBIDDEN, 403, "forbidden");
    });

    const res = await app.inject({
      method: "GET",
      url: "/boom",
      headers: { "correlation-id": "corr-131" }
    });
    const body = res.json();
    expect(body.error.error_id).toBe("corr-131");
    await app.close();
  });

  it("never echoes a native Fastify 404 message or path", async () => {
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/no/such/GABC1234567890ABC?wallet=GABC" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("FST_ERR_NOT_FOUND");
    expect(body.error.message).toBe("Not found");
    expect(typeof body.error.error_id).toBe("string");
    expect(res.body).not.toContain("/no/such/GABC1234567890ABC");
    await app.close();
  });
});

describe("error handler: unexpected/provider/Prisma errors stay generic", () => {
  it("does not echo a provider error's message even when it tags an HTTP status", async () => {
    const { destination, captured } = createCapture();
    const app = await buildApp(createLogger("debug", destination));
    app.get("/upstream", async () => {
      const err = new Error(
        "HorizonProvider: failed SELECT * FROM users; Authorization=Bearer abc123"
      ) as Error & { statusCode: number; code: string };
      err.statusCode = 502;
      err.code = "UPSTREAM_ERROR";
      throw err;
    });

    const res = await app.inject({ method: "GET", url: "/upstream" });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.code).toBe("UPSTREAM_ERROR");
    expect(body.error.message).toBe("Bad gateway");
    expect(res.body).not.toContain("HorizonProvider");
    expect(res.body).not.toContain("SELECT * FROM users");
    expect(res.body).not.toContain("Bearer abc123");

    const errorLine = captured.lines.find((line) => line.level === 50 && line.error_type === "UNEXPECTED");
    expect(errorLine?.error_id).toBe(body.error.error_id);
    expect(captured.raw).toContain("HorizonProvider");
    await app.close();
  });

  it("returns a generic 500 for an unexpected error and logs the internal detail", async () => {
    const { destination, captured } = createCapture();
    const app = await buildApp(createLogger("debug", destination));
    app.get("/crash", async () => {
      throw new Error("postgres://user:pass@internal-db:5432/vaultquest?sslmode=require");
    });

    const res = await app.inject({ method: "GET", url: "/crash" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("An internal server error occurred");
    expect(res.body).not.toContain("postgres://");

    const errorLine = captured.lines.find((line) => line.level === 50 && line.error_type === "UNEXPECTED");
    expect(errorLine?.error_id).toBe(body.error.error_id);
    expect(captured.raw).toContain("postgres://user:pass@internal-db");
    await app.close();
  });

  it("maps Prisma unique-constraint and miss failures to generic public messages", async () => {
    const app = await buildApp();
    app.get("/p2002", async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`email`)",
        { code: "P2002", clientVersion: "5.22.0" }
      );
    });
    app.get("/p2025", async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "An operation failed because it depends on one or more records that were required but not found.",
        { code: "P2025", clientVersion: "5.22.0" }
      );
    });

    const conflict = await app.inject({ method: "GET", url: "/p2002" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("CONFLICT");
    expect(conflict.json().error.message).toBe("A database conflict occurred (unique constraint violation)");
    expect(conflict.body).not.toContain("(`email`)");

    const missing = await app.inject({ method: "GET", url: "/p2025" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
    expect(missing.json().error.message).toBe("The requested database record was not found");
    await app.close();
  });

  it("never exposes the message of an unknown Prisma code or a Prisma validation error", async () => {
    const app = await buildApp();
    app.get("/p9999", async () => {
      throw new Prisma.PrismaClientKnownRequestError(
        "SELECT * FROM users WHERE admin=true",
        { code: "P9999", clientVersion: "5.22.0", meta: {} }
      );
    });
    app.get("/pvalidation", async () => {
      throw new Prisma.PrismaClientValidationError(
        "Invalid `prisma.actionLedger.create()` invocation:\n\nUnknown argument `secret`",
        { clientVersion: "5.22.0" }
      );
    });

    const unknown = await app.inject({ method: "GET", url: "/p9999" });
    expect(unknown.statusCode).toBe(500);
    expect(unknown.json().error.code).toBe("DATABASE_ERROR");
    expect(unknown.json().error.message).toBe("A database error occurred");
    expect(unknown.body).not.toContain("SELECT * FROM users");

    const invalid = await app.inject({ method: "GET", url: "/pvalidation" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_PAYLOAD");
    expect(invalid.json().error.message).toBe("Database validation failed");
    expect(invalid.body).not.toContain("Unknown argument `secret`");
    await app.close();
  });

  it("treats a Prisma-shaped unexpected error as a generic database error", async () => {
    class PrismaUnknownError extends Error {}
    const app = await buildApp();
    app.get("/plike", async () => {
      throw new PrismaUnknownError("internal prisma context leaked; SELECT * FROM vault");
    });

    const res = await app.inject({ method: "GET", url: "/plike" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("DATABASE_ERROR");
    expect(body.error.message).toBe("An internal database error occurred");
    expect(res.body).not.toContain("SELECT * FROM vault");
    await app.close();
  });
});

describe("error handler: validation errors return known-validator paths only", () => {
  it("drops received/expected values from a ZodError while keeping path and code", async () => {
    const { destination, captured } = createCapture();
    const app = await buildApp(createLogger("debug", destination));
    app.get("/validate", async () => {
      z.object({ wallet: z.string().regex(/^G[A-Z0-9]{55}$/) }).parse({
        wallet: "GADR-secret-wallet-value"
      });
    });

    const res = await app.inject({ method: "GET", url: "/validate" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("INVALID_PAYLOAD");
    expect(body.error.message).toBe("validation failed");
    expect(body.error.issues[0]).toMatchObject({ code: "invalid_string", path: "wallet" });
    expect(body.error.issues[0].received).toBeUndefined();
    expect(body.error.issues[0].expected).toBeUndefined();
    expect(res.body).not.toContain("GADR-secret-wallet-value");

    const errorLine = captured.lines.find((line) => line.level === 50 && line.error_type === "ZodError");
    expect(errorLine?.error_id).toBe(body.error.error_id);
    expect(errorLine?.issues).toEqual([{ code: "invalid_string", path: "wallet" }]);
    expect(captured.raw).not.toContain("GADR-secret-wallet-value");
    await app.close();
  });
});