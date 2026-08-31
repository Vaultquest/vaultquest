import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodSchema } from "zod";
import { requestLogContext, sanitizeIssues } from "../utils/logRedaction.js";
import { sanitizeIssuesForClient } from "./errorHandler.js";

/**
 * Validation failures are logged through the shared log-safety contract
 * (issue #105): the normalized route template plus redacted metadata, and
 * issue *codes and paths* only. The rejected values themselves - which is
 * where wallet addresses and cursors live on this path - never reach the log
 * stream, and the `issues` echoed back to the caller are reduced to the
 * known-validator view (no `received`/`expected` quoting the raw value).
 */

export function validateBody<T>(schema: ZodSchema<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      req.log.debug(
        {
          event: "body_validation_failed",
          ...requestLogContext(req),
          issues: sanitizeIssues(result.error.issues)
        },
        "request body validation failed"
      );
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Request body validation failed",
          issues: sanitizeIssuesForClient(result.error.issues)
        }
      });
    }
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      req.log.debug(
        {
          event: "query_validation_failed",
          ...requestLogContext(req),
          issues: sanitizeIssues(result.error.issues)
        },
        "query parameter validation failed"
      );
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Query parameter validation failed",
          issues: sanitizeIssuesForClient(result.error.issues)
        }
      });
    }
  };
}
