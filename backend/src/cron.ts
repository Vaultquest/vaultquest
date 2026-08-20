import cron from "node-cron";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { sweepOrphans } from "./services/reconciler.js";
import { QuestService } from "./services/questService.js";
import {
  BackupService,
  type RemoteStorageAdapter,
  type DbRestoreRunner
} from "./services/backupService.js";
import type { StellarIndexer } from "./services/stellarIndexer.js";
import { pingDatabase } from "./db.js";

export function startReconcilerCron(opts: {
  prisma: PrismaClient;
  ttlMinutes: number;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/1 * * * *";
  const task = cron.schedule(schedule, async () => {
    try {
      const result = await sweepOrphans(opts.prisma, { ttlMinutes: opts.ttlMinutes });
      opts.logger.info({ result }, "reconciler sweep complete");
    } catch (err) {
      opts.logger.error({ err }, "reconciler sweep failed");
    }
  });
  return task;
}

/**
 * Periodically re-evaluates savings quests for wallets with recently confirmed
 * ledger activity (#26). The lookback window is kept slightly larger than the
 * schedule interval so a slow tick never skips a wallet.
 */
export function startQuestCron(opts: {
  prisma: PrismaClient;
  logger: Logger;
  schedule?: string;
  lookbackMinutes?: number;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/2 * * * *";
  const lookbackMinutes = opts.lookbackMinutes ?? 10;
  const questService = new QuestService(opts.prisma);

  const task = cron.schedule(schedule, async () => {
    const since = new Date(Date.now() - lookbackMinutes * 60 * 1000);
    try {
      const result = await questService.evaluateRecent(since);
      opts.logger.info({ result }, "quest evaluation sweep complete");
    } catch (err) {
      opts.logger.error({ err }, "quest evaluation sweep failed");
    }
  });
  return task;
}

/**
 * Drives the Stellar indexer daemon on a schedule (#indexer). Each tick polls
 * Horizon for new contract events and reconciles them into the ledger. The
 * tick is skipped when the database is unreachable so we never fetch events we
 * cannot persist.
 */
export function startIndexerCron(opts: {
  prisma: PrismaClient;
  indexer: StellarIndexer;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "*/1 * * * *";
  const task = cron.schedule(schedule, async () => {
    try {
      if (!(await pingDatabase(opts.prisma))) {
        opts.logger.warn({}, "indexer tick skipped: database unreachable");
        return;
      }
      const result = await opts.indexer.tick();
      opts.logger.info({ result }, "indexer tick complete");
    } catch (err) {
      opts.logger.error({ err }, "indexer tick failed");
    }
  });
  return task;
}

/**
 * Runs automated PostgreSQL backups on a schedule (issues #275 & #112).
 *
 * Each tick calls `BackupService.run()` which shells out to `pg_dump`,
 * computes SHA-256 checksums, generates manifests, replicates off-site,
 * and prunes files older than `retainDays`.
 */
export function startBackupCron(opts: {
  backupDir: string;
  databaseUrl: string;
  retainDays?: number;
  remoteRetainDays?: number;
  remoteImmutableDays?: number;
  pgDumpPath?: string;
  remoteStorage?: RemoteStorageAdapter;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "0 2 * * *"; // default: daily at 02:00
  const svc = new BackupService({
    backupDir: opts.backupDir,
    databaseUrl: opts.databaseUrl,
    retainDays: opts.retainDays,
    remoteRetainDays: opts.remoteRetainDays,
    remoteImmutableDays: opts.remoteImmutableDays,
    pgDumpPath: opts.pgDumpPath,
    remoteStorage: opts.remoteStorage,
    logger: opts.logger
  });

  const task = cron.schedule(schedule, async () => {
    try {
      const result = await svc.run();
      opts.logger.info({ result }, "backup: completed");
    } catch (err) {
      opts.logger.error({ err }, "backup: failed");
    }
  });
  return task;
}

/**
 * Runs automated PostgreSQL restore verification drills on a schedule (issue #112).
 */
export function startRestoreDrillCron(opts: {
  backupDir: string;
  databaseUrl: string;
  maxRtoMs?: number;
  maxRpoMinutes?: number;
  pgRestorePath?: string;
  restoreRunner?: DbRestoreRunner;
  logger: Logger;
  schedule?: string;
}): cron.ScheduledTask {
  const schedule = opts.schedule ?? "0 4 * * 0"; // default: weekly at 04:00 on Sunday
  const svc = new BackupService({
    backupDir: opts.backupDir,
    databaseUrl: opts.databaseUrl,
    maxRtoMs: opts.maxRtoMs,
    maxRpoMinutes: opts.maxRpoMinutes,
    pgRestorePath: opts.pgRestorePath,
    restoreRunner: opts.restoreRunner,
    logger: opts.logger
  });

  const task = cron.schedule(schedule, async () => {
    try {
      const result = await svc.runRestoreDrill();
      if (!result.success) {
        opts.logger.error({ result }, "restore verification drill failed");
      } else {
        opts.logger.info({ result }, "restore verification drill completed successfully");
      }
    } catch (err) {
      opts.logger.error({ err }, "restore verification drill errored out");
    }
  });
  return task;
}
