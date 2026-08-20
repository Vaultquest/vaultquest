import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { getPrometheusMetrics } from "../services/prometheusMetrics.js";

/**
 * Prometheus metrics endpoint
 * Exposes metrics in the OpenMetrics text format.
 *
 * Protected by a dedicated scrape credential (issue #102): the raw endpoint
 * exposes process, database, action, cache, and indexer telemetry, so it
 * must not be reachable by anonymous public requests. `scrapeGuard` is a
 * preHandler that enforces `X-Api-Key: <PROMETHEUS_SCRAPE_KEY>` and is a
 * no-op only when no scrape key is configured (local dev).
 */
export const prometheusRoutes = (scrapeGuard: preHandlerHookHandler): FastifyPluginAsync => async (app) => {
  const metrics = getPrometheusMetrics(app.log);

  app.get(
    "/metrics",
    {
      // Disable rate limiting for metrics endpoint to allow frequent scrapes
      // from an authenticated/trusted scraper.
      config: { rateLimit: false },
      preHandler: scrapeGuard,
    },
    async (req, reply) => {
      try {
        const metricsOutput = await metrics.metrics();
        reply.type(metrics.getContentType());
        return reply.send(metricsOutput);
      } catch (err) {
        app.log.error(err, "Failed to generate metrics");
        reply.status(500);
        return reply.send({ error: "Failed to generate metrics" });
      }
    },
  );
};
