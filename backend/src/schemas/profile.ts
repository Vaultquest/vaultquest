import { z } from "zod";

/**
 * Request schemas for the authenticated profile contract (#134).
 *
 * Only explicit, safe, user-editable fields are accepted. `wallet_address` is
 * present in the body purely to satisfy the wallet-auth guard's identity
 * binding (it is forced to match the authenticated principal); it is never an
 * editable field. `badge_id` is validated against the wallet's earned quests in
 * the service layer.
 */

export const profileGetQuery = z.object({
  wallet: z.string().min(1).max(120)
});

const profileFields = z
  .object({
    display_name: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .optional()
      .nullable(),
    bio: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .optional()
      .nullable(),
    badge_id: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .nullable()
  })
  // At least one field must actually change to persist.
  .refine((v) => Object.keys(v).length > 0, {
    message: "at least one profile field must be provided"
  });

export const profileUpdateBody = z.object({
  wallet_address: z.string().min(1).max(120),
  profile: profileFields
});
