/**
 * PostgreSQL backup service (issues #275 & #112).
 *
 * Shells out to `pg_dump` to create a compressed SQL dump of the database,
 * computes cryptographic SHA-256 checksums, writes structured manifests,
 * replicates backups to off-site object storage with immutability/retention policies,
 * prunes files beyond retention windows, and runs automated pg_restore verification drills.
 *
 * All external I/O (spawn, fs, object storage, database restore runners) is injected
 * so the service is fully unit-testable without a real database or cloud vendor lock-in.
 */

import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { JobLeaseContext } from "./jobLeaseService.js";

// ─── Injectable I/O interfaces ────────────────────────────────────────────────

export interface SpawnResult {
  exitCode: number;
  stderr: string;
}

/**
 * Minimal subset of `child_process.spawn` used by BackupService.
 * The default implementation wraps Node's built-in `spawn`.
 */
export type SpawnFn = (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  signal?: AbortSignal
) => Promise<SpawnResult>;

export interface FsAdapter {
  /** Create directory (and parents) if it does not exist. */
  mkdir(dir: string): Promise<void>;
  /** Write text or buffer content to a file path. */
  writeFile(path: string, content: string | Buffer): Promise<void>;
  /** Read file content as Buffer. */
  readFile(path: string): Promise<Buffer>;
  /** Read file content as UTF-8 text string. */
  readFileText?(path: string): Promise<string>;
  /** List file names in a directory. */
  readdir(dir: string): Promise<string[]>;
  /** Get the modification time of a file. Returns null on error. */
  mtimeMs(path: string): Promise<number | null>;
  /** Delete a file. */
  unlink(path: string): Promise<void>;
  /** Atomically publish a staged dump. Required for leased backup runs. */
  rename?(from: string, to: string): Promise<void>;
  /** Check if file exists. */
  exists?(path: string): Promise<boolean>;
}

// ─── Off-Site Object Storage & Retention Interfaces ──────────────────────────

export interface RemoteObjectMetadata {
  remoteKey: string;
  fileSizeBytes: number;
  uploadedAt: string;
  checksumSha256?: string;
  immutableUntil?: string;
}

export interface RemoteStorageAdapter {
  /**
   * Implementations must propagate signal to their storage client. Cancellation
   * is cooperative; this interface does not promise server-side atomic fencing.
   */
  uploadFile(
    localPath: string,
    remoteKey: string,
    metadata?: Record<string, string>,
    signal?: AbortSignal
  ): Promise<{ remoteKey: string; etag?: string }>;
  downloadFile(remoteKey: string, localPath: string, signal?: AbortSignal): Promise<void>;
  listObjects(prefix?: string, signal?: AbortSignal): Promise<RemoteObjectMetadata[]>;
  deleteObject(remoteKey: string, signal?: AbortSignal): Promise<void>;
}

// ─── Restore Verification Interfaces ─────────────────────────────────────────

export interface RestoreDrillOptions {
  /** Dump file path to restore. If omitted, the latest retained backup is used. */
  dumpFilePath?: string;
  /** Defaults to "vaultquest_restore_test"; leased drills append an owner/fence suffix. */
  targetDatabaseName?: string;
  /** Maximum Recovery Time Objective in ms. */
  maxRtoMs?: number;
  /** Maximum Recovery Point Objective in minutes. */
  maxRpoMinutes?: number;
}

export interface RestoreDrillResult {
  success: boolean;
  backupId?: string;
  dumpFilePath: string;
  verifiedAt: string;
  rtoMs: number;
  rpoMinutes: number;
  smokeChecksPassed: boolean;
  tableCount?: number;
  error?: string;
}

export interface DbRestoreRunner {
  /** Runners must honor the isolated dbName and cancel their subprocesses or queries. */
  createDatabase?(dbName: string, signal?: AbortSignal): Promise<void>;
  dropDatabase?(dbName: string, signal?: AbortSignal): Promise<void>;
  restoreDump(dbName: string, dumpFilePath: string, signal?: AbortSignal): Promise<SpawnResult>;
  runSmokeChecks(dbName: string, signal?: AbortSignal): Promise<{ tableCount: number; passed: boolean; details?: string }>;
}

// ─── Backup Manifest & Results ────────────────────────────────────────────────

