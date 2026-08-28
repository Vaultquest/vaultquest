import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import correlation from "./middleware/correlation.js";
import prometheusPlugin from "./middleware/prometheusPlugin.js";
import { LedgerService } from "./services/ledger.js";
import { SavedPoolsService } from "./services/savedPools.js";
import { actionsRoutes } from "./routes/actions.js";
import { savedPoolsRoutes } from "./routes/savedPools.js";
import { internalRoutes } from "./routes/internal.js";
import { metricsRoutes } from "./routes/metrics.js";
import { prometheusRoutes } from "./routes/prometheus.js";
import { healthRoutes } from "./routes/health.js";
import { MetricsService } from "./services/metricsService.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { requireApiKey } from "./middleware/api-key-auth.js";
import { requireWalletAuth } from "./middleware/wallet-auth.js";
import { requireServiceAuth } from "./middleware/service-auth.js";
import { createLogger } from "./logger.js";
import { requestLogContext } from "./utils/logRedaction.js";
import type { Logger } from "pino";
import type { CacheService } from "./services/cacheService.js";

import { privacyRoutes } from "./routes/privacy.js";
import { PrivacyEncryptionService } from "./services/privacy/privacyEncryptionService.js";
import { PrivacyAuditService } from "./services/privacy/privacyAuditService.js";
import { PrivacyExportService } from "./services/privacy/privacyExportService.js";
import { PrivacyDeletionService } from "./services/privacy/privacyDeletionService.js";

export type AppDeps = {
  prisma: PrismaClient;
  internalSecret: string;
  /** API key for external-service endpoints (issue #273). Undefined disables enforcement. */
  apiKey?: string;
  /**
   * Dedicated scrape credential for the raw Prometheus `/metrics` endpoint
   * (issue #102), kept separate from `apiKey` so it can be rotated/scoped
   * independently. Undefined disables enforcement (local dev only).
   */
  prometheusScrapeKey?: string;
  logger?: Logger;
  cacheService?: CacheService;
  privacyMasterKey?: string;
  /** Freshness window for signed export challenges (#10). Defaults to 5 minutes. */
  exportSignatureTtlMs?: number;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const loggerInstance = deps.logger || createLogger("silent");
  const app = Fastify({
    logger: loggerInstance as any,
    disableRequestLogging: true,
  });

  // Register rate limiting and CSRF protection
  app.register(rateLimiter);

  // Register correlation ID middleware
  app.register(correlation);

  // Register Prometheus metrics plugin
  app.register(prometheusPlugin);

  // Structured logging for incoming requests and performance duration.
  // Only the normalized route template and allowlisted, redacted metadata are
  // logged - never `req.url`, which carries wallet addresses, cursors, and
  // other caller-controlled query values (issue #105).
  app.addHook("onRequest", async (req) => {
    (req.raw as any).tempStartTime = performance.now();
    const context = requestLogContext(req);
    req.log.info(
      {
        event: "request_incoming",
        ...context,
        correlation_id: req.correlationId,
        ip: req.ip,
      },
      `Incoming request: ${context.method} ${context.route}`,
    );
  });

  app.addHook("onResponse", async (req, reply) => {
    const startTime = (req.raw as any).tempStartTime || performance.now();
    const duration = performance.now() - startTime;
    const context = requestLogContext(req);
    req.log.info(
      {
        event: "request_completed",
        ...context,
        correlation_id: req.correlationId,
        status_code: reply.statusCode,
        duration_ms: Math.round(duration * 100) / 100,
      },
      `Request completed: ${context.method} ${context.route} -> ${reply.statusCode} (${duration.toFixed(2)}ms)`,
    );
  });

  // Inject CacheService into LedgerService
  const svc = new LedgerService(deps.prisma, deps.cacheService);
  const savedPoolsSvc = new SavedPoolsService(deps.prisma);
  const metricsSvc = new MetricsService(deps.prisma);

  // Privacy Services (issue #76)
  const encryptionSvc = new PrivacyEncryptionService(deps.privacyMasterKey);
  const auditSvc = new PrivacyAuditService(deps.prisma);
  const exportSvc = new PrivacyExportService(deps.prisma, encryptionSvc, auditSvc);
  const deletionSvc = new PrivacyDeletionService(deps.prisma, deps.cacheService, auditSvc);

  // API key guard for external-service endpoints (#273).
  // Guard is a no-op when apiKey is undefined (local dev without configuration).
  const apiKeyGuard = requireApiKey(deps.apiKey);

  // Scrape guard for the raw Prometheus endpoint (#102). Deliberately a
  // separate credential from apiKeyGuard.
  const prometheusScrapeGuard = requireApiKey(deps.prometheusScrapeKey);

  // Export authorization (#10). Deliberately not disabled by absent config:
  // export discloses a wallet's history, so it always demands a principal.
  const serviceAuthGuard = requireServiceAuth(deps.internalSecret);
  const walletAuthGuard = requireWalletAuth({
    apiKey: deps.apiKey,
    internalSecret: deps.internalSecret,
    ...(deps.exportSignatureTtlMs === undefined ? {} : { signatureTtlMs: deps.exportSignatureTtlMs }),
    ...(deps.cacheService === undefined ? {} : { cacheService: deps.cacheService })
  });

  app.register(healthRoutes(svc, deps.prisma, deps.cacheService));
  app.register(actionsRoutes(svc, apiKeyGuard, walletAuthGuard, serviceAuthGuard));
  app.register(savedPoolsRoutes(savedPoolsSvc, walletAuthGuard));
  app.register(internalRoutes(svc, deps.internalSecret));
  app.register(metricsRoutes(metricsSvc, apiKeyGuard));
  app.register(prometheusRoutes(prometheusScrapeGuard));
  app.register(
    privacyRoutes({
      exportSvc,
      deletionSvc,
      encryptionSvc,
      auditSvc,
      prisma: deps.prisma,
      internalSecret: deps.internalSecret,
    })
  );

  // Central Error Handler Middleware
  app.setErrorHandler(errorHandler);

  return app;
}
