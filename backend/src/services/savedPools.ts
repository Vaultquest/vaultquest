import type { PrismaClient } from "@prisma/client";

/**
 * Persists user-saved vault/pool references for quick access and watchlists.
 */

export interface SavedPoolDetails {
  poolId: string;
  poolName: string;
  status: string;
  tvl: string;
  asset: string;
  participantCount: number;
  expectedYield: string;
  prize?: string | null;
  opensAt?: Date | null;
  locksAt?: Date | null;
  drawsAt?: Date | null;
}

export interface SavedPoolInput {
  walletAddress: string;
  pool: SavedPoolDetails;
}

export interface SavedPoolRecord {
  id: string;
  walletAddress: string;
  poolId: string;
  poolName: string;
  status: string;
  tvl: string;
  asset: string;
  participantCount: number;
  expectedYield: string;
  prize: string | null;
  opensAt: Date | null;
  locksAt: Date | null;
  drawsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Manages saved pool records linked to user wallets. Every read and write is
 * scoped by `walletAddress` so one wallet can never see or mutate another
 * wallet's saved pools.
 */
export class SavedPoolsService {
  /**
   * @param prisma - Prisma client for database access
   */
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Saves (or updates) a pool reference for a wallet.
   *
   * @param input - Wallet and pool details to persist
   * @returns The saved record and whether it was newly created
   */
  async savePool(input: SavedPoolInput): Promise<{ record: SavedPoolRecord; created: boolean }> {
    const existing = await this.prisma.savedPool.findUnique({
      where: {
        walletAddress_poolId: {
          walletAddress: input.walletAddress,
          poolId: input.pool.poolId
        }
      }
    });

    const data = {
      poolName: input.pool.poolName,
      status: input.pool.status,
      tvl: input.pool.tvl,
      asset: input.pool.asset,
      participantCount: input.pool.participantCount,
      expectedYield: input.pool.expectedYield,
      prize: input.pool.prize ?? null,
      opensAt: input.pool.opensAt ?? null,
      locksAt: input.pool.locksAt ?? null,
      drawsAt: input.pool.drawsAt ?? null
    };

    if (existing) {
      const updated = await this.prisma.savedPool.update({
        where: {
          walletAddress_poolId: {
            walletAddress: input.walletAddress,
            poolId: input.pool.poolId
          }
        },
        data
      });
      return { record: updated as unknown as SavedPoolRecord, created: false };
    }

    const created = await this.prisma.savedPool.create({
      data: {
        walletAddress: input.walletAddress,
        poolId: input.pool.poolId,
        ...data
      }
    });

    return { record: created as unknown as SavedPoolRecord, created: true };
  }

  /**
   * Removes a saved pool reference for a wallet. Scoped by `walletAddress`
   * so it can never delete another wallet's saved pool, even if the poolId
   * matches.
   *
   * @param walletAddress - Wallet identifier
   * @param poolId - Pool identifier
   * @returns Number of records removed
   */
  async unsavePool(walletAddress: string, poolId: string): Promise<number> {
    const result = await this.prisma.savedPool.deleteMany({
      where: { walletAddress, poolId }
    });
    return result.count;
  }

  /**
   * Lists all saved pools for a wallet. Scoped by `walletAddress` so it can
   * never return another wallet's saved pools.
   *
   * @param walletAddress - Wallet identifier
   * @returns Saved pool records
   */
  async listSavedPools(walletAddress: string): Promise<SavedPoolRecord[]> {
    const rows = await this.prisma.savedPool.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" }
    });

    return rows as unknown as SavedPoolRecord[];
  }
}
