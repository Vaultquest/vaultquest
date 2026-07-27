import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type AuditPrivacyAction =
  | "DECRYPT"
  | "EXPORT"
  | "DELETE_REQUESTED"
  | "DELETE_COMPLETED"
  | "DELETE_BLOCKED_LEGAL_HOLD"
  | "LEGAL_HOLD_SET"
  | "LEGAL_HOLD_RELEASED"
  | "KEY_ROTATION";

export interface AuditLogOptions {
  action: AuditPrivacyAction;
  actorWallet?: string;
  targetWallet?: string;
  details?: Record<string, unknown>;
}

export class PrivacyAuditService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Generates anonymized wallet hash for audit records to avoid storing raw PII in audit logs.
   */
  public hashWallet(walletAddress?: string): string | null {
    if (!walletAddress) return null;
    return createHash("sha256")
      .update(`audit_salt:${walletAddress.toLowerCase()}`)
      .digest("hex")
      .substring(0, 16);
  }

  /**
   * Sanitizes details object by removing or redacting any sensitive PII fields.
   */
  private redactDetails(details?: Record<string, unknown>): Record<string, unknown> {
    if (!details) return {};
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(details)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("password") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("ip") ||
        lowerKey.includes("payload") ||
        lowerKey.includes("email") ||
        lowerKey.includes("evidence")
      ) {
        sanitized[key] = "[REDACTED_AUDIT]";
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        sanitized[key] = this.redactDetails(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  async log(opts: AuditLogOptions): Promise<void> {
    const actorHash = this.hashWallet(opts.actorWallet);
    const targetHash = this.hashWallet(opts.targetWallet);
    const sanitizedDetails = this.redactDetails(opts.details);

    await this.prisma.privacyAuditLog.create({
      data: {
        action: opts.action,
        actorWalletHash: actorHash,
        targetWalletHash: targetHash,
        details: sanitizedDetails as object,
      },
    });
  }

  async getLogsForTarget(targetWallet: string) {
    const targetHash = this.hashWallet(targetWallet);
    return this.prisma.privacyAuditLog.findMany({
      where: { targetWalletHash: targetHash },
      orderBy: { createdAt: "desc" },
    });
  }
}
