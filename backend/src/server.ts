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
import type { ScheduledTask } from "node-cron";
import { JobLeaseService } from "./services/jobLeaseService.js";

const env = getEnv();
const logger = createLogger(env.LOG_LEVEL);
const prisma = getPrisma(env.DATABASE_URL);

const leases = new JobLeaseService({ prisma, logger });

// Initialize Cache Service (pointing to REDIS_URL if set, otherwise defaults to local Redis)
const cacheService = new CacheService(prisma, logger, process.env.REDIS_URL, undefined, new PrometheusCacheSink(register));

const app = buildApp({
  prisma,
  internalSecret: env.INTERNAL_SERVICE_SECRET,
  apiKey: env.API_KEY,
  prometheusScrapeKey: env.PROMETHEUS_SCRAPE_KEY,
  exportSignatureTtlMs: env.EXPORT_SIGNATURE_TTL_MS,
  logger,
  cacheService
});

// Indexer checkpoints commit in the lease-fenced database transaction. There
// must be no later, unleased Redis write-behind that can overwrite a new owner.

const cronTask = startReconcilerCron({
  prisma,
  ttlMinutes: env.ORPHAN_TTL_MINUTES,
  logger,
  leases
});

const questCronTask = startQuestCron({ prisma, logger, leases });

// Stellar indexer daemon (#indexer). Only started when a Soroban RPC endpoint
// and at least one contract id are configured.
let indexerCronTask: ScheduledTask | undefined;
if (env.SOROBAN_RPC_URL && env.INDEXER_CONTRACT_IDS) {
  const contractIds = env.INDEXER_CONTRACT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  const indexer = new StellarIndexer({
    ledger: new LedgerService(prisma, cacheService),
    source: new SorobanRpcEventSource({ rpcUrl: env.SOROBAN_RPC_URL, contractIds }),
    decoder: defaultXdrDecoder,
    logger
  });
  indexerCronTask = startIndexerCron({ prisma, indexer, logger, leases });
  logger.info({ contractIds }, "stellar indexer daemon started");
}

// Automated database backup cron (#275). Only started when BACKUP_DIR is set.
let backupCronTask: ScheduledTask | undefined;
if (env.BACKUP_DIR) {
  backupCronTask = startBackupCron({
    backupDir: env.BACKUP_DIR,
    databaseUrl: env.DATABASE_URL,
    retainDays: env.BACKUP_RETAIN_DAYS,
    schedule: env.BACKUP_SCHEDULE,
    logger,
    leases
  });
  logger.info(
    { backupDir: env.BACKUP_DIR, schedule: env.BACKUP_SCHEDULE },
    "backup cron started"
  );
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  cronTask.stop();
  questCronTask.stop();
  indexerCronTask?.stop();
  backupCronTask?.stop();
  await leases.shutdown();
  await app.close();
  await cacheService.disconnect();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then((addr) => logger.info({ addr }, "listening"))
  .catch((err) => {
    logger.error({ err }, "failed to start");
    process.exit(1);
  });
