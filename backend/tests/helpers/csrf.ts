import type { FastifyInstance, InjectOptions } from "fastify";

/**
 * Fetches a CSRF token + cookie for a state-changing request. The backend
 * enforces CSRF on all POST/PATCH/DELETE routes (see middleware/rateLimiter.ts),
 * so route tests must present a matching token pair.
 */
export async function csrfHeaders(
  app: FastifyInstance,
  ip = "127.0.0.1"
): Promise<Record<string, string>> {
  const res = await app.inject({ method: "GET", url: "/health", remoteAddress: ip });
  const token = res.headers["x-csrf-token"] as string;
  const cookie = res.headers["set-cookie"] as string;
  return { "x-csrf-token": token, cookie };
}

let ipCounter = 1;

/**
 * Injects a state-changing request from a fresh IP with matching CSRF headers.
 * A unique IP per request also avoids tripping the per-IP sensitive-route rate
 * limit (10 per window) shared across tests in a file.
 */
export async function injectWithCsrf(
  app: FastifyInstance,
  method: NonNullable<InjectOptions["method"]>,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {}
) {
  const remoteAddress = `192.168.50.${ipCounter++}`;
  const csrf = await csrfHeaders(app, remoteAddress);
  const opts: InjectOptions = {
    method,
    url,
    remoteAddress,
    headers: { ...csrf, ...headers }
  };
  if (payload !== undefined) {
    opts.payload = payload as InjectOptions["payload"];
  }
  return app.inject(opts);
}
