import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { requestLogContext, sanitizeIssues } from "../utils/logRedaction.js";

/**
 * Public-response safety contract for the error envelope (issue #131).
 *
 * The envelope is the one contract every caller shares, so anything it carries
 * must be safe to hand to *any* caller: no internal identifiers, no provider or
 * database context, no raw values quoted back from the request, no control
 * characters, and no unbounded text.
 *
 * Only handled, known error types are allowed to influence the public message
 * and details:
 *
 *  - `AppError` - expected by construction, but its message is re-validated and
 *    its `detail` must pass a schema check before it is returned. Its private
 *    `logContext` is only ever logged.
 *  - `ZodError` - validation issues are reduced to what the known validators
 *    produced (code, field path, a bounded validator message, strict-schema
 *    keys). The `received`/`expected` fields - which quote the raw value back -
 *    never reach the response.
 *  - Prisma errors - fixed, generic messages.
 *
 * Everything else (native Fastify errors, provider errors, any unexpected
 * exception) is surfaced with a generic per-status message. The original
 * error, stack and all, stays under the error ID in the log stream for
 * investigation and never reaches the caller.
 */
export function errorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const errorId = req.correlationId || randomUUID();

  // Log the error with redacted request context (issue #105): the normalized
  // route template and allowlisted metadata, never the raw URL. The private
  // `AppError.logContext` (and detail, for operators) is logged here and only
  // here.
  //
  // A ZodError is logged as issue codes and paths only. Its `message` is a
  // JSON dump of the issues, which for a rejected query quotes the wallet
  // address or cursor verbatim - so the error object itself is deliberately
  // not handed to the log serializer on that branch.
  const logContext = { errorId, ...requestLogContext(req) };
  if (err instanceof ZodError) {
    req.log.error(
      { ...logContext, error_type: "ZodError", issues: sanitizeIssues(err.issues) },
      "Validation failed during request processing"
    );
  } else if (err instanceof AppError) {
    req.log.error(
      {
        ...logContext,
        error_type: "AppError",
        error_code: err.code,
        detail: err.detail,
        log_context: err.logContext
      },
      "Error occurred during request processing"
    );
  } else {
    req.log.error(
      { err, ...logContext, error_type: "UNEXPECTED" },
      "Error occurred during request processing"
    );
  }

  let statusCode = 500;
  let code = "INTERNAL";
  let message = "An internal server error occurred";
  let details: unknown = undefined;
  let issues: PublicValidationIssue[] | undefined = undefined;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = sanitizePublicMessage(err.message, statusCode);
    if (err.detail !== undefined && isSafePublicDetail(err.detail)) {
      details = err.detail;
    }
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = "INVALID_PAYLOAD";
    message = "validation failed";
    issues = sanitizeIssuesForClient(err.issues);
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      statusCode = 409;
      code = "CONFLICT";
      message = "A database conflict occurred (unique constraint violation)";
    } else if (err.code === "P2025") {
      statusCode = 404;
      code = "NOT_FOUND";
      message = "The requested database record was not found";
    } else {
      statusCode = 500;
      code = "DATABASE_ERROR";
      message = "A database error occurred";
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    statusCode = 400;
    code = "INVALID_PAYLOAD";
    message = "Database validation failed";
  } else if (err.constructor.name.includes("Prisma")) {
    statusCode = 500;
    code = "DATABASE_ERROR";
    message = "An internal database error occurred";
  } else {
    // Native Fastify HTTP errors (404, 405, ...) and provider errors that tag
    // their own status. The status and a bounded code identifier may be passed
    // through, but the error's own message never is: a route or provider may
    // have put internal context there, and the envelope must not echo it.
    const maybeStatus = err.statusCode || (err as { status?: unknown }).status;
    if (typeof maybeStatus === "number" && maybeStatus >= 400 && maybeStatus < 600) {
      statusCode = maybeStatus;
      code =
        typeof err.code === "string" &&
        err.code.length > 0 &&
        err.code.length <= 64 &&
        !CONTROL_CHARACTERS.test(err.code)
          ? err.code
          : "HTTP_ERROR";
      message = genericMessageFor(maybeStatus);
    }
  }

  const payload = {
    error: {
      code,
      message,
      error_id: errorId,
      status_code: statusCode,
      ...(details !== undefined ? { details } : {}),
      ...(issues !== undefined ? { issues } : {})
    }
  };

  reply.status(statusCode).send(payload);
}

// ─── Public-response sanitizers ──────────────────────────────────────────────

const MAX_PUBLIC_MESSAGE_LENGTH = 300;
const MAX_PUBLIC_DETAIL_LENGTH = 200;
const MAX_PUBLIC_DETAIL_ENTRIES = 32;
const MAX_PUBLIC_DETAIL_DEPTH = 4;
const MAX_PUBLIC_DETAIL_BYTES = 4096;
const MAX_ISSUES = 20;
const MAX_ISSUE_KEYS = 10;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f\u0080-\u009f]/u;

