import { ActionType, ActionStatus, type PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

// Deterministic (v5-style) UUIDs derived from a fixed namespace + label, so a
// given logical action always maps to the same idempotency key across seed
// runs. This keeps the seed idempotent: re-running it produces byte-for-byte
// identical rows instead of fresh random keys on every pass.
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export function deterministicUuid(label: string): string {
  const hash = createHash("sha256")
    .update(UUID_NAMESPACE + label, "utf8")
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

type SeedOptions = {
  logger?: Pick<Console, "log" | "error">;
  now?: number;
};

/**
 * Seeds the action ledger with realistic, representative local data covering
 * every lifecycle event (deposits, prize draws via `select_winner`, rewards/
 * claims, and withdrawals) across multiple pool states, plus failed/reverted/
 * orphaned/pending actions so local development and demos exercise the full
 * status vocabulary.
 *
 * Idempotent by construction: it resets the four seeded tables then recreates
 * rows using deterministic idempotency/`now` values, so re-running produces
 * identical logical content with no duplicate-key conflicts.
 */
export async function seedDatabase(
  db: PrismaClient,
  { logger = console, now = Date.now() }: SeedOptions = {},
): Promise<void> {
  logger.log("Cleaning up database...");
  await db.savedPool.deleteMany({});
  await db.actionLedger.deleteMany({});
  await db.pendingEvent.deleteMany({});
  await db.indexerCheckpoint.deleteMany({});

  logger.log("Seeding indexer checkpoint...");
  await db.indexerCheckpoint.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      latestLedger: 104523,
      lastSyncTime: new Date(now),
      lastSuccessSyncTime: new Date(now),
      lastError: null
    },
    update: {}
  });

  const walletA = "GBX7Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX4Y6A";
  const walletB = "GDY3PJEJZZ4YSLB2CMMMX7R6KCP2PNE7A5PXH5XN265LSL73GOHX7B8Z";
  const walletC = "GCT6Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX9C3C";

  // SavedPool `status` follows the contract's savedPoolStatus enum:
  // open | locked | drawing | settled. These map to the round lifecycle:
  //   open    -> round accepting deposits (active)
  //   locked  -> round opened but not yet accepting deposits / frozen (pending/paused)
  //   drawing -> winner draw in progress (active, near draw)
  //   settled -> round closed, payouts settled (completed/failed)
  logger.log("Seeding mock SavedPool entries...");
  const pools = [
    {
      walletAddress: walletA,
      poolId: "vault-usdc-yield-high",
      poolName: "USDC High Yield Degenerate Vault",
      status: "open",
      tvl: "425900",
      asset: "USDC",
      participantCount: 84,
      expectedYield: "12.4%",
      prize: "5000 USDC"
    },
    {
      walletAddress: walletA,
      poolId: "vault-xlm-lucky-draw",
      poolName: "XLM Lucky Draw Vault",
      status: "drawing",
      tvl: "1050000",
      asset: "XLM",
      participantCount: 312,
      expectedYield: "4.5%",
      prize: "25000 XLM"
    },
    {
      walletAddress: walletB,
      poolId: "vault-yxlm-max-earn",
      poolName: "yXLM Max Earn Vault",
      status: "open",
      tvl: "87000",
      asset: "yXLM",
      participantCount: 19,
      expectedYield: "8.2%",
      prize: null
    },
    {
      walletAddress: walletB,
      poolId: "vault-usdc-yield-high",
      poolName: "USDC High Yield Degenerate Vault",
      status: "open",
      tvl: "425900",
      asset: "USDC",
      participantCount: 84,
      expectedYield: "12.4%",
      prize: "5000 USDC"
    },
    {
      walletAddress: walletC,
      poolId: "vault-aqua-governance-boost",
      poolName: "AQUA Governance Booster Pool",
      status: "locked",
      tvl: "18900",
      asset: "AQUA",
      participantCount: 4,
      expectedYield: "22.1%",
      prize: "100000 AQUA"
    },
    {
      walletAddress: walletC,
      poolId: "vault-btc-safe-reserve",
      poolName: "BTC Safe Reserve",
      status: "open",
      tvl: "15600000",
      asset: "BTC",
      participantCount: 1205,
      expectedYield: "10.1%",
      prize: "0.5 BTC"
    },
    {
      walletAddress: walletA,
      poolId: "vault-meme-momentum-shorts",
      poolName: "Meme Momentum Shorts",
      status: "settled",
      tvl: "0",
      asset: "USDC",
      participantCount: 23,
      expectedYield: "0.0%",
      prize: null
    }
  ];

  for (const pool of pools) {
    await db.savedPool.create({ data: pool });
  }

  logger.log("Seeding mock PendingEvent entries...");
  const pendingEvents = [
    {
      txHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      sorobanEventId: "0000000000000000001-0000000001",
      eventPayload: { schema_version: 1, event_type: "deposit", vault_id: "vault-usdc-yield-high", amount: "500", from: walletA },
      statusHint: "confirmed"
    },
    {
      txHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
      sorobanEventId: "0000000000000000002-0000000001",
      eventPayload: { schema_version: 1, event_type: "withdraw", vault_id: "vault-yxlm-max-earn", amount: "100", from: walletB },
      statusHint: "submitted"
    }
  ];

  for (const event of pendingEvents) {
    await db.pendingEvent.create({ data: event });
  }

  logger.log("Seeding mock ActionLedger logs...");
  const actionsData = [
    // Wallet A
    {
      walletAddress: walletA,
      actionType: ActionType.create_vault,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("a-create-usdc"),
      actionPayload: { schema_version: 1, vault_id: "vault-usdc-yield-high", token: "USDC" },
      txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      submittedAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 10 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("a-dep-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-usdc-yield-high", amount: "1000", token: "USDC" },
      txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
      submittedAt: new Date(now - 9 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 9 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("a-dep-2"),
      actionPayload: { schema_version: 1, vault_id: "vault-xlm-lucky-draw", amount: "5000", token: "XLM" },
      txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      submittedAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 8 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.withdraw,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("a-wd-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-usdc-yield-high", amount: "200", token: "USDC" },
      txHash: "0x4444444444444444444444444444444444444444444444444444444444444444",
      submittedAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 7 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.claim,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("a-claim-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-usdc-yield-high", amount: "50", token: "USDC" },
      txHash: "0x5555555555555555555555555555555555555555555555555555555555555555",
      submittedAt: new Date(now - 6 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 6 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.failed,
      idempotencyKey: deterministicUuid("a-dep-fail"),
      actionPayload: { schema_version: 1, vault_id: "vault-usdc-yield-high", amount: "10000", token: "USDC" },
      txHash: "0x6666666666666666666666666666666666666666666666666666666666666666",
      errorCode: "TX_FAILED",
      errorDetail: "Insufficient liquidity pool allowance",
      submittedAt: new Date(now - 5 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.reverted,
      idempotencyKey: deterministicUuid("a-dep-revert"),
      actionPayload: { schema_version: 1, vault_id: "vault-xlm-lucky-draw", amount: "2000", token: "XLM" },
      txHash: "0x7777777777777777777777777777777777777777777777777777777777777777",
      errorCode: "REVERTED_ON_CHAIN",
      submittedAt: new Date(now - 4 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 4 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.deposit,
      status: ActionStatus.pending,
      idempotencyKey: deterministicUuid("a-dep-pending"),
      actionPayload: { schema_version: 1, vault_id: "vault-usdc-yield-high", amount: "150", token: "USDC" }
    },
    {
      walletAddress: walletA,
      actionType: ActionType.withdraw,
      status: ActionStatus.submitted,
      idempotencyKey: deterministicUuid("a-wd-submitted"),
      actionPayload: { schema_version: 1, vault_id: "vault-usdc-yield-high", amount: "50", token: "USDC" },
      txHash: "0x8888888888888888888888888888888888888888888888888888888888888888",
      submittedAt: new Date(now - 10 * 60 * 1000)
    },
    {
      walletAddress: walletA,
      actionType: ActionType.select_winner,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("a-selwin"),
      actionPayload: { schema_version: 1, vault_id: "vault-xlm-lucky-draw", winner: walletA },
      txHash: "0x9999999999999999999999999999999999999999999999999999999999999999",
      submittedAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 3 * 24 * 60 * 60 * 1000)
    },

    // Wallet B
    {
      walletAddress: walletB,
      actionType: ActionType.create_vault,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("b-create-yxlm"),
      actionPayload: { schema_version: 1, vault_id: "vault-yxlm-max-earn", token: "yXLM" },
      txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      submittedAt: new Date(now - 15 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 15 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("b-dep-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-yxlm-max-earn", amount: "10000", token: "yXLM" },
      txHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      submittedAt: new Date(now - 14 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 14 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("b-dep-2"),
      actionPayload: { schema_version: 1, vault_id: "vault-usdc-yield-high", amount: "500", token: "USDC" },
      txHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      submittedAt: new Date(now - 13 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 13 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.withdraw,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("b-wd-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-yxlm-max-earn", amount: "1500", token: "yXLM" },
      txHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      submittedAt: new Date(now - 12 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 12 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.deposit,
      status: ActionStatus.orphaned,
      idempotencyKey: deterministicUuid("b-dep-orphan"),
      actionPayload: { schema_version: 1, vault_id: "vault-yxlm-max-earn", amount: "200", token: "yXLM" },
      txHash: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      errorCode: "ORPHAN_TTL_EXPIRED",
      submittedAt: new Date(now - 20 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletB,
      actionType: ActionType.deposit,
      status: ActionStatus.pending,
      idempotencyKey: deterministicUuid("b-dep-pending"),
      actionPayload: { schema_version: 1, vault_id: "vault-yxlm-max-earn", amount: "300", token: "yXLM" }
    },
    {
      walletAddress: walletB,
      actionType: ActionType.claim,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("b-claim-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-yxlm-max-earn", amount: "210", token: "yXLM" },
      txHash: "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
      submittedAt: new Date(now - 19 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 19 * 24 * 60 * 60 * 1000)
    },

    // Wallet C
    {
      walletAddress: walletC,
      actionType: ActionType.create_vault,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("c-create-aqua"),
      actionPayload: { schema_version: 1, vault_id: "vault-aqua-governance-boost", token: "AQUA" },
      txHash: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      submittedAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 5 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("c-dep-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-aqua-governance-boost", amount: "50000", token: "AQUA" },
      txHash: "0x1212121212121212121212121212121212121212121212121212121212121212",
      submittedAt: new Date(now - 4 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 4 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.withdraw,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("c-wd-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-aqua-governance-boost", amount: "10000", token: "AQUA" },
      txHash: "0x1313131313131313131313131313131313131313131313131313131313131313",
      submittedAt: new Date(now - 3 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 3 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.deposit,
      status: ActionStatus.pending,
      idempotencyKey: deterministicUuid("c-dep-pending"),
      actionPayload: { schema_version: 1, vault_id: "vault-aqua-governance-boost", amount: "25000", token: "AQUA" }
    },
    {
      walletAddress: walletC,
      actionType: ActionType.deposit,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("c-dep-2"),
      actionPayload: { schema_version: 1, vault_id: "vault-btc-safe-reserve", amount: "0.1", token: "BTC" },
      txHash: "0x2323232323232323232323232323232323232323232323232323232323232323",
      submittedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 2 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.claim,
      status: ActionStatus.confirmed,
      idempotencyKey: deterministicUuid("c-claim-1"),
      actionPayload: { schema_version: 1, vault_id: "vault-btc-safe-reserve", amount: "0.008", token: "BTC" },
      txHash: "0x2525252525252525252525252525252525252525252525252525252525252525",
      submittedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
      confirmedAt: new Date(now - 1 * 24 * 60 * 60 * 1000)
    },
    {
      walletAddress: walletC,
      actionType: ActionType.withdraw,
      status: ActionStatus.failed,
      idempotencyKey: deterministicUuid("c-wd-fail"),
      actionPayload: { schema_version: 1, vault_id: "vault-btc-safe-reserve", amount: "0.05", token: "BTC" },
      txHash: "0x2424242424242424242424242424242424242424242424242424242424242424",
      errorCode: "INSUFFICIENT_FUNDS",
      submittedAt: new Date(now - 1 * 24 * 60 * 60 * 1000)
    }
  ];

  for (const act of actionsData) {
    await db.actionLedger.create({ data: act });
  }

  logger.log(`Seeding complete! Added ${pools.length} pools and ${actionsData.length} action ledger logs.`);
}
