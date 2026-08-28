import type { FastifyRequest } from "fastify";

/**
 * Shared credential extraction and comparison for the internal service
 * secret (issue #128). `service-auth.ts`, the internal-secret branch of
 * `export-auth.ts`, and the privileged `/api/privacy/*` routes all accept
 * the same `X-Internal-Secret` header — this module is the single place
 * that reads and verifies it so every guard behaves identically.
 */

const INTERNAL_SECRET_HEADER = "x-internal-secret";

/**
 * Constant-time string comparison that avoids early-exit short-circuits.
 * Uses the longer of the two lengths so the loop count never leaks length
 * information through timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Reads a header value, collapsing a multi-value (array) header down to its
 * first entry so every guard normalizes repeated headers the same way.
 */
export function readHeader(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extracts the `X-Internal-Secret` header and compares it to `expectedSecret`
 * in constant time. Returns `false` for a missing, empty, or malformed
 * (array) header without ever falling back to ordinary `===`/`!==`.
 */
export function verifyInternalSecret(req: FastifyRequest, expectedSecret: string): boolean {
  const provided = readHeader(req, INTERNAL_SECRET_HEADER);
  return provided !== undefined && timingSafeEqual(provided, expectedSecret);
}
