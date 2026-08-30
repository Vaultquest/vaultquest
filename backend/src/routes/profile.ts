import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import type { ProfileService } from "../services/profile.js";
import { profileGetQuery, profileUpdateBody } from "../schemas/profile.js";
import { ok } from "../responses.js";

function serializeProfile(p: Awaited<ReturnType<ProfileService["getProfile"]>>) {
  return {
    wallet_address: p.walletAddress,
    display_name: p.displayName,
    bio: p.bio,
    badge_id: p.badgeId,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString()
  };
}

/**
 * Authenticated profile read/update contract (#134).
 *
 * Both routes hang off `walletAuthGuard`, which binds the caller to a single
 * wallet: a signed wallet may only read/update its own profile, while a service
 * credential may act on any wallet. Because the guard forces the
 * `?wallet=` / `wallet_address` to the authenticated principal for wallet
 * callers, no caller can edit another account's profile.
 *
 * The read response always embeds `achievements`, derived from the wallet's
 * authoritative `user_quests` records by {@link ProfileService}.
 */
export const profileRoutes = (
  svc: ProfileService,
  walletAuthGuard: preHandlerHookHandler
): FastifyPluginAsync =>
  async (app) => {
    app.get("/profile", { preHandler: walletAuthGuard }, async (req) => {
      const q = profileGetQuery.parse(req.query);
      const profile = await svc.getProfile(q.wallet);
      return ok({
        ...serializeProfile(profile),
        achievements: profile.achievements
      });
    });

    app.put("/profile", { preHandler: walletAuthGuard }, async (req) => {
      const body = profileUpdateBody.parse(req.body);
      const updated = await svc.updateProfile(body.wallet_address, {
        displayName: body.profile.display_name === undefined
          ? undefined
          : body.profile.display_name,
        bio: body.profile.bio === undefined ? undefined : body.profile.bio,
        badgeId: body.profile.badge_id === undefined ? undefined : body.profile.badge_id
      });
      return ok({
        ...serializeProfile(updated),
        achievements: updated.achievements
      });
    });
  };
