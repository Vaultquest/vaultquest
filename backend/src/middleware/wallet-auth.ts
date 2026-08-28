import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { verifySignature, isValidStellarAddress } from "../utils/stellarKey.js";
import { timingSafeEqual, verifyInternalSecret } from "./internal-secret.js";
import type { CacheService } from "../services/cacheService.js";

/**
 * Authorization for wallet-scoped endpoints.
 *
 * A caller has to prove which wallet they are before the wallet they ask for
 * is honoured.
 *
 * Two principals are accepted:
 *
 *  - **wallet owner** — proves control of the key behind the `G...` address by
 *    signing a challenge. Authorized for that wallet only.
 *  - **service** — an internal or third-party consumer presenting a shared
 *    credential. Authorized for any wallet, because these callers legitimately
 *    act on behalf of the platform.
 *
 * Unlike `requireApiKey`, this guard is never a no-op. A missing `API_KEY` in
 * local development disables that guard entirely. Internal callers always have a route through
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

export type WalletPrincipal =
  | { kind: "wallet"; walletAddress: string }
  | { kind: "service"; via: "api-key" | "internal-secret" };

declare module "fastify" {
  interface FastifyRequest {
    walletPrincipal?: WalletPrincipal;
    // Keep exportPrincipal for backwards compatibility if needed, or remove it and fix callers
  }
}

/**
 * The exact bytes a wallet signs. Binding the wallet address means a signature
 * captured from wallet A is not a valid signature for wallet B's export, and
 * binding the timestamp bounds how long a captured signature stays useful.
 * The prefix keeps a signature produced for this purpose from being replayed
 * against some other endpoint that also asks wallets to sign.
 */
export function buildWalletChallenge(walletAddress: string, timestampMs: number): string {
  // We keep the exact same challenge string to not break existing signatures or frontend code
  return `vaultquest:actions-export:${walletAddress}:${timestampMs}`;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unauthorized(message: string): AppError {
  return new AppError(ERROR_CODES.UNAUTHORIZED, 401, message);
}

export interface WalletAuthOptions {
  /** Third-party service key. Undefined means the API-key path is unavailable. */
  apiKey?: string | undefined;
  /** Internal service secret. Always configured, so services always have a path. */
  internalSecret: string;
  /** Signature freshness window. */
  signatureTtlMs?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
  /**
   * Backs single-use consumption of signed wallet challenges (replay guard).
   * Shares a store across instances when Redis-backed; falls back to an
   * in-memory store here when omitted, e.g. in tests that do not wire a
   * `CacheService`.
   */
  cacheService?: CacheService;
}

/** In-memory fallback replay guard, used only when no `cacheService` is configured. */
function inMemoryReplayGuard(): Pick<CacheService, "consumeOnce"> {
  const consumed = new Map<string, number>();
  return {
    async consumeOnce(key: string, ttlMs: number): Promise<boolean> {
      const now = Date.now();
      for (const [k, expiresAt] of consumed) {
        if (expiresAt <= now) consumed.delete(k);
      }
      if (consumed.has(key)) return false;
      consumed.set(key, now + ttlMs);
      return true;
    }
  };
}

export function requireWalletAuth(options: WalletAuthOptions) {
  const ttlMs = options.signatureTtlMs ?? DEFAULT_SIGNATURE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const replayGuard = options.cacheService ?? inMemoryReplayGuard();

  return async function walletAuthGuard(req: FastifyRequest): Promise<void> {
    const principal = await authenticate(req, options, ttlMs, now, replayGuard);

    // A service may act on any wallet; a wallet owner may act on only its own.
    if (principal.kind === "wallet") {
      // Check both query.wallet and body.wallet_address. If they exist, they must match the authenticated wallet.
      const requestedQuery = (req.query as Record<string, unknown> | undefined)?.["wallet"];
      if (typeof requestedQuery === "string" && requestedQuery.length > 0) {
        if (requestedQuery !== principal.walletAddress) {
          throw AppError.forbidden("authenticated wallet may not act on another wallet's data");
        }
      }
      
      const requestedBody = (req.body as Record<string, unknown> | undefined)?.["wallet_address"];
      if (typeof requestedBody === "string" && requestedBody.length > 0) {
        if (requestedBody !== principal.walletAddress) {
          throw AppError.forbidden("authenticated wallet may not act on another wallet's data");
        }
      }
      
      // Override the request parameters so downstream controllers don't need to change
      if (req.query && typeof req.query === 'object') {
        (req.query as Record<string, unknown>)["wallet"] = principal.walletAddress;
      }
      if (req.body && typeof req.body === 'object') {
        (req.body as Record<string, unknown>)["wallet_address"] = principal.walletAddress;
      }
    }

    req.walletPrincipal = principal;
    // For backwards compatibility during transition
    // req.exportPrincipal = principal;
  };
}

async function authenticate(
  req: FastifyRequest,
  options: WalletAuthOptions,
  ttlMs: number,
  now: () => number,
  replayGuard: Pick<CacheService, "consumeOnce">
): Promise<WalletPrincipal> {
  // Service credentials first: they are unambiguous and cheap to check.
  if (header(req, INTERNAL_SECRET_HEADER) !== undefined) {
    if (!verifyInternalSecret(req, options.internalSecret)) {
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
    throw unauthorized("operation requires a signed wallet challenge or a service credential");
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

  if (!verifySignature(walletAddress, buildWalletChallenge(walletAddress, timestampMs), signature)) {
    throw unauthorized("wallet signature verification failed");
  }

  // Single-use: a captured signature must not authorize more than one export.
  // Keyed on the exact purpose-bound challenge text, so consumption for this
  // challenge can never be confused with a record for a different purpose,
  // wallet, or timestamp. Consumption is atomic, so concurrent replays of the
  // same signature settle to exactly one success.
  const replayKey = buildWalletChallenge(walletAddress, timestampMs);
  const firstUse = await replayGuard.consumeOnce(replayKey, ttlMs);
  if (!firstUse) {
    throw unauthorized("signed challenge has already been used");
  }

  return { kind: "wallet", walletAddress };
}
