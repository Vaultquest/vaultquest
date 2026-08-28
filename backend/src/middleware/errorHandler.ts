import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { requestLogContext, sanitizeIssues } from "../utils/logRedaction.js";

export function errorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const errorId = req.correlationId || randomUUID();

  // Log the error with redacted request context (issue #105): the normalized
  // route template and allowlisted metadata, never the raw URL.
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
  } else {
    req.log.error({ err, ...logContext }, "Error occurred during request processing");
  }

  let statusCode = 500;
  let code = "INTERNAL";
  let message = "An internal server error occurred";
  let details: unknown = undefined;
  let issues: unknown = undefined;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.detail;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = "INVALID_PAYLOAD";
    message = "validation failed";
    issues = err.issues;
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
    // Check if it's a Fastify native HTTP error
    const maybeStatus = err.statusCode || (err as any).status;
    if (typeof maybeStatus === "number" && maybeStatus >= 400 && maybeStatus < 600) {
      statusCode = maybeStatus;
      code = err.code || "HTTP_ERROR";
      message = err.message;
    }
  }

  // Construct standardized JSON error schema according to acceptance criteria:
  // All public error responses return standardized JSON schemas containing an HTTP status code, message, and error ID.
  // Public responses never expose internal system stack traces or raw database statements.
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