/** Key names that never belong in a public detail object. */
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|signature|credential|authorization|session|nonce|otp|api[_-]?key|private[_-]?key|privkey)/i;

/** Strips control characters and bounds length for any public text value. */
function sanitizeText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value : String(value);
  const cleaned = text.replace(CONTROL_CHARACTERS, "");
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}

/**
 * Generic per-status message shown to callers for unexpected/native errors.
 * Keyed by status so the public surface still reads correctly without
 * echoing the underlying error's own (potentially internal) message.
 */
const GENERIC_MESSAGES: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  405: "Method not allowed",
  408: "Request timeout",
  409: "Conflict",
  413: "Payload too large",
  415: "Unsupported media type",
  422: "Unprocessable entity",
  429: "Too many requests",
  500: "An internal server error occurred",
  502: "Bad gateway",
  503: "Service unavailable",
  504: "Gateway timeout"
};

function genericMessageFor(statusCode: number): string {
  return GENERIC_MESSAGES[statusCode] ?? "An unexpected error occurred";
}

function sanitizePublicMessage(value: unknown, statusCode: number): string {
  const cleaned = sanitizeText(value, MAX_PUBLIC_MESSAGE_LENGTH).trim();
  return cleaned.length > 0 ? cleaned : genericMessageFor(statusCode);
}

/**
 * Schema check for the public `detail` field. Only strings (bounded,
 * control-character-free) and small plain JSON values whose keys are
 * public-safe pass. Anything else is dropped from the response and stays in
 * the log under the error ID, so a route cannot accidentally leak internal
 * context through the envelope via `AppError.detail`.
 */
function isSafePublicDetail(detail: unknown): boolean {
  return walkDetail(detail, 0, { bytes: MAX_PUBLIC_DETAIL_BYTES });
}

function walkDetail(value: unknown, depth: number, budget: { bytes: number }): boolean {
  if (budget.bytes <= 0) return false;
  if (value === null) return true;

  switch (typeof value) {
    case "string":
      if (CONTROL_CHARACTERS.test(value) || value.length > MAX_PUBLIC_DETAIL_LENGTH) return false;
      budget.bytes -= value.length;
      return budget.bytes >= 0;
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    default:
      break;
  }

  if (typeof value !== "object") return false;
  if (depth >= MAX_PUBLIC_DETAIL_DEPTH) return false;

  if (Array.isArray(value)) {
    if (value.length > MAX_PUBLIC_DETAIL_ENTRIES) return false;
    return value.every((item) => walkDetail(item, depth + 1, budget));
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PUBLIC_DETAIL_ENTRIES) return false;
  for (const [key, item] of entries) {
    if (
      key.length === 0 ||
      key.length > 64 ||
      CONTROL_CHARACTERS.test(key) ||
      SECRET_KEY_PATTERN.test(key)
    ) {
      return false;
    }
    if (!walkDetail(item, depth + 1, budget)) return false;
  }
  return true;
}

export type PublicValidationIssue = {
  code?: string;
  path?: string;
  message?: string;
  keys?: string[];
};

/**
 * Response-safe view of Zod issues: the schema's issue `code`, the field
 * `path`, a bounded `message` produced by the known validator, and the
 * offending `keys` for strict schemas. `received`/`expected` - which quote the
 * rejected value (a wallet address, cursor, or arbitrary caller text) back
 * verbatim - are never returned. This is the public counterpart of the
 * log-side `sanitizeIssues()`, and is the "known validators only" rule for the
 * `issues` member of the envelope.
 */
export function sanitizeIssuesForClient(
  issues:
    | readonly {
        code?: string;
        path?: readonly (string | number)[];
        message?: string;
        keys?: readonly string[];
      }[]
    | undefined
): PublicValidationIssue[] {
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, MAX_ISSUES).map((issue) => {
    const out: PublicValidationIssue = {};
    if (typeof issue?.code === "string") {
      const code = sanitizeText(issue.code, 40);
      if (code.length > 0) out.code = code;
    }
    if (Array.isArray(issue.path)) {
      const path = sanitizeText(issue.path.join("."), 120);
      if (path.length > 0) out.path = path;
    }
    if (typeof issue.message === "string") {
      const message = sanitizeText(issue.message, 200);
      if (message.length > 0) out.message = message;
    }
    if (Array.isArray(issue.keys)) {
      const keys = issue.keys
        .map((key) => sanitizeText(key, 40))
        .filter((key): key is string => key.length > 0)
        .slice(0, MAX_ISSUE_KEYS);
      if (keys.length > 0) out.keys = keys;
    }
    return out;
  });
}