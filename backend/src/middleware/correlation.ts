import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { randomUUID } from "node:crypto";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * What a caller-supplied correlation id may contain: ASCII letters, digits, dash, underscore,
 * and dot, bounded to a length no header parser or log sink chokes on. This excludes control
 * characters (including CR/LF) and non-ASCII input, and a single regex test on a non-array
 * value also rejects multi-value headers, which Node exposes as an array.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9_.-]{1,128}$/;

function sanitizeCorrelationId(header: string | string[] | undefined): string {
  return typeof header === "string" && SAFE_CORRELATION_ID.test(header) ? header : randomUUID();
}

const plugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const id = sanitizeCorrelationId(req.headers["correlation-id"]);
    req.correlationId = id;
    reply.header("Correlation-Id", id);
    req.log = req.log.child({ correlation_id: id });
  });
};

export default fp(plugin, { name: "correlation" });
