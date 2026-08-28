import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { LedgerService } from "../services/ledger.js";
import type { CacheService } from "../services/cacheService.js";
import { getReadiness, type ReadinessOptions } from "../services/readinessService.js";
import { ok } from "../responses.js";

export const healthRoutes = (
  svc: LedgerService,
  prisma: PrismaClient,
  cacheService: CacheService | undefined,
  readinessOptions: ReadinessOptions = {}
): FastifyPluginAsync =>
  async (app) => {
    // Cheap liveness: no dependency checks, so an orchestrator can use it to
    // decide whether to restart the process without adding load elsewhere.
    app.get("/health", async (req) => {
      req.log.debug({ event: "health_check" }, "health check requested");
      return ok({
        status: "ok",
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        service: "vaultquest-backend"
      });
    });

    app.get("/health/indexer", async (req) => {
      const health = await svc.getIndexerHealth();
      req.log.debug(
        { event: "health_indexer_check", status: health.status },
        "indexer health checked"
      );
      return ok(health);
    });

    // Readiness: gates whether this instance should receive traffic. Checks
    // database connectivity and indexer freshness (both required) plus cache
    // connectivity (best-effort, reported but non-gating — see
    // readinessService.ts). Returns 503 when not ready so load balancers and
    // orchestrators stop routing here, per standard readiness-probe
    // semantics (2xx-399 = ready, everything else = not ready).
    app.get("/health/ready", async (req, reply) => {
      const readiness = await getReadiness(prisma, svc, cacheService, readinessOptions);
      req.log.debug(
        { event: "health_ready_check", status: readiness.status },
        "readiness check completed"
      );
      reply.status(readiness.status === "ready" ? 200 : 503);
      return ok(readiness);
    });
  };
