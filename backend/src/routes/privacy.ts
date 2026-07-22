import type { FastifyPluginAsync } from "fastify";
import type { PrivacyExportService } from "../services/privacy/privacyExportService.js";
import type { PrivacyDeletionService } from "../services/privacy/privacyDeletionService.js";
import type { PrivacyEncryptionService } from "../services/privacy/privacyEncryptionService.js";
import type { PrivacyAuditService } from "../services/privacy/privacyAuditService.js";
import type { PrismaClient } from "@prisma/client";

export interface PrivacyRoutesDeps {
  exportSvc: PrivacyExportService;
  deletionSvc: PrivacyDeletionService;
  encryptionSvc: PrivacyEncryptionService;
  auditSvc: PrivacyAuditService;
  prisma: PrismaClient;
  internalSecret: string;
}

export function privacyRoutes(deps: PrivacyRoutesDeps): FastifyPluginAsync {
  return async (fastify) => {
    // 1. Authenticated User Export Endpoint
    fastify.get("/api/privacy/export", async (req, reply) => {
      const { walletAddress } = req.query as { walletAddress?: string };
      if (!walletAddress) {
        return reply.status(400).send({ error: "Missing required query parameter: walletAddress" });
      }

      try {
        const bundle = await deps.exportSvc.exportUserData(walletAddress);
        return reply.status(200).send(bundle);
      } catch (err: any) {
        return reply.status(500).send({ error: "Export failed", message: err.message });
      }
    });

    // 2. User Verifiable Deletion Endpoint
    fastify.post("/api/privacy/delete", async (req, reply) => {
      const { walletAddress, actorWallet } = req.body as {
        walletAddress?: string;
        actorWallet?: string;
      };

      if (!walletAddress) {
        return reply.status(400).send({ error: "Missing required body parameter: walletAddress" });
      }

      try {
        const result = await deps.deletionSvc.deleteUserData(walletAddress, actorWallet);
        return reply.status(200).send(result);
      } catch (err: any) {
        return reply.status(500).send({ error: "Deletion failed", message: err.message });
      }
    });

    // 3. Deletion Completion Manifest Status Endpoint
    fastify.get("/api/privacy/deletion-manifest/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const manifest = await deps.deletionSvc.getManifest(id);

      if (!manifest) {
        return reply.status(404).send({ error: "Manifest not found" });
      }
      return reply.status(200).send(manifest);
    });

    // 4. Privileged Legal Hold Endpoint
    fastify.post("/api/privacy/legal-holds", async (req, reply) => {
      const authHeader = req.headers["x-internal-secret"];
      if (authHeader !== deps.internalSecret) {
        return reply.status(401).send({ error: "Unauthorized internal endpoint" });
      }

      const { walletAddress, reason, active, actorWallet } = req.body as {
        walletAddress?: string;
        reason?: string;
        active?: boolean;
        actorWallet?: string;
      };

      if (!walletAddress || active === undefined) {
        return reply
          .status(400)
          .send({ error: "Missing required fields: walletAddress, active" });
      }

      const normalizedWallet = walletAddress.trim();

      if (active) {
        const hold = await deps.prisma.legalHold.upsert({
          where: { walletAddress: normalizedWallet },
          create: {
            walletAddress: normalizedWallet,
            reason: reason || "Compliance Legal Hold",
            createdBy: actorWallet || "admin",
            active: true,
          },
          update: {
            reason: reason || "Compliance Legal Hold",
            createdBy: actorWallet || "admin",
            active: true,
            releasedAt: null,
          },
        });

        await deps.auditSvc.log({
          action: "LEGAL_HOLD_SET",
          actorWallet: actorWallet || "admin",
          targetWallet: normalizedWallet,
          details: { reason: hold.reason },
        });

        return reply.status(200).send(hold);
      } else {
        const hold = await deps.prisma.legalHold.updateMany({
          where: { walletAddress: normalizedWallet },
          data: {
            active: false,
            releasedAt: new Date(),
          },
        });

        await deps.auditSvc.log({
          action: "LEGAL_HOLD_RELEASED",
          actorWallet: actorWallet || "admin",
          targetWallet: normalizedWallet,
        });

        return reply.status(200).send({ success: true, count: hold.count });
      }
    });

    // 5. Privileged Key Rotation Endpoint
    fastify.post("/api/privacy/rotate-keys", async (req, reply) => {
      const authHeader = req.headers["x-internal-secret"];
      if (authHeader !== deps.internalSecret) {
        return reply.status(401).send({ error: "Unauthorized internal endpoint" });
      }

      const { targetKeyVersion } = req.body as { targetKeyVersion?: number };
      if (!targetKeyVersion || targetKeyVersion < 1) {
        return reply.status(400).send({ error: "Invalid targetKeyVersion" });
      }

      const previousVersion = deps.encryptionSvc.getCurrentKeyVersion();
      deps.encryptionSvc.setCurrentKeyVersion(targetKeyVersion);

      await deps.auditSvc.log({
        action: "KEY_ROTATION",
        actorWallet: "system_admin",
        details: { previousVersion, newVersion: targetKeyVersion },
      });

      return reply.status(200).send({
        success: true,
        previousVersion,
        newVersion: targetKeyVersion,
      });
    });
  };
}
