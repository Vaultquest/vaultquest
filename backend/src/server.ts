import { buildApp } from "./app.js";
import { getEnv } from "./env.js";
import { getPrisma } from "./db.js";
import { createLogger } from "./logger.js";
import { startReconcilerCron, startQuestCron, startIndexerCron, startBackupCron } from "./cron.js";
import { register } from "prom-client";
import { CacheService } from "./services/cacheService.js";
import { PrometheusCacheSink } from "./services/cache/prometheusSink.js";
import { LedgerService } from "./services/ledger.js";
import {
  StellarIndexer,
  SorobanRpcEventSource,
  defaultXdrDecoder
} from "./services/stellarIndexer.js";
import {
  IndexerConfigError,
  validateIndexerConfig,
  toIndexerHealthMeta,
  type ValidatedIndexerConfig
} from "./services/indexerConfig.js";
import type { ScheduledTask } from "node-cron";

async function main() {
  const env = getEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const prisma = getPrisma(env.DATABASE_URL);

  // Initialize Cache Service (pointing to REDIS_URL if set, otherwise defaults to local Redis)
  const cacheService = new CacheService(
    prisma,
    logger,
    process.env.REDIS_URL,
    undefined,
    new PrometheusCacheSink(register)
  );

  let indexerConfig: ValidatedIndexerConfig | undefined;
  if (env.SOROBAN_RPC_URL && env.INDEXER_CONTRACT_IDS) {
    try {
      indexerConfig = await validateIndexerConfig({
        rpcUrl: env.SOROBAN_RPC_URL,
        contractIdsRaw: env.INDEXER_CONTRACT_IDS,
        expectedNetworkPassphrase: env.SOROBAN_NETWORK_PASSPHRASE
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof IndexerConfigError ? err.code : "INDEXER_CONFIG_INVALID";
      logger.error(
        { err, code },
        `indexer configuration invalid; refusing to start: ${message}`
      );
      process.exit(1);
    }
  }

  const app = buildApp({
    prisma,
    internalSecret: env.INTERNAL_SERVICE_SECRET,
    apiKey: env.API_KEY,
    prometheusScrapeKey: env.PROMETHEUS_SCRAPE_KEY,
    exportSignatureTtlMs: env.EXPORT_SIGNATURE_TTL_MS,
    logger,
    cacheService,
    indexerMeta: toIndexerHealthMeta(indexerConfig)
  });

  // Periodic write-behind sync task: sync checkpoint from cache to PostgreSQL database every 15 seconds
  const cacheSyncInterval = setInterval(async () => {
    try {
      await cacheService.syncCheckpointToDb();
    } catch (err) {
      logger.error({ err }, "failed to sync indexer checkpoint from cache");
    }
  }, 15000);
  cacheSyncInterval.unref();

  const cronTask = startReconcilerCron({
    prisma,
    ttlMinutes: env.ORPHAN_TTL_MINUTES,
    logger
  });

  const questCronTask = startQuestCron({ prisma, logger });

  // Stellar indexer daemon (#indexer). Only started after contract IDs and RPC
  // network identity have been validated (issue #133).
  let indexerCronTask: ScheduledTask | undefined;
  if (indexerConfig) {
    const indexer = new StellarIndexer({
      ledger: new LedgerService(prisma, cacheService),
      source: new SorobanRpcEventSource({
        rpcUrl: indexerConfig.rpcUrl,
        contractIds: indexerConfig.contractIds
      }),
      decoder: defaultXdrDecoder,
      logger
    });
    indexerCronTask = startIndexerCron({ prisma, indexer, logger });
    logger.info(
      {
        contractIds: indexerConfig.contractIds,
        networkPassphrase: indexerConfig.network.passphrase,
        protocolVersion: indexerConfig.network.protocolVersion
      },
      "stellar indexer daemon started"
    );
  }

  // Automated database backup cron (#275). Only started when BACKUP_DIR is set.
  let backupCronTask: ScheduledTask | undefined;
  if (env.BACKUP_DIR) {
    backupCronTask = startBackupCron({
      backupDir: env.BACKUP_DIR,
      databaseUrl: env.DATABASE_URL,
      retainDays: env.BACKUP_RETAIN_DAYS,
      schedule: env.BACKUP_SCHEDULE,
      logger
    });
    logger.info(
      { backupDir: env.BACKUP_DIR, schedule: env.BACKUP_SCHEDULE },
      "backup cron started"
    );
  }

  async function shutdown(signal: string) {
    logger.info({ signal }, "shutting down");
    clearInterval(cacheSyncInterval);
    cronTask.stop();
    questCronTask.stop();
    indexerCronTask?.stop();
    backupCronTask?.stop();
    await app.close();
    await cacheService.disconnect();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    const addr = await app.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info({ addr }, "listening");
  } catch (err) {
    logger.error({ err }, "failed to start");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("fatal startup error", err);
  process.exit(1);
});
