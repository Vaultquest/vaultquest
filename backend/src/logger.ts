import pino, { type DestinationStream, type Logger } from "pino";
import { HASH_PREFIX, REDACTED } from "./utils/logRedaction.js";

/**
 * Last-resort redaction for anything that reaches the log stream without going
 * through `utils/logRedaction.ts` - a third-party plugin, a Fastify internal
 * serializer, or a future call site that forgets the contract (issue #105).
 *
 * `url` is here because a raw URL carries the query string, which is where
 * wallet addresses and cursors are passed; the request hooks in `app.ts` log a
 * normalized `route` instead, so nothing legitimate is lost.
 */
const REDACTED_PATHS = [
  "url",
  "*.url",
  "req.url",
  "request.url",
  "raw.url",
  "wallet",
  "*.wallet",
  "walletAddress",
  "*.walletAddress",
  "wallet_address",
  "*.wallet_address",
  "cursor",
  "*.cursor",
  "headers.authorization",
  "*.headers.authorization",
  "headers.cookie",
  "*.headers.cookie",
  'headers["x-api-key"]',
  '*.headers["x-api-key"]',
  'headers["x-csrf-token"]',
  '*.headers["x-csrf-token"]'
];

/**
 * Values that already went through `utils/logRedaction.ts` are passed through
 * unchanged: a salted hash is safe to keep, and replacing it would throw away
 * the ability to correlate a wallet's requests, which the redaction contract
 * deliberately preserves. Everything else on a redacted path is censored.
 */
function censorUnlessAlreadySafe(value: unknown): unknown {
  if (typeof value === "string" && (value.startsWith(HASH_PREFIX) || value === REDACTED)) {
    return value;
  }
  return REDACTED;
}

/**
 * @param destination optional sink, used by tests to assert on what is
 * actually serialized. When omitted, pino writes to stdout as before.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  const isDevelopment = process.env.NODE_ENV === "development";

  const options = {
    level,
    base: { service: "vaultquest-backend" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: censorUnlessAlreadySafe },
    transport:
      isDevelopment && !destination
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              ignore: "pid,hostname,service",
              translateTime: "HH:MM:ss Z"
            }
          }
        : undefined
  };

  return destination ? pino(options, destination) : pino(options);
}
