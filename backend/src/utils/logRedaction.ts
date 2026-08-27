import { createHash, randomBytes } from "node:crypto";

/**
 * Log-safety contract (issue #105).
 *
 * Request logs are copied into long-lived aggregation systems, so nothing that
 * identifies a wallet - or that a caller controls verbatim - may reach them.
 * Everything logged about a request goes through this module:
 *
 * 1. Routes are logged as their registered *template* (`/actions/export`),
 *    never as `req.url`, so a query string can never ride along.
 * 2. Query and path parameter values are logged only when their key is on
 *    {@link SAFE_QUERY_KEYS}, and only after being bounded and stripped of
 *    control characters. Everything else is reported as key presence with a
 *    stable salted hash (identifiers) or a bare `[redacted]` marker.
 * 3. The same helpers are used on the success, validation-failure, and error
 *    paths, so redaction cannot be bypassed by taking a different branch.
 */

/**
 * Salt for identifier hashes. A per-process random salt is the safe default:
 * wallet addresses are drawn from a small, publicly enumerable space, so an
 * unsalted digest is trivially reversible by anyone holding the logs. Set
 * `LOG_REDACTION_SALT` to a stable secret when hashes must correlate across
 * processes, restarts, or replicas.
 */
const HASH_SALT = process.env.LOG_REDACTION_SALT || randomBytes(32).toString("hex");

/**
 * Digest prefix length, in hex characters. 12 hex chars is 48 bits: enough to
 * tell wallets apart within a debugging window, far too little to brute-force
 * back to an address without the salt.
 */
const HASH_LENGTH = 12;

/** Upper bound on any logged value, so a caller cannot inflate log volume. */
const MAX_VALUE_LENGTH = 64;

/** Upper bound on a logged path, for the same reason. */
const MAX_PATH_LENGTH = 120;

/** Marker used wherever a value is dropped entirely. */
export const REDACTED = "[redacted]";

/** Prefix identifying a value that is already a salted digest, not plaintext. */
export const HASH_PREFIX = "sha256:";

/**
 * Query keys whose values are low-cardinality, non-identifying enums, numbers,
 * or timestamps (see `src/schemas/actions.ts`). These are what keeps
 * route-level debugging usable, so they are logged as-is - after sanitizing.
 */
const SAFE_QUERY_KEYS = new Set([
  "format",
  "limit",
  "status",
  "type",
  "from",
  "to",
  "stale_after_ms"
]);

/**
 * Query keys carrying a caller identifier. Logged as a salted hash so two
 * requests from the same wallet stay linkable without the address itself being
 * recoverable from the logs.
 */
const HASHED_QUERY_KEYS = new Set([
  "wallet",
  "walletaddress",
  "wallet_address",
  "address",
  "account",
  "cursor",
  "id"
]);

/**
 * Substring matches for keys that must never be logged in any form, not even
 * hashed: a hash of a secret is still an oracle for guessing it.
 */
const SECRET_KEY_PATTERNS = [
  "secret",
  "token",
  "password",
  "passwd",
  "signature",
  "sig",
  "key",
  "auth",
  "credential",
  "session",
  "nonce",
  "otp"
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => key.includes(pattern));
}

/**
 * Stable, salted, truncated digest of a caller-supplied identifier. Non-string
 * input is stringified first, so a repeated `?wallet=a&wallet=b` parameter
 * (which Fastify parses into an array) cannot slip through unhashed.
 */
export function hashIdentifier(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const digest = createHash("sha256")
    .update(HASH_SALT)
    .update("|")
    .update(text)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return `${HASH_PREFIX}${digest}`;
}

/**
 * Renders a wallet address for logs. Always a hash: even a truncated prefix of
 * a Stellar address narrows the candidate set enough to be identifying.
 */
export function redactWallet(value: unknown): string {
  if (value === undefined || value === null || value === "") return REDACTED;
  return hashIdentifier(value);
}

