import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { timingSafeEqual } from "./internal-secret.js";

/**
 * Fastify preHandler that enforces API key authentication for external-service
 * endpoints (issue #273).
 *
 * The key is read from the `X-Api-Key` request header and compared in constant
 * time to prevent timing-based side-channel attacks.
 *
 * Usage:
 *   const guard = requireApiKey("my-secret-key");
 *   app.get("/api/metrics", { preHandler: guard }, handler);
 *
 * When `expectedKey` is `undefined` (API_KEY env var not set) the guard is a
 * no-op, which allows local development without configuration overhead.
 */
export interface ApiKeyAuthOptions {
  expectedKey?: string;
  allowUnauthenticatedDevBypass?: boolean;
  environment?: string;
}

/**
 * Fastify preHandler that enforces API key authentication for external-service
 * endpoints (issue #273, issue #97).
 *
 * The key is read from the `X-Api-Key` request header and compared in constant
 * time to prevent timing-based side-channel attacks.
 *
 * Fail-closed behavior (issue #97):
 * - If `expectedKey` is missing/blank and dev bypass is not explicitly enabled,
 *   throws a startup configuration error.
 * - In production environments, dev bypass is strictly forbidden.
 */
export function requireApiKey(optionsOrKey: ApiKeyAuthOptions | string | undefined) {
  const options: ApiKeyAuthOptions =
    typeof optionsOrKey === "string" || optionsOrKey === undefined
      ? { expectedKey: optionsOrKey }
      : optionsOrKey;

  const { expectedKey, allowUnauthenticatedDevBypass, environment } = options;
  const isProduction = environment === "production" || process.env.NODE_ENV === "production";

  if (!expectedKey || expectedKey.trim().length === 0) {
    if (isProduction) {
      throw new Error(
        "API key guard configuration error: Missing required API_KEY for protected routes in production environment."
      );
    }
    if (!allowUnauthenticatedDevBypass) {
      throw new Error(
        "API key guard configuration error: Protected service routes require a valid API_KEY unless allowUnauthenticatedDevBypass is explicitly enabled."
      );
    }
  }

  return async function apiKeyGuard(req: FastifyRequest): Promise<void> {
    // Dev bypass mode active only when expectedKey is unconfigured and explicit bypass is enabled in non-production.
    if ((!expectedKey || expectedKey.trim().length === 0) && allowUnauthenticatedDevBypass && !isProduction) {
      return;
    }

    const provided = req.headers["x-api-key"];
    const key = Array.isArray(provided) ? provided[0] : provided;

    if (typeof key !== "string" || key.length === 0) {
      throw AppError.unauthorized();
    }

    // Constant-time comparison to resist timing attacks.
    if (!timingSafeEqual(key, expectedKey!)) {
      throw AppError.unauthorized();
    }
  };
}
