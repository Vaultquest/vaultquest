import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";

export interface CorsSecurityOptions {
  /** Comma-separated list of allowed origins. Empty string disables cross-origin requests. */
  allowedOrigins?: string;
  /** When true, HSTS and other production-only headers are emitted. */
  isProduction?: boolean;
}

const DEFAULT_ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type, Authorization, X-Api-Key, X-Csrf-Token, Idempotency-Key";

function parseOrigins(allowedOrigins?: string): string[] {
  if (!allowedOrigins) return [];
  return allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

function isOriginAllowed(origin: string, allowed: string[]): boolean {
  return allowed.includes(origin);
}

const corsSecurity: FastifyPluginAsync<CorsSecurityOptions> = async (app, opts) => {
  const allowed = parseOrigins(opts.allowedOrigins);
  const isProduction = opts.isProduction ?? false;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin as string | undefined;

    if (origin && isOriginAllowed(origin, allowed)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      reply.header("Access-Control-Allow-Methods", DEFAULT_ALLOWED_METHODS);
      reply.header("Access-Control-Allow-Headers", DEFAULT_ALLOWED_HEADERS);
      reply.header("Access-Control-Max-Age", "86400");
      reply.code(204).send();
      return;
    }
  });

  app.addHook("onSend", async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Cache-Control", "no-store, max-age=0");

    if (isProduction) {
      reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    }
  });
};

export default fp(corsSecurity, { name: "corsSecurity" });
