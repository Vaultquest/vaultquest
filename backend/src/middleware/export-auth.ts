import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { verifySignature, isValidStellarAddress } from "../utils/stellarKey.js";

/**
 * Authorization for the activity export endpoint (issue #10).
 *
 * Export returns a wallet's full transaction history, so `?wallet=` cannot be
 * both the thing that selects the data and the thing that authorizes it. A
 * caller now has to prove which wallet they are before the wallet they ask for
 * is honoured.
 *
 * Two principals are accepted:
 *
 *  - **wallet owner** — proves control of the key behind the `G...` address by
 *    signing a challenge. Authorized for that wallet only.
 *  - **service** — an internal or third-party consumer presenting a shared
 *    credential. Authorized for any wallet, because these callers legitimately
 *    export on behalf of the platform.
 *
 * Unlike `requireApiKey`, this guard is never a no-op. A missing `API_KEY` in
 * local development disables that guard entirely, which for export would leave
 * exactly the hole this closes. Internal callers always have a route through
 * `X-Internal-Secret`, which is required configuration.
 */

/** Headers a wallet owner presents. */
const WALLET_HEADER = "x-wallet-address";
const SIGNATURE_HEADER = "x-wallet-signature";
const TIMESTAMP_HEADER = "x-wallet-timestamp";

/** Headers a service consumer presents. */
const API_KEY_HEADER = "x-api-key";
const INTERNAL_SECRET_HEADER = "x-internal-secret";

/** How long a signed challenge stays valid. */
export const DEFAULT_SIGNATURE_TTL_MS = 5 * 60 * 1000;

export type ExportPrincipal =
  | { kind: "wallet"; walletAddress: string }
  | { kind: "service"; via: "api-key" | "internal-secret" };

declare module "fastify" {
  interface FastifyRequest {
    exportPrincipal?: ExportPrincipal;
  }
}

/**
 * The exact bytes a wallet signs. Binding the wallet address means a signature
 * captured from wallet A is not a valid signature for wallet B's export, and
 * binding the timestamp bounds how long a captured signature stays useful.
 * The prefix keeps a signature produced for this purpose from being replayed
 * against some other endpoint that also asks wallets to sign.
 */
export function buildExportChallenge(walletAddress: string, timestampMs: number): string {
  return `vaultquest:actions-export:${walletAddress}:${timestampMs}`;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Constant-time comparison, matching the approach in `api-key-auth.ts`. */
function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function unauthorized(message: string): AppError {
  return new AppError(ERROR_CODES.UNAUTHORIZED, 401, message);
}

export interface ExportAuthOptions {
  /** Third-party service key. Undefined means the API-key path is unavailable. */
  apiKey?: string | undefined;
  /** Internal service secret. Always configured, so services always have a path. */
  internalSecret: string;
  /** Signature freshness window. */
  signatureTtlMs?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
}

export function requireExportAuth(options: ExportAuthOptions) {
  const ttlMs = options.signatureTtlMs ?? DEFAULT_SIGNATURE_TTL_MS;
  const now = options.now ?? (() => Date.now());

  return async function exportAuthGuard(req: FastifyRequest): Promise<void> {
    const principal = authenticate(req, options, ttlMs, now);

    // A service may export any wallet; a wallet owner may export only its own.
    if (principal.kind === "wallet") {
      const requested = (req.query as Record<string, unknown> | undefined)?.["wallet"];

      // No wallet in the query: nothing can be disclosed, so let schema
      // validation produce the usual 400 rather than inventing an auth error.
      if (typeof requested === "string" && requested.length > 0) {
        if (requested !== principal.walletAddress) {
          throw AppError.forbidden("authenticated wallet may not export another wallet's history");
        }
      }
    }

    req.exportPrincipal = principal;
  };
}

function authenticate(
  req: FastifyRequest,
  options: ExportAuthOptions,
  ttlMs: number,
  now: () => number
): ExportPrincipal {
  // Service credentials first: they are unambiguous and cheap to check.
  const internalSecret = header(req, INTERNAL_SECRET_HEADER);
  if (internalSecret !== undefined) {
    if (!timingSafeEqual(internalSecret, options.internalSecret)) {
      throw unauthorized("invalid internal service secret");
    }
    return { kind: "service", via: "internal-secret" };
  }

  const apiKey = header(req, API_KEY_HEADER);
  if (apiKey !== undefined) {
    if (options.apiKey === undefined) {
      throw unauthorized("api key authentication is not configured");
    }
    if (!timingSafeEqual(apiKey, options.apiKey)) {
      throw unauthorized("invalid api key");
    }
    return { kind: "service", via: "api-key" };
  }

  const walletAddress = header(req, WALLET_HEADER);
  const signature = header(req, SIGNATURE_HEADER);
  const timestamp = header(req, TIMESTAMP_HEADER);

  if (walletAddress === undefined && signature === undefined && timestamp === undefined) {
    throw unauthorized("export requires a signed wallet challenge or a service credential");
  }
  if (walletAddress === undefined || signature === undefined || timestamp === undefined) {
    throw unauthorized(
      `wallet authentication requires ${WALLET_HEADER}, ${SIGNATURE_HEADER} and ${TIMESTAMP_HEADER}`
    );
  }

  if (!isValidStellarAddress(walletAddress)) {
    throw unauthorized(`${WALLET_HEADER} is not a valid Stellar address`);
  }

  const timestampMs = Number(timestamp);
  if (!Number.isInteger(timestampMs)) {
    throw unauthorized(`${TIMESTAMP_HEADER} must be a Unix timestamp in milliseconds`);
  }

  // Rejected in both directions: an old signature is a replay, and one dated
  // far in the future would otherwise stay valid indefinitely.
  if (Math.abs(now() - timestampMs) > ttlMs) {
    throw unauthorized("signed challenge has expired");
  }

  if (!verifySignature(walletAddress, buildExportChallenge(walletAddress, timestampMs), signature)) {
    throw unauthorized("wallet signature verification failed");
  }

  return { kind: "wallet", walletAddress };
}