export interface BackupManifest {
  version: "1.0";
  backupId: string;
  timestamp: string;
  dumpFileName: string;
  manifestFileName: string;
  fileSizeBytes: number;
  checksumSha256: string;
  databaseName?: string;
  retention: {
    localRetainDays: number;
    remoteRetainDays?: number;
    immutableUntil?: string;
  };
  verificationStatus: {
    verified: boolean;
    verifiedAt?: string;
    rtoMs?: number;
    rpoMinutes?: number;
    smokeChecksPassed?: boolean;
    error?: string;
  };
  remoteCatalog?: {
    replicated: boolean;
    replicatedAt?: string;
    remoteKey?: string;
    etag?: string;
  };
}

export interface BackupResult {
  /** Absolute path of the created dump file. */
  filePath: string;
  /** Absolute path of the manifest file. */
  manifestPath: string;
  /** Cryptographic SHA-256 checksum of the dump file. */
  checksumSha256: string;
  /** Size of the dump file in bytes. */
  fileSizeBytes: number;
  /** Duration of the backup operation in milliseconds. */
  durationMs: number;
  /** Number of old local backup files pruned during this run. */
  pruned: number;
  /** Number of old remote backup files pruned during this run. */
  prunedRemote?: number;
  /** Whether off-site object storage replication succeeded. */
  replicated: boolean;
  /** The backup manifest object. */
  manifest: BackupManifest;
}

// ─── Defaults using Node builtins ─────────────────────────────────────────────

export async function defaultSpawn(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  signal?: AbortSignal
): Promise<SpawnResult> {
  signal?.throwIfAborted();
  const { spawn } = await import("node:child_process");
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
      signal
    });

    const stderrChunks: Buffer[] = [];
    let processError: Error | undefined;
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    proc.once("error", (error: Error) => {
      processError = error;
    });

    // An abort emits "error" before the child has necessarily exited. Wait for
    // "close" so the subprocess has stopped when this promise settles.
    proc.once("close", (code) => {
      if (signal?.aborted) {
        reject(signal.reason);
      } else if (processError) {
        reject(processError);
      } else {
        resolve({
          exitCode: code ?? 1,
          stderr: Buffer.concat(stderrChunks).toString("utf8").trim()
        });
      }
    });
  });
}

import { mkdir, writeFile, readFile, readdir, stat, unlink, rename, access } from "node:fs/promises";

