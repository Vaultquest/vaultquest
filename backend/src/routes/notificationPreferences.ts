import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { notificationPrefsSchema, type NotificationPreferencesService } from "../services/notificationPreferences.js";
import { isValidStellarAddress } from "../utils/stellarKey.js";
import { ok } from "../responses.js";

const wallet = z.string().refine(isValidStellarAddress, "valid Stellar wallet required");
const prefsQuery = z.object({ wallet }).strict();
const historyQuery = z.object({ wallet, limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();
const updateBody = z.object({
  wallet_address: wallet,
  version: z.literal(1).optional(),
  prefs: notificationPrefsSchema,
  expectedRevision: z.number().int().min(0).max(2147483646)
}).strict();

export const notificationPreferencesRoutes = (
  service: NotificationPreferencesService,
  walletAuthGuard: preHandlerHookHandler
): FastifyPluginAsync => async (app) => {
  app.get("/notification-prefs", { preHandler: walletAuthGuard }, async (req, reply) => {
    const query = prefsQuery.parse(req.query);
    reply.header("Cache-Control", "no-store");
    return ok(await service.get(query.wallet));
  });
  app.put("/notification-prefs", { preHandler: walletAuthGuard }, async (req, reply) => {
    const body = updateBody.parse(req.body);
    reply.header("Cache-Control", "no-store");
    return ok(await service.put(body.wallet_address, body.prefs, body.expectedRevision));
  });
  app.get("/notifications", { preHandler: walletAuthGuard }, async (req, reply) => {
    const query = historyQuery.parse(req.query);
    reply.header("Cache-Control", "no-store");
    return ok(await service.history(query.wallet, query.limit));
  });
};
