import type { PrismaClient } from "@prisma/client";
import type { CacheService } from "./cacheService.js";

export type MetricFreshnessMetadata = {
  sourceLedger: number;
  freshnessAt: string | null;
  status: "healthy" | "stale" | "unavailable";
  reason?: string;
};

export class MetricsService {
  constructor(
    private prisma: PrismaClient,
    private cacheService?: CacheService
  ) {}

  private async getFreshnessMetadata(staleAfterMs = 5 * 60 * 1000): Promise<MetricFreshnessMetadata> {
    const checkpoint = this.cacheService
      ? await this.cacheService.getCheckpoint()
      : await this.prisma.indexerCheckpoint.findUnique({
          where: { id: "singleton" }
        });

    if (!checkpoint) {
      return {
        sourceLedger: 0,
        freshnessAt: null,
        status: "unavailable",
        reason: "No indexer checkpoint found"
      };
    }

    const now = Date.now();
    const lastSuccessSync = checkpoint.lastSuccessSyncTime
      ? new Date(checkpoint.lastSuccessSyncTime).getTime()
      : 0;

    let status: "healthy" | "stale" | "unavailable" = "healthy";
    let reason: string | undefined;

    if (checkpoint.lastError) {
      status = "unavailable";
      reason = `Indexer error: ${checkpoint.lastError}`;
    } else if (!lastSuccessSync || now - lastSuccessSync > staleAfterMs) {
      status = "stale";
      reason = "Indexer checkpoint is stale";
    }

    return {
      sourceLedger: checkpoint.latestLedger ?? 0,
      freshnessAt: checkpoint.lastSuccessSyncTime
        ? new Date(checkpoint.lastSuccessSyncTime).toISOString()
        : null,
      status,
      ...(reason ? { reason } : {})
    };
  }

  async getProtocolSummary() {
    const freshness = await this.getFreshnessMetadata();
    const pools = await this.prisma.savedPool.findMany({
      where: { status: "active" }
    });

    let totalDeposits = 0;
    let activeParticipants = 0;

    for (const pool of pools) {
      totalDeposits += parseFloat(pool.tvl || "0");
      activeParticipants += pool.participantCount || 0;
    }

    return {
      totalVaultDeposits: totalDeposits,
      activeParticipants,
      totalVaults: pools.length,
      freshness
    };
  }

  async getCurrentRoundStatus() {
    const freshness = await this.getFreshnessMetadata();

    const activePool = await this.prisma.savedPool.findFirst({
      where: { status: "active" },
      orderBy: { createdAt: "desc" }
    });

    const settlementsCount = await this.prisma.vaultSettlement.count({
      where: { state: "Resolved" }
    });
    const roundNumber = settlementsCount + 1;

    let prizePool = "0.00";
    let drawDate: string | null = null;
    let roundStatus = "inactive";

    if (activePool) {
      roundStatus = "active";
      if (activePool.prize) {
        prizePool = activePool.prize;
      }
      if (activePool.drawsAt) {
        drawDate = activePool.drawsAt.toISOString();
      }
    }

    return {
      roundNumber,
      status: roundStatus,
      drawDate,
      prizePool,
      freshness
    };
  }

  async getHistoricalSummary() {
    const freshness = await this.getFreshnessMetadata();

    const actionCount = await this.prisma.actionLedger.count();
    const resolvedSettlements = await this.prisma.vaultSettlement.findMany({
      where: { state: "Resolved" }
    });

    const roundsCompleted = resolvedSettlements.length;
    let totalPrizesDistributed = 0;

    for (const settlement of resolvedSettlements) {
      if (settlement.amount) {
        totalPrizesDistributed += parseFloat(settlement.amount || "0");
      }
    }

    return {
      totalActions: actionCount,
      roundsCompleted,
      totalPrizesDistributed: totalPrizesDistributed.toFixed(2),
      freshness
    };
  }
}