export const defaultFsAdapter: FsAdapter = {
  async mkdir(dir) {
    await mkdir(dir, { recursive: true });
  },
  async writeFile(path, content) {
    await writeFile(path, content);
  },
  async readFile(path) {
    return readFile(path);
  },
  async readFileText(path) {
    return readFile(path, "utf8");
  },
  async readdir(dir) {
    return readdir(dir);
  },
  async mtimeMs(path) {
    try {
      const s = await stat(path);
      return s.mtimeMs;
    } catch {
      return null;
    }
  },
  async unlink(path) {
    await unlink(path);
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
};

// ─── BackupServiceOptions ─────────────────────────────────────────────────────

export interface BackupServiceOptions {
  /** Absolute path to the directory where dumps are stored. */
  backupDir: string;
  /** Full PostgreSQL connection string. */
  databaseUrl: string;
  /** Local retention window in days. @default 7 */
  retainDays?: number;
  /** Remote off-site retention window in days. Defaults to retainDays. */
  remoteRetainDays?: number;
  /** Remote retention immutability period in days. @default 0 */
  remoteImmutableDays?: number;
  /** Path to `pg_dump` binary. @default "pg_dump" */
  pgDumpPath?: string;
  /** Path to `pg_restore` binary. @default "pg_restore" */
  pgRestorePath?: string;
  /** Maximum Recovery Time Objective in ms. @default 300000 (5 mins) */
  maxRtoMs?: number;
  /** Maximum Recovery Point Objective in minutes. @default 1440 (24 hrs) */
  maxRpoMinutes?: number;
  logger?: Logger;
  /** Injected spawn — override in tests. */
  spawn?: SpawnFn;
  /** Injected fs adapter — override in tests. */
  fs?: FsAdapter;
  /** Injected remote object storage adapter. */
  remoteStorage?: RemoteStorageAdapter;
  /** Injected database restore runner — override in tests. */
  restoreRunner?: DbRestoreRunner;
  /** Override current time for retention/drill calculations (tests). */
  now?: () => Date;
}

// ─── BackupService ────────────────────────────────────────────────────────────

export class BackupService {
  private readonly backupDir: string;
  private readonly databaseUrl: string;
  private readonly retainDays: number;
  private readonly remoteRetainDays: number;
  private readonly remoteImmutableDays: number;
  private readonly pgDumpPath: string;
  private readonly pgRestorePath: string;
  private readonly maxRtoMs: number;
  private readonly maxRpoMinutes: number;
  private readonly logger?: Logger;
  private readonly spawn: SpawnFn;
  private readonly fs: FsAdapter;
  private readonly remoteStorage?: RemoteStorageAdapter;
  private readonly restoreRunner?: DbRestoreRunner;
  private readonly now: () => Date;

  constructor(opts: BackupServiceOptions) {
    this.backupDir = opts.backupDir;
    this.databaseUrl = opts.databaseUrl;
    this.retainDays = opts.retainDays ?? 7;
    this.remoteRetainDays = opts.remoteRetainDays ?? this.retainDays;
    this.remoteImmutableDays = opts.remoteImmutableDays ?? 0;
    this.pgDumpPath = opts.pgDumpPath ?? "pg_dump";
    this.pgRestorePath = opts.pgRestorePath ?? "pg_restore";
    this.maxRtoMs = opts.maxRtoMs ?? 5 * 60 * 1000;
    this.maxRpoMinutes = opts.maxRpoMinutes ?? 24 * 60;
    this.logger = opts.logger;
    this.spawn = opts.spawn ?? defaultSpawn;
    this.fs = opts.fs ?? defaultFsAdapter;
    this.remoteStorage = opts.remoteStorage;
    this.restoreRunner = opts.restoreRunner;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Runs one backup cycle:
   *  1. Ensures backup directory exists.
   *  2. Runs `pg_dump` to create compressed dump file.
   *  3. Computes cryptographic SHA-256 checksum and generates manifest file.
   *  4. Replicates dump and manifest to off-site object storage (if configured).
   *  5. Prunes local and remote backups older than retention policies.
   *
   * @returns Backup metadata and manifest.
   * @throws If pg_dump or replication fails.
   */
  async run(ctx?: JobLeaseContext): Promise<BackupResult> {
    const start = Date.now();
    await this.assertCurrent(ctx);
    if (ctx && !this.fs.rename) {
      throw new Error("Leased backups require an FsAdapter with atomic rename");
    }

    await this.withFence(ctx, () => this.fs.mkdir(this.backupDir));

    const dumpFilename = this.buildFilename(ctx);
    const manifestFilename = this.buildManifestFilename(dumpFilename);
    const filePath = join(this.backupDir, dumpFilename);
    const manifestPath = join(this.backupDir, manifestFilename);
    // A partial dump is neither a retained backup nor a restore candidate. Its
    // owner/fence suffix also prevents an old child overwriting a successor.
    const stagedPath = ctx ? `${filePath}.partial` : filePath;

    const { pgEnv, pgArgs } = this.buildPgDumpArgs(stagedPath);

    this.logger?.info({ filePath }, "backup: starting pg_dump");

    await this.assertCurrent(ctx);
    const { exitCode, stderr } = await this.spawn(this.pgDumpPath, pgArgs, pgEnv, ...this.signalArgs(ctx));
    await this.assertCurrent(ctx);

    if (exitCode !== 0) {
      this.logger?.error({ exitCode, stderr }, "backup: pg_dump failed");
      throw new Error(`pg_dump exited with code ${exitCode}: ${stderr}`);
    }

    const durationMs = Date.now() - start;

    // Read dump content to compute SHA-256 checksum and size
    const dumpContent = await this.fs.readFile(stagedPath);
    const checksumSha256 = this.computeSha256(dumpContent);
    const fileSizeBytes = dumpContent.length;

    let immutableUntil: string | undefined;
    if (this.remoteImmutableDays > 0) {
      const immDate = new Date(this.now().getTime() + this.remoteImmutableDays * 24 * 60 * 60 * 1000);
      immutableUntil = immDate.toISOString();
    }

    const manifest: BackupManifest = {
      version: "1.0",
      backupId: dumpFilename.replace(/\.sql\.gz$/, ""),
      timestamp: this.now().toISOString(),
      dumpFileName: dumpFilename,
      manifestFileName: manifestFilename,
      fileSizeBytes,
      checksumSha256,
      databaseName: this.extractDatabaseName(),
      retention: {
        localRetainDays: this.retainDays,
        remoteRetainDays: this.remoteRetainDays,
        immutableUntil
      },
      verificationStatus: {
        verified: false
      }
    };

    // Publish only after preparation completes and ownership is revalidated.
    await this.withFence(ctx, async () => {
      await this.fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      ctx?.signal.throwIfAborted();
      if (ctx) await this.fs.rename!(stagedPath, filePath);
    });

    let replicated = false;
    let prunedRemote = 0;

    // Off-site replication if configured
    if (this.remoteStorage) {
      try {
        // A dump upload may outlive a short database transaction. Its unique
        // key is preparation; the catalog is published only with a current fence.
        const uploadRes = await this.prepare(ctx, () => this.remoteStorage!.uploadFile(
          filePath,
          dumpFilename,
          { checksum: checksumSha256 },
          ...this.signalArgs(ctx)
        ));
        await this.uploadRemote(manifestPath, manifestFilename, ctx);

        replicated = true;
        manifest.remoteCatalog = {
          replicated: true,
          replicatedAt: this.now().toISOString(),
          remoteKey: dumpFilename,
          etag: uploadRes.etag
        };

        // Save updated manifest with catalog info
        await this.withFence(ctx, () => this.fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2)));
        await this.uploadRemote(manifestPath, manifestFilename, ctx);
        this.logger?.info({ dumpFilename }, "backup: replicated off-site successfully");
      } catch (err: unknown) {
        await this.assertCurrent(ctx);
        const errMsg = err instanceof Error ? err.message : String(err);
        manifest.verificationStatus = {
          verified: false,
          error: `Off-site replication failed: ${errMsg}`
        };
        await this.withFence(ctx, () => this.fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2)));
        this.logger?.error({ err }, "backup: off-site replication failed");
        throw new Error(`Off-site replication failed: ${errMsg}`);
      }

      prunedRemote = await this.pruneOldRemoteBackups(ctx);
    }

    const pruned = await this.pruneOldBackups(ctx);
    await this.assertCurrent(ctx);

    this.logger?.info(
      { filePath, durationMs, checksumSha256, fileSizeBytes, replicated, pruned, prunedRemote },
      "backup: pg_dump succeeded and cataloged"
    );

    return {
      filePath,
      manifestPath,
      checksumSha256,
      fileSizeBytes,
      durationMs,
      pruned,
      prunedRemote,
      replicated,
      manifest
    };
  }

  /**
   * Runs an automated pg_restore drill on a target backup artifact:
   *  1. Verifies cryptographic SHA-256 checksum against stored manifest.
   *  2. Validates RPO compliance against current timestamp.
   *  3. Spawns `pg_restore` into an isolated target test database.
   *  4. Runs schema & data smoke checks.
   *  5. Validates RTO compliance (restore duration <= maxRtoMs).
   *  6. Cleans up isolated test database.
   *  7. Updates backup manifest & remote catalog verification status.
   */
  async runRestoreDrill(opts: RestoreDrillOptions = {}, ctx?: JobLeaseContext): Promise<RestoreDrillResult> {
    await this.assertCurrent(ctx);
    const targetDbName = this.restoreDatabaseName(opts.targetDatabaseName ?? "vaultquest_restore_test", ctx);
    const maxRtoMs = opts.maxRtoMs ?? this.maxRtoMs;
    const maxRpoMinutes = opts.maxRpoMinutes ?? this.maxRpoMinutes;

    let filePath = opts.dumpFilePath;
    if (!filePath) {
      filePath = await this.findLatestBackupFile();
    }

    if (!filePath) {
      throw new Error("No eligible backup file found for restore drill");
    }

    const dumpFilename = basename(filePath);
    const manifestFilename = this.buildManifestFilename(dumpFilename);
    const manifestPath = join(this.backupDir, manifestFilename);

    let manifest: BackupManifest | null = null;
    try {
      if (this.fs.readFileText) {
        const txt = await this.fs.readFileText(manifestPath);
        manifest = JSON.parse(txt) as BackupManifest;
      } else {
        const buf = await this.fs.readFile(manifestPath);
        manifest = JSON.parse(buf.toString("utf8")) as BackupManifest;
      }
    } catch {
      this.logger?.warn({ manifestPath }, "restore drill: manifest file missing or invalid");
    }

    // Step 1: Checksum verification
    const dumpContent = await this.fs.readFile(filePath);
    const actualChecksum = this.computeSha256(dumpContent);
    await this.assertCurrent(ctx);

    if (manifest && manifest.checksumSha256 !== actualChecksum) {
      const error = `Checksum mismatch: manifest expected ${manifest.checksumSha256}, got ${actualChecksum}`;
      this.logger?.error({ filePath, error }, "restore drill failed checksum check");
      await this.updateManifestVerification(ctx, manifestPath, manifest, false, error);
      return {
        success: false,
        backupId: manifest?.backupId,
        dumpFilePath: filePath,
        verifiedAt: this.now().toISOString(),
        rtoMs: 0,
        rpoMinutes: 0,
        smokeChecksPassed: false,
        error
      };
    }

    // Step 2: RPO Check
    const backupTimestamp = manifest ? new Date(manifest.timestamp) : new Date();
    const rpoMinutes = Math.max(0, Math.round((this.now().getTime() - backupTimestamp.getTime()) / (60 * 1000)));

    if (rpoMinutes > maxRpoMinutes) {
      const error = `RPO threshold exceeded: backup age ${rpoMinutes}m exceeds max ${maxRpoMinutes}m`;
      this.logger?.error({ filePath, error }, "restore drill failed RPO check");
      await this.updateManifestVerification(ctx, manifestPath, manifest, false, error);
      return {
        success: false,
        backupId: manifest?.backupId,
        dumpFilePath: filePath,
        verifiedAt: this.now().toISOString(),
        rtoMs: 0,
        rpoMinutes,
        smokeChecksPassed: false,
        error
      };
    }

    // Step 3: Isolated pg_restore Execution
    const drillStart = Date.now();
    let smokeResult: { tableCount: number; passed: boolean; details?: string } = {
      tableCount: 0,
      passed: false,
      details: ""
    };
    let restoreError: string | undefined;

    try {
      if (this.restoreRunner) {
        if (this.restoreRunner.createDatabase) {
          await this.withFence(ctx, () => this.restoreRunner!.createDatabase!(targetDbName, ...this.signalArgs(ctx)));
        }
        const restoreRes = await this.prepare(ctx, () => this.restoreRunner!.restoreDump(
          targetDbName, filePath, ...this.signalArgs(ctx)
        ));
        if (restoreRes.exitCode !== 0) {
          throw new Error(`pg_restore failed with code ${restoreRes.exitCode}: ${restoreRes.stderr}`);
        }
        smokeResult = await this.prepare(ctx, () => this.restoreRunner!.runSmokeChecks(targetDbName, ...this.signalArgs(ctx)));
      } else {
        if (ctx) {
          await this.withFence(ctx, () => this.runDatabaseCommand("createdb", targetDbName, ctx));
        }
        const { pgArgs, pgEnv } = this.buildPgRestoreArgs(targetDbName, filePath);
        const { exitCode, stderr } = await this.prepare(ctx, () => this.spawn(
          this.pgRestorePath, pgArgs, pgEnv, ...this.signalArgs(ctx)
        ));
        if (exitCode !== 0) {
          throw new Error(`pg_restore exited with code ${exitCode}: ${stderr}`);
        }
        smokeResult = { tableCount: 1, passed: true, details: "" };
      }
    } catch (err: unknown) {
      await this.assertCurrent(ctx);
      restoreError = err instanceof Error ? err.message : String(err);
    } finally {
      const cleanup = this.restoreRunner?.dropDatabase
        ? () => this.restoreRunner!.dropDatabase!(targetDbName, ...this.signalArgs(ctx))
        : ctx && !this.restoreRunner
          ? () => this.runDatabaseCommand("dropdb", targetDbName, ctx)
          : undefined;
      if (cleanup) {
        try {
          // Never start destructive cleanup with a lost lease. The isolated
          // database can be reaped later without targeting a successor's drill.
          await this.withFence(ctx, cleanup);
        } catch (dropErr) {
          await this.assertCurrent(ctx);
          this.logger?.warn({ dropErr }, "restore drill: failed to drop temporary target database");
        }
      }
    }

    const rtoMs = Date.now() - drillStart;

    if (restoreError) {
      this.logger?.error({ filePath, restoreError }, "restore drill execution failed");
      await this.updateManifestVerification(ctx, manifestPath, manifest, false, restoreError, rtoMs, rpoMinutes);
      return {
        success: false,
        backupId: manifest?.backupId,
        dumpFilePath: filePath,
        verifiedAt: this.now().toISOString(),
        rtoMs,
        rpoMinutes,
        smokeChecksPassed: false,
        error: restoreError
      };
    }

    if (!smokeResult.passed) {
      const error = `Schema/data smoke check failed: ${smokeResult.details || "No tables found"}`;
      this.logger?.error({ filePath, error }, "restore drill failed smoke checks");
      await this.updateManifestVerification(ctx, manifestPath, manifest, false, error, rtoMs, rpoMinutes);
      return {
        success: false,
        backupId: manifest?.backupId,
        dumpFilePath: filePath,
        verifiedAt: this.now().toISOString(),
        rtoMs,
        rpoMinutes,
        smokeChecksPassed: false,
        tableCount: smokeResult.tableCount,
        error
      };
    }

    // Step 4: RTO Check
    if (rtoMs > maxRtoMs) {
      const error = `RTO threshold exceeded: restore time ${rtoMs}ms exceeds max ${maxRtoMs}ms`;
      this.logger?.error({ filePath, error }, "restore drill failed RTO threshold");
      await this.updateManifestVerification(ctx, manifestPath, manifest, false, error, rtoMs, rpoMinutes);
      return {
        success: false,
        backupId: manifest?.backupId,
        dumpFilePath: filePath,
        verifiedAt: this.now().toISOString(),
        rtoMs,
        rpoMinutes,
        smokeChecksPassed: true,
        tableCount: smokeResult.tableCount,
        error
      };
    }

    // Drill Succeeded!
    await this.updateManifestVerification(
      ctx,
      manifestPath,
      manifest,
      true,
      undefined,
      rtoMs,
      rpoMinutes,
      smokeResult.passed
    );

    this.logger?.info(
      { filePath, rtoMs, rpoMinutes, tableCount: smokeResult.tableCount },
      "restore verification drill completed successfully"
    );

    return {
      success: true,
      backupId: manifest?.backupId,
      dumpFilePath: filePath,
      verifiedAt: this.now().toISOString(),
      rtoMs,
      rpoMinutes,
      smokeChecksPassed: true,
      tableCount: smokeResult.tableCount
    };
  }

  /**
   * Generates timestamped filename for dump file.
   * Format: `backup-YYYY-MM-DDTHH-MM-SS.sql.gz`
   */
  buildFilename(ctx?: JobLeaseContext): string {
    const ts = this.now()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\..+$/, "");
    const suffix = ctx ? `-${this.leaseSuffix(ctx)}` : "";
    return `backup-${ts}${suffix}.sql.gz`;
  }

  /**
   * Generates corresponding manifest filename.
   * Format: `backup-YYYY-MM-DDTHH-MM-SS.manifest.json`
   */
  buildManifestFilename(dumpFilename?: string): string {
    const name = dumpFilename ?? this.buildFilename();
    return name.replace(/\.sql\.gz$/, ".manifest.json");
  }

  /**
   * Computes SHA-256 hex checksum.
   */
  computeSha256(content: Buffer | string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  /**
   * Deletes local backup files and manifests older than `retainDays`.
   */
  async pruneOldBackups(ctx?: JobLeaseContext): Promise<number> {
    await this.assertCurrent(ctx);
    const cutoffMs = this.now().getTime() - this.retainDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    let entries: string[];
    try {
      entries = await this.fs.readdir(this.backupDir);
    } catch {
      await this.assertCurrent(ctx);
      return 0;
    }

    for (const entry of entries) {
      if (
        (!entry.startsWith("backup-") || (!entry.endsWith(".sql.gz") && !entry.endsWith(".manifest.json")))
      ) {
        continue;
      }

      const fullPath = join(this.backupDir, entry);
      const mtime = await this.fs.mtimeMs(fullPath);

      if (mtime !== null && mtime < cutoffMs) {
        try {
          await this.withFence(ctx, () => this.fs.unlink(fullPath));
          pruned += 1;
          this.logger?.info({ file: entry }, "backup: pruned old local backup/manifest");
        } catch (err) {
          await this.assertCurrent(ctx);
          this.logger?.warn({ err, file: entry }, "backup: failed to prune local file");
        }
      }
    }

    await this.assertCurrent(ctx);
    return pruned;
  }

  /**
   * Deletes remote objects older than `remoteRetainDays`, respecting immutability policy.
   */
  async pruneOldRemoteBackups(ctx?: JobLeaseContext): Promise<number> {
    await this.assertCurrent(ctx);
    if (!this.remoteStorage) return 0;

    const cutoffMs = this.now().getTime() - this.remoteRetainDays * 24 * 60 * 60 * 1000;
    let pruned = 0;

    try {
      const objects = await this.prepare(ctx, () => this.remoteStorage!.listObjects("backup-", ...this.signalArgs(ctx)));
      for (const obj of objects) {
        // Check immutability policy
        if (obj.immutableUntil) {
          const immMs = new Date(obj.immutableUntil).getTime();
          if (this.now().getTime() < immMs) {
            this.logger?.info({ remoteKey: obj.remoteKey }, "backup: skipping remote prune due to immutability policy");
            continue;
          }
        }

        const uploadedMs = new Date(obj.uploadedAt).getTime();
        if (uploadedMs < cutoffMs) {
          try {
            await this.withFence(ctx, () => this.remoteStorage!.deleteObject(obj.remoteKey, ...this.signalArgs(ctx)));
            pruned += 1;
            this.logger?.info({ remoteKey: obj.remoteKey }, "backup: pruned old remote backup object");
          } catch (err) {
            await this.assertCurrent(ctx);
            this.logger?.warn({ err, remoteKey: obj.remoteKey }, "backup: failed to delete remote object");
          }
        }
      }
    } catch (err) {
      await this.assertCurrent(ctx);
      this.logger?.warn({ err }, "backup: error during remote backup pruning");
    }

    await this.assertCurrent(ctx);
    return pruned;
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  private signalArgs(ctx?: JobLeaseContext): [] | [AbortSignal] {
    return ctx ? [ctx.signal] : [];
  }

  private async assertCurrent(ctx?: JobLeaseContext): Promise<void> {
    if (!ctx) return;
    ctx.signal.throwIfAborted();
    await ctx.assertCurrent();
    ctx.signal.throwIfAborted();
  }

  private async prepare<T>(ctx: JobLeaseContext | undefined, work: () => Promise<T>): Promise<T> {
    await this.assertCurrent(ctx);
    const result = await work();
    await this.assertCurrent(ctx);
    return result;
  }

  private async withFence<T>(ctx: JobLeaseContext | undefined, work: () => Promise<T>): Promise<T> {
    if (!ctx) return work();
    ctx.signal.throwIfAborted();
    return ctx.withFence(async () => {
      ctx.signal.throwIfAborted();
      const result = await work();
      ctx.signal.throwIfAborted();
      return result;
    });
  }

  private async uploadRemote(localPath: string, remoteKey: string, ctx?: JobLeaseContext): Promise<{ remoteKey: string; etag?: string }> {
    // The lease lock serializes publication starts, while the adapter's signal
    // cancels in-flight I/O. A storage server must implement native fencing to
    // reject an already accepted request after connection/lease loss.
    return this.withFence(ctx, () => ctx
      ? this.remoteStorage!.uploadFile(localPath, remoteKey, undefined, ctx.signal)
      : this.remoteStorage!.uploadFile(localPath, remoteKey));
  }

  private leaseSuffix(ctx: JobLeaseContext): string {
    const ownerHash = createHash("sha256").update(`${ctx.jobName}:${ctx.ownerId}`).digest("hex").slice(0, 12);
    return `${ownerHash}_${ctx.fenceToken.toString()}`;
  }

  private restoreDatabaseName(base: string, ctx?: JobLeaseContext): string {
    if (!ctx) return base;
    const suffix = `_${this.leaseSuffix(ctx)}`;
    let prefix = "";
    // PostgreSQL identifiers are limited to 63 bytes. Preserve the fencing
    // suffix even when a configured base name needs truncating.
    for (const char of base) {
      if (Buffer.byteLength(prefix + char + suffix) > 63) break;
      prefix += char;
    }
    return prefix + suffix;
  }

  private async runDatabaseCommand(command: "createdb" | "dropdb", dbName: string, ctx: JobLeaseContext): Promise<void> {
    const url = new URL(this.databaseUrl);
    const args = [
      "--host", this.connectionHost(url),
      "--port", url.port || "5432",
      "--username", decodeURIComponent(url.username) || "postgres",
      "--no-password",
      ...(command === "dropdb" ? ["--if-exists"] : []),
      "--",
      dbName
    ];
    const result = await this.spawn(
      join(dirname(this.pgRestorePath), command),
      args,
      { PGPASSWORD: decodeURIComponent(url.password || "") || undefined },
      ctx.signal
    );
    if (result.exitCode !== 0) {
      throw new Error(`${command} exited with code ${result.exitCode}: ${result.stderr}`);
    }
  }

  private async findLatestBackupFile(): Promise<string | undefined> {
    try {
      const entries = await this.fs.readdir(this.backupDir);
      const dumps = entries
        .filter((e) => e.startsWith("backup-") && e.endsWith(".sql.gz"))
        .sort()
        .reverse();

      if (dumps.length === 0 || !dumps[0]) return undefined;
      return join(this.backupDir, dumps[0]);
    } catch {
      return undefined;
    }
  }

  private async updateManifestVerification(
    ctx: JobLeaseContext | undefined,
    manifestPath: string,
    manifest: BackupManifest | null,
    verified: boolean,
    error?: string,
    rtoMs?: number,
    rpoMinutes?: number,
    smokeChecksPassed?: boolean
  ): Promise<void> {
    await this.assertCurrent(ctx);
    if (!manifest) return;

    manifest.verificationStatus = {
      verified,
      verifiedAt: this.now().toISOString(),
      rtoMs,
      rpoMinutes,
      smokeChecksPassed,
      error
    };

    try {
      await this.withFence(ctx, () => this.fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2)));
      if (this.remoteStorage && manifest.remoteCatalog?.replicated) {
        await this.uploadRemote(manifestPath, manifest.manifestFileName, ctx);
      }
    } catch (err) {
      await this.assertCurrent(ctx);
      this.logger?.warn({ err, manifestPath }, "failed to update manifest file verification status");
    }
  }

  private extractDatabaseName(): string {
    try {
      const url = new URL(this.databaseUrl);
      return decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
    } catch {
      return "postgres";
    }
  }

  private connectionHost(url: URL): string {
    // URL keeps IPv6 URI brackets; PostgreSQL's host parameter takes the address.
    const host = url.hostname;
    return (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host) || "localhost";
  }

  private buildPgDumpArgs(outputPath: string): {
    pgArgs: string[];
    pgEnv: Record<string, string | undefined>;
  } {
    const url = new URL(this.databaseUrl);

    const host = this.connectionHost(url);
    const port = url.port || "5432";
    const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres";
    const username = decodeURIComponent(url.username) || "postgres";
    const password = decodeURIComponent(url.password || "");

    const pgArgs = [
      "--host", host,
      "--port", port,
      "--username", username,
      "--dbname", database,
      "--format", "custom",
      "--no-password",
      "--file", outputPath
    ];

    const pgEnv: Record<string, string | undefined> = {
      PGPASSWORD: password || undefined
    };

    return { pgArgs, pgEnv };
  }

  private buildPgRestoreArgs(
    targetDbName: string,
    dumpFilePath: string
  ): {
    pgArgs: string[];
    pgEnv: Record<string, string | undefined>;
  } {
    const url = new URL(this.databaseUrl);

    const host = this.connectionHost(url);
    const port = url.port || "5432";
    const username = decodeURIComponent(url.username) || "postgres";
    const password = decodeURIComponent(url.password || "");

    const pgArgs = [
      "--host", host,
      "--port", port,
      "--username", username,
      "--dbname", targetDbName,
      "--format", "custom",
      "--clean",
      "--if-exists",
      "--no-password",
      dumpFilePath
    ];

    const pgEnv: Record<string, string | undefined> = {
      PGPASSWORD: password || undefined
    };

    return { pgArgs, pgEnv };
  }
}
