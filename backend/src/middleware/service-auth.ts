import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { verifyInternalSecret } from "./internal-secret.js";

export function requireServiceAuth(expectedSecret: string) {
  return async function (req: FastifyRequest): Promise<void> {
    if (!verifyInternalSecret(req, expectedSecret)) {
      throw AppError.unauthorized();
    }
  };
}
