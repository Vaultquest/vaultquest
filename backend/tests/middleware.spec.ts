import { describe, it, expect } from "vitest";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import correlation from "../src/middleware/correlation.js";
import { requireServiceAuth } from "../src/middleware/service-auth.js";

describe("correlation middleware", () => {
  it("generates a correlation id when none provided", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["correlation-id"]).toBeDefined();
    expect(res.json().id).toBe(res.headers["correlation-id"]);
    await app.close();
  });

  it("echoes an incoming correlation id", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "correlation-id": "abc-123" }
    });
    expect(res.headers["correlation-id"]).toBe("abc-123");
    await app.close();
  });

  it("echoes a valid UUID unchanged", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const uuid = "5c1f8b9e-6f8a-4b34-9e2a-8a2c4f9d1b3e";
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "correlation-id": uuid }
    });
    expect(res.headers["correlation-id"]).toBe(uuid);
    await app.close();
  });

  it("replaces an empty correlation id with a generated one", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "correlation-id": "" }
    });
    expect(res.headers["correlation-id"]).toBeTruthy();
    expect(res.headers["correlation-id"]).not.toBe("");
    await app.close();
  });

  it("replaces an oversized correlation id with a generated one", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const oversized = "a".repeat(200);
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "correlation-id": oversized }
    });
    expect(res.headers["correlation-id"]).not.toBe(oversized);
    expect((res.headers["correlation-id"] as string).length).toBeLessThan(200);
    await app.close();
  });

  it("replaces a correlation id containing CR/LF with a generated one", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "correlation-id": "abc\r\nX-Injected: evil" }
    });
    expect(res.headers["correlation-id"]).not.toContain("\r");
    expect(res.headers["correlation-id"]).not.toContain("\n");
    await app.close();
  });

  it("replaces a correlation id containing unicode control characters with a generated one", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "correlation-id": "abc\u2028def" }
    });
    expect(res.headers["correlation-id"]).not.toBe("abc\u2028def");
    await app.close();
  });

  it("replaces a multi-value correlation id header with a generated one", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "correlation-id": ["first-id", "second-id"] as unknown as string }
    });
    expect(res.headers["correlation-id"]).not.toBe("first-id");
    expect(res.headers["correlation-id"]).not.toBe("second-id");
    await app.close();
  });
});

describe("service-auth middleware", () => {
  it("rejects missing secret", async () => {
    const app = Fastify();
    const guard = requireServiceAuth("top-secret");
    app.post("/internal", { preHandler: guard }, async () => ({ ok: true }));
    app.setErrorHandler((err: Error, _req: FastifyRequest, reply: FastifyReply) => {
      if (err.name === "AppError") {
        reply.status((err as unknown as { statusCode: number }).statusCode).send({ error: err.message });
        return;
      }
      reply.status(500).send({ error: "x" });
    });
    const res = await app.inject({ method: "POST", url: "/internal" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts correct secret", async () => {
    const app = Fastify();
    const guard = requireServiceAuth("top-secret");
    app.post("/internal", { preHandler: guard }, async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/internal",
      headers: { "x-internal-secret": "top-secret" }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
