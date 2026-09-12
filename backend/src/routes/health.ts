import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { LedgerService } from "../services/ledger.js";
import type { CacheService } from "../services/cacheService.js";
import { getReadiness, type ReadinessOptions } from "../services/readinessService.js";
import {
  probeDependencies,
  type ProbeOptions,
} from "../services/probeService.js";
import {
  defaultVaultHealthOptions,
  getVaultHealth,
  type VaultHealthOptions,
} from "../services/vaultHealthService.js";
import { ok } from "../responses.js";

export const healthRoutes = (
  svc: LedgerService,
  prisma: PrismaClient,
  cacheService: CacheService | undefined,
  readinessOptions: ReadinessOptions = {},
  probeOptions: ProbeOptions = {},
  vaultHealthOptions?: VaultHealthOptions
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

    // External dependency probe for the browser status banner (#116). Runs
    // the network checks server-side (where CORS does not apply), so the
    // banner no longer needs `mode: "no-cors"` fetches whose opaque
    // responses hide the real status. Shares the caller-provided mutation
    // options so tests can inject a stub fetch and fixed clock; the
    // production default probes the real third-party endpoints.
    app.get("/health/probe", async (req) => {
      const probe = await probeDependencies(probeOptions);
      req.log.debug(
        { event: "health_probe", status: probe.status },
        "dependency probe completed"
      );
      return ok(probe);
    });

    // Aggregated vault health for the dashboard status panel (#115). Each row
    // is backed by a real signal - the indexer checkpoint or a network probe -
    // and a dependency without a trustworthy probe is reported as `unknown`
    // rather than guessed. The panel used to derive every state from
    // Math.random(), so this endpoint is the source of truth it reads instead.
    app.get("/health/vault", async (req) => {
      const options =
        vaultHealthOptions ??
        defaultVaultHealthOptions(() => svc.getIndexerHealth(), probeOptions);
      const health = await getVaultHealth(options);
      req.log.debug(
        { event: "health_vault_check", status: health.status },
        "vault health aggregation completed"
      );
      return ok(health);
    });
  };