/** Strips control characters, which is what makes a log line forgeable. */
function stripControlCharacters(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return text.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Strips control characters and bounds length, for anything logged verbatim. */
function sanitizeValue(value: unknown, maxLength = MAX_VALUE_LENGTH): string {
  const cleaned = stripControlCharacters(value);
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

/**
 * Reduces a query or params object to allowlisted metadata: safe keys keep
 * their value, identifier keys become hashes, and secret-ish or unrecognized
 * keys are reported as present but redacted. Key *names* are sanitized too,
 * since they are equally caller-controlled.
 */
export function sanitizeQuery(query: unknown): Record<string, string> {
  if (!query || typeof query !== "object") return {};

  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(query as Record<string, unknown>)) {
    const key = sanitizeValue(rawKey, 40);
    if (key === "") continue;
    const normalized = key.toLowerCase();

    if (isSecretKey(normalized)) {
      out[key] = REDACTED;
    } else if (HASHED_QUERY_KEYS.has(normalized)) {
      out[key] =
        value === undefined || value === null || value === "" ? REDACTED : hashIdentifier(value);
    } else if (SAFE_QUERY_KEYS.has(normalized)) {
      out[key] = sanitizeValue(value);
    } else {
      // Unknown keys default to redacted: an allowlist has to fail closed to
      // stay a guarantee as routes gain parameters.
      out[key] = REDACTED;
    }
  }
  return out;
}

/** Cap on how many validation issues are logged for one request. */
const MAX_ISSUES = 20;

/**
 * Log-safe view of Zod validation issues. Only the issue code and the field
 * path are kept: a Zod issue's `message`/`received` can quote the rejected
 * value verbatim, which for a query failure is exactly the wallet address or
 * cursor this module exists to keep out of the logs. The field path alone is
 * what a debugger actually needs.
 */
export function sanitizeIssues(
  issues: readonly { code?: string; path?: readonly (string | number)[] }[] | undefined
): { code: string; path: string }[] {
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, MAX_ISSUES).map((issue) => ({
    code: sanitizeValue(issue?.code ?? "invalid", 40),
    path: sanitizeValue((issue?.path ?? []).join("."), 80)
  }));
}

/** Path segments that look like an identifier rather than a fixed route part. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STELLAR_ADDRESS_PATTERN = /^G[A-Z0-9]{55}$/;
const PLAIN_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Best-effort normalization for requests that never matched a route (404s,
 * probes, scanners), where no template exists. The query string is dropped,
 * the path is decoded, and any segment that looks like an identifier - or is
 * simply long or unusual - is replaced with a placeholder, so a caller cannot
 * write arbitrary text into the logs just by requesting it as a URL.
 */
export function normalizeUnmatchedPath(url: string): string {
  let path = url.split("?")[0]?.split("#")[0] ?? "/";
  try {
    path = decodeURIComponent(path);
  } catch {
    // Malformed percent-encoding: keep the raw form, which is sanitized below.
  }

  const segments = path.split("/").map((segment) => {
    if (segment === "") return segment;
    // Identifier shapes are matched before any truncation, so a full-length
    // wallet address is recognized as one rather than degraded to ":segment".
    const clean = stripControlCharacters(segment);
    if (UUID_PATTERN.test(clean)) return ":id";
    if (STELLAR_ADDRESS_PATTERN.test(clean)) return ":wallet";
    if (clean.length > 24 || !PLAIN_SEGMENT_PATTERN.test(clean)) return ":segment";
    return clean;
  });

  const normalized = segments.join("/") || "/";
  return normalized.length > MAX_PATH_LENGTH
    ? `${normalized.slice(0, MAX_PATH_LENGTH)}...`
    : normalized;
}

/** The subset of a Fastify request this module needs, so it stays unit-testable. */
export type LoggableRequest = {
  url?: string;
  method?: string;
  query?: unknown;
  params?: unknown;
  routeOptions?: { url?: string };
  /** Deprecated Fastify 4 accessor, kept as a fallback. */
  routerPath?: string;
};

/**
 * The registered route template for a request
 * (`/api/privacy/deletion-manifest/:id`), or a normalized placeholder path
 * when nothing matched. Never contains a query string.
 */
export function routeTemplate(req: LoggableRequest): string {
  // `routerPath` is consulted only when `routeOptions` is absent entirely: on
  // Fastify 4, merely reading it emits a deprecation warning.
  const template = req.routeOptions ? req.routeOptions.url : req.routerPath;
  if (typeof template === "string" && template.length > 0) return template;
  return normalizeUnmatchedPath(req.url ?? "/");
}

export type RequestLogContext = {
  route: string;
  method: string | undefined;
  query?: Record<string, string>;
  params?: Record<string, string>;
};

/**
 * The canonical log payload for a request. Request-scoped log statements
 * spread this instead of assembling their own fields, so the success,
 * validation-failure, and error paths cannot drift apart.
 */
export function requestLogContext(req: LoggableRequest): RequestLogContext {
  const query = sanitizeQuery(req.query);
  const params = sanitizeQuery(req.params);
  return {
    route: routeTemplate(req),
    method: req.method,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {})
  };
}
