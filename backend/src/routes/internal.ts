import type { FastifyPluginAsync } from "fastify";
import type { LedgerService } from "../services/ledger.js";
import { reconcileBody, checkpointBody } from "../schemas/actions.js";
import { parseEventPayload } from "../schemas/actionPayloads.js";
import { requireServiceAuth } from "../middleware/service-auth.js";
import { validateBody } from "../middleware/validate.js";
import { sanitizeIssuesForClient } from "../middleware/errorHandler.js";
import { ok } from "../responses.js";
import type { z } from "zod";

export const internalRoutes = (svc: LedgerService, secret: string): FastifyPluginAsync =>
  async (app) => {
    const guard = requireServiceAuth(secret);

    app.post("/internal/reconcile", {
      preHandler: [guard, validateBody(reconcileBody)]
    }, async (req, reply) => {
      const body = req.body as z.infer<typeof reconcileBody>;

      // Versioned, size-bounded event payload validation (#109). Legacy event
      // payloads are migrated; unmigratable ones are quarantined.
      const parsedEvent = parseEventPayload(body.event_payload);
      if (!parsedEvent.ok) {
        return reply.status(400).send({
          error: {
            code: "INVALID_PAYLOAD",
            message: "invalid event_payload",
            issues: sanitizeIssuesForClient(parsedEvent.issues),
            ...(parsedEvent.quarantined
              ? { details: { quarantined: true, reason: "legacy event payload could not be migrated to a versioned schema" } }
              : {})
          }
        });
      }

      const result = await svc.reconcileEvent({
        txHash: body.tx_hash,
        sorobanEventId: body.soroban_event_id,
        eventPayload: parsedEvent.payload,
        statusHint: body.status_hint
      });
      if (!result.matched) {
        reply.status(202);
        return ok({ parked: true });
      }
      return ok({ matched: true });
    });

    app.post("/internal/checkpoint", {
      preHandler: [guard, validateBody(checkpointBody)]
    }, async (req) => {
      const body = req.body as z.infer<typeof checkpointBody>;
      await svc.updateIndexerCheckpoint({
        latestLedger: body.latest_ledger,
        lastProcessedEventId: body.last_processed_event_id,
        lastError: body.last_error,
        success: body.success
      });
      return ok({ updated: true });
    });
  };
