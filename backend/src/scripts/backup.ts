/**
 * Standalone database backup script (issues #275 & #112).
 *
 * Run manually or from a CI/deployment pipeline:
 *
 *   tsx src/scripts/backup.ts [--verify]
 *
 * Reads the same env vars as the server process:
 *   DATABASE_URL                 – PostgreSQL connection string (required)
 *   BACKUP_DIR                   – Directory to store dump files (required)
 *   BACKUP_RETAIN_DAYS           – Days of local backups to keep (default 7)
 *   BACKUP_REMOTE_RETENTION_DAYS – Days of remote backups to keep
 *   BACKUP_REMOTE_IMMUTABLE_DAYS – Remote immutability period in days (default 0)
 *
 * Exit codes:
 *   0  – backup (and optional restore drill) succeeded
 *   1  – backup or restore drill failed (error printed to stderr)
 */

import { getEnv } from "../env.js";
import { BackupService } from "../services/backupService.js";
import { createLogger } from "../logger.js";

const env = getEnv();
const logger = createLogger(env.LOG_LEVEL);
const verifyFlag = process.argv.includes("--verify");

if (!env.BACKUP_DIR) {
  console.error(
    "backup: BACKUP_DIR is not set. Set it to an absolute path and re-run."
  );
  process.exit(1);
}

const svc = new BackupService({
  backupDir: env.BACKUP_DIR,
  databaseUrl: env.DATABASE_URL,
  retainDays: env.BACKUP_RETAIN_DAYS,
  remoteRetainDays: env.BACKUP_REMOTE_RETENTION_DAYS,
  remoteImmutableDays: env.BACKUP_REMOTE_IMMUTABLE_DAYS,
  maxRtoMs: env.BACKUP_MAX_RTO_MS,
  maxRpoMinutes: env.BACKUP_MAX_RPO_MINUTES,
  pgDumpPath: "pg_dump",
  pgRestorePath: env.BACKUP_PG_RESTORE_PATH,
  logger
});

async function main() {
  const result = await svc.run();
  logger.info(result, "backup: finished");
  console.log(
    `backup: wrote ${result.filePath} (manifest: ${result.manifestPath}, sha256: ${result.checksumSha256.substring(
      0,
      12
    )}...) in ${result.durationMs}ms, pruned ${result.pruned} local / ${result.prunedRemote ?? 0} remote file(s)`
  );

  if (verifyFlag) {
    console.log("backup: running restore verification drill...");
    const drillResult = await svc.runRestoreDrill({ dumpFilePath: result.filePath });
    if (!drillResult.success) {
      throw new Error(`Restore verification drill failed: ${drillResult.error}`);
    }
    console.log(
      `backup: restore verification drill passed in ${drillResult.rtoMs}ms (RPO: ${drillResult.rpoMinutes}m, smoke checks: passed)`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "backup: failed");
    console.error(`backup: failed — ${message}`);
    process.exit(1);
  });
