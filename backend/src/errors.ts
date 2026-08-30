import { ERROR_CODES, type ErrorCode } from "./constants.js";

/**
 * An application-level error that is safe to surface to callers. Two
 * audiences read an `AppError`, and they get different slices (issue #131):
 *
 * - The public envelope carries `code`, `statusCode`, `message`, and - when it
 *   passes the handler's schema check - `detail`. These are what any caller
 *   sees, so they must not embed internal identifiers, provider/database
 *   context, or raw request values.
 * - The private `logContext` never leaves the server: the error handler logs
 *   it (plus a redacted view of the request) under the error ID and drops it
 *   from the response unconditionally.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly detail?: unknown;
  readonly logContext?: unknown;

  constructor(code: ErrorCode, statusCode: number, message: string, detail?: unknown, logContext?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.detail = detail;
    this.logContext = logContext;
  }

  static conflict(code: ErrorCode, message: string, detail?: unknown, logContext?: unknown): AppError {
    return new AppError(code, 409, message, detail, logContext);
  }
  static notFound(message: string): AppError {
    return new AppError(ERROR_CODES.NOT_FOUND, 404, message);
  }
  static unauthorized(): AppError {
    return new AppError(ERROR_CODES.UNAUTHORIZED, 401, "unauthorized");
  }
  static validation(message: string, detail?: unknown, logContext?: unknown): AppError {
    return new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, message, detail, logContext);
  }
  static badRequest(code: ErrorCode, message: string, detail?: unknown, logContext?: unknown): AppError {
    return new AppError(code, 400, message, detail, logContext);
  }
  static forbidden(message: string = "forbidden"): AppError {
    return new AppError(ERROR_CODES.FORBIDDEN, 403, message);
  }
}