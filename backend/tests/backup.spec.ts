/**
 * Unit and integration tests for BackupService (issues #275 & #112).
 *
 * Checks cryptographic checksums, manifest generation, off-site storage replication,
 * immutability/retention policies, corruption detection, and automated restore drills.
 *
 * All external I/O (pg_dump/pg_restore spawn, filesystem operations, remote storage,
 * and database restore runners) is injected so no real database or cloud infrastructure is needed.
 */

import { watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  BackupService,
  defaultSpawn,
  type SpawnFn,
  type FsAdapter,
  type RemoteStorageAdapter,
  type RemoteObjectMetadata,
  type DbRestoreRunner
} from "../src/services/backupService.js";
import { InMemoryJobLeaseStore, JobLeaseService } from "../src/services/jobLeaseService.js";

// ─── Test helpers & mocks ─────────────────────────────────────────────────────

function makeSpawn(exitCode = 0, stderr = ""): SpawnFn {
  return vi.fn().mockResolvedValue({ exitCode, stderr });
}

function makeFs(overrides: Partial<FsAdapter> = {}): FsAdapter {
  const store = new Map<string, string | Buffer>();
  const mtimes = new Map<string, number>();

  return {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockImplementation(async (path: string, content: string | Buffer) => {
      store.set(path, content);
      if (!mtimes.has(path)) {
        mtimes.set(path, Date.now());
      }
    }),
    readFile: vi.fn().mockImplementation(async (path: string) => {
      const val = store.get(path);
      if (val === undefined) return Buffer.from("mock dump content");
      return Buffer.isBuffer(val) ? val : Buffer.from(val, "utf8");
    }),
    readFileText: vi.fn().mockImplementation(async (path: string) => {
      const val = store.get(path);
      if (val === undefined) return "";
      return typeof val === "string" ? val : val.toString("utf8");
    }),
    readdir: vi.fn().mockImplementation(async () => Array.from(store.keys())),
    mtimeMs: vi.fn().mockImplementation(async (path: string) => mtimes.get(path) ?? null),
    unlink: vi.fn().mockImplementation(async (path: string) => {
      store.delete(path);
      mtimes.delete(path);
    }),
    rename: vi.fn().mockImplementation(async (from: string, to: string) => {
      store.set(to, store.get(from) ?? Buffer.from("mock dump content"));
      store.delete(from);
      mtimes.set(to, mtimes.get(from) ?? Date.now());
      mtimes.delete(from);
    }),
    exists: vi.fn().mockImplementation(async (path: string) => store.has(path)),
    ...overrides
  };
}

function makeRemoteStorage(overrides: Partial<RemoteStorageAdapter> = {}): RemoteStorageAdapter {
  const objects = new Map<string, RemoteObjectMetadata>();

  return {
    uploadFile: vi.fn().mockImplementation(async (_localPath: string, remoteKey: string) => {
      objects.set(remoteKey, {
        remoteKey,
        fileSizeBytes: 1024,
        uploadedAt: new Date().toISOString()
      });
      return { remoteKey, etag: `etag-${remoteKey}` };
    }),
    downloadFile: vi.fn().mockResolvedValue(undefined),
    listObjects: vi.fn().mockImplementation(async () => Array.from(objects.values())),
    deleteObject: vi.fn().mockImplementation(async (remoteKey: string) => {
      objects.delete(remoteKey);
    }),
    ...overrides
  };
}

function makeRestoreRunner(overrides: Partial<DbRestoreRunner> = {}): DbRestoreRunner {
  return {
    createDatabase: vi.fn().mockResolvedValue(undefined),
    dropDatabase: vi.fn().mockResolvedValue(undefined),
    restoreDump: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "" }),
    runSmokeChecks: vi.fn().mockResolvedValue({ tableCount: 10, passed: true }),
    ...overrides
  };
}

const DATABASE_URL = "postgres://user:secret@db.example.com:5432/vaultquest";
const BACKUP_DIR = "/backups";
const FIXED_NOW = new Date("2026-06-28T02:00:00.000Z");

function makeLeaseHarness(jobName: string) {
  const store = new InMemoryJobLeaseStore();
  let nowMs = FIXED_NOW.getTime();
  const service = (ownerId: string) => new JobLeaseService({
    store,
    ownerId,
    logger: pino({ level: "silent" }),
    ttlMs: 1_000,
    heartbeatMs: 60_000,
    now: () => new Date(nowMs)
  });
  return {
    service,
    async replaceOwner() {
      nowMs += 1_001;
      const acquired = await store.tryAcquire(jobName, "replacement", 1_000, new Date(nowMs));
      expect(acquired.acquired).toBe(true);
    }
  };
}

// ─── Core Backup & Manifest Generation ───────────────────────────────────────

describe("BackupService core execution & manifest generation", () => {
  it.each([
    {
      databaseUrl: "postgres://ops%40tenant:p%40ss@db.example.com:5433/vault%20quest",
      host: "db.example.com", username: "ops@tenant", database: "vault quest", password: "p@ss"
    },
    {
      databaseUrl: "postgres://ops%2540tenant:p%2540ss@db.example.com:5433/vault%2520quest",
      host: "db.example.com", username: "ops%40tenant", database: "vault%20quest", password: "p%40ss"
    },
    {
      databaseUrl: "postgres://user:secret@[::1]:5433/vaultquest",
      host: "::1", username: "user", database: "vaultquest", password: "secret"
    },
    {
      databaseUrl: "postgres://user:secret@[2001:db8::1234]:5433/vaultquest",
      host: "2001:db8::1234", username: "user", database: "vaultquest", password: "secret"
    }
  ])("builds PostgreSQL connection arguments for $host and $database", async ({ databaseUrl, host, username, database, password }) => {
    const spawn = vi.fn<SpawnFn>().mockResolvedValue({ exitCode: 0, stderr: "" });
    const svc = new BackupService({
      backupDir: BACKUP_DIR, databaseUrl, spawn, fs: makeFs(),
      pgRestorePath: "/opt/postgres/pg_restore", now: () => FIXED_NOW
    });
    const backup = await svc.run();
    expect(backup.manifest.databaseName).toBe(database);
    expect(spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["--dbname", database]));

    const lease = makeLeaseHarness("restore-drill");
    const result = await lease.service("url-components").runWithLease("restore-drill", (ctx) =>
      svc.runRestoreDrill({ dumpFilePath: backup.filePath }, ctx));
    expect(result.status).toBe("ran");
    expect(spawn.mock.calls.map(([command]) => command)).toEqual([
      "pg_dump", "/opt/postgres/createdb", "/opt/postgres/pg_restore", "/opt/postgres/dropdb"
    ]);
    for (const [, args, env] of spawn.mock.calls) {
      expect(args).toEqual(expect.arrayContaining([
        "--host", host, "--port", "5433", "--username", username
      ]));
      expect(env.PGPASSWORD).toBe(password);
    }
  });

  it("creates dump, manifest, and SHA-256 checksums", async () => {
    const spawn = makeSpawn(0);
    const fs = makeFs();

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn,
      fs,
      now: () => FIXED_NOW
    });

    const result = await svc.run();

    expect(fs.mkdir).toHaveBeenCalledWith(BACKUP_DIR);
    expect(spawn).toHaveBeenCalledTimes(1);

    expect(result.filePath).toMatch(/backup-2026-06-28T02-00-00\.sql\.gz$/);
    expect(result.manifestPath).toMatch(/backup-2026-06-28T02-00-00\.manifest\.json$/);
    expect(result.checksumSha256).toBeDefined();
    expect(result.checksumSha256.length).toBe(64); // SHA-256 hex string
    expect(result.manifest.version).toBe("1.0");
    expect(result.manifest.databaseName).toBe("vaultquest");
    expect(result.manifest.verificationStatus.verified).toBe(false);
  });

  it("throws when pg_dump fails with non-zero exit code", async () => {
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn: makeSpawn(1, "connection refused"),
      fs: makeFs(),
      now: () => FIXED_NOW
    });

    await expect(svc.run()).rejects.toThrow("pg_dump exited with code 1");
  });
});

// ─── Off-Site Replication & Immutability Retention ───────────────────────────

describe("BackupService off-site replication & immutability retention", () => {
  it("replicates dump and manifest to remote object storage", async () => {
    const remoteStorage = makeRemoteStorage();
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn: makeSpawn(0),
      fs: makeFs(),
      remoteStorage,
      now: () => FIXED_NOW
    });

    const result = await svc.run();

    expect(result.replicated).toBe(true);
    expect(remoteStorage.uploadFile).toHaveBeenCalledTimes(3); // dump, initial manifest, updated manifest
    expect(result.manifest.remoteCatalog?.replicated).toBe(true);
    expect(result.manifest.remoteCatalog?.remoteKey).toBe("backup-2026-06-28T02-00-00.sql.gz");
  });

  it("handles interrupted/failed upload and throws without marking healthy", async () => {
    const remoteStorage = makeRemoteStorage({
      uploadFile: vi.fn().mockRejectedValue(new Error("Network connection reset"))
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn: makeSpawn(0),
      fs: makeFs(),
      remoteStorage,
      now: () => FIXED_NOW
    });

    await expect(svc.run()).rejects.toThrow("Off-site replication failed: Network connection reset");
  });

  it("prunes old remote backups but preserves immutable objects", async () => {
    const now = FIXED_NOW;
    const oldDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const futureImm = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days in future

    const objects: RemoteObjectMetadata[] = [
      { remoteKey: "backup-expired.sql.gz", fileSizeBytes: 100, uploadedAt: oldDate },
      { remoteKey: "backup-immutable.sql.gz", fileSizeBytes: 100, uploadedAt: oldDate, immutableUntil: futureImm }
    ];

    const remoteStorage = makeRemoteStorage({
      listObjects: vi.fn().mockResolvedValue(objects),
      deleteObject: vi.fn().mockResolvedValue(undefined)
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      remoteRetainDays: 7,
      remoteStorage,
      spawn: makeSpawn(0),
      fs: makeFs(),
      now: () => now
    });

    const prunedCount = await svc.pruneOldRemoteBackups();

    expect(prunedCount).toBe(1);
    expect(remoteStorage.deleteObject).toHaveBeenCalledWith("backup-expired.sql.gz");
    expect(remoteStorage.deleteObject).not.toHaveBeenCalledWith("backup-immutable.sql.gz");
  });
});

// ─── Automated PostgreSQL Restore Verification Drills ────────────────────────

describe("BackupService automated restore drills", () => {
  it("runs successful restore verification drill end-to-end", async () => {
    const fs = makeFs();
    const restoreRunner = makeRestoreRunner();

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn: makeSpawn(0),
      fs,
      restoreRunner,
      now: () => FIXED_NOW
    });

    const backupRes = await svc.run();
    const drillRes = await svc.runRestoreDrill({ dumpFilePath: backupRes.filePath });

    expect(drillRes.success).toBe(true);
    expect(drillRes.smokeChecksPassed).toBe(true);
    expect(drillRes.tableCount).toBe(10);
    expect(restoreRunner.createDatabase).toHaveBeenCalledWith("vaultquest_restore_test");
    expect(restoreRunner.restoreDump).toHaveBeenCalledWith("vaultquest_restore_test", backupRes.filePath);
    expect(restoreRunner.runSmokeChecks).toHaveBeenCalledWith("vaultquest_restore_test");
    expect(restoreRunner.dropDatabase).toHaveBeenCalledWith("vaultquest_restore_test");
  });

  it("detects tampered/corrupted backup dump file and fails restore drill", async () => {
    const fs = makeFs();
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn: makeSpawn(0),
      fs,
      now: () => FIXED_NOW
    });

    const backupRes = await svc.run();

    // Corrupt the dump file on disk after manifest creation
    await fs.writeFile(backupRes.filePath, Buffer.from("corrupted dump payload"));

    const drillRes = await svc.runRestoreDrill({ dumpFilePath: backupRes.filePath });

    expect(drillRes.success).toBe(false);
    expect(drillRes.smokeChecksPassed).toBe(false);
    expect(drillRes.error).toContain("Checksum mismatch");
  });

  it("fails drill when pg_restore exits with non-zero exit code", async () => {
    const fs = makeFs();
    const restoreRunner = makeRestoreRunner({
      restoreDump: vi.fn().mockResolvedValue({ exitCode: 1, stderr: "fatal: invalid dump header" })
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn: makeSpawn(0),
      fs,
      restoreRunner,
      now: () => FIXED_NOW
    });

    const backupRes = await svc.run();
    const drillRes = await svc.runRestoreDrill({ dumpFilePath: backupRes.filePath });

    expect(drillRes.success).toBe(false);
    expect(drillRes.error).toContain("pg_restore failed with code 1: fatal: invalid dump header");
    expect(restoreRunner.dropDatabase).toHaveBeenCalled(); // cleanup executed in finally block
  });

  it("fails drill when schema smoke checks return 0 tables or passed: false", async () => {
    const fs = makeFs();
    const restoreRunner = makeRestoreRunner({
      runSmokeChecks: vi.fn().mockResolvedValue({ tableCount: 0, passed: false, details: "Empty database" })
    });

    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      spawn: makeSpawn(0),
      fs,
      restoreRunner,
      now: () => FIXED_NOW
    });

    const backupRes = await svc.run();
    const drillRes = await svc.runRestoreDrill({ dumpFilePath: backupRes.filePath });

    expect(drillRes.success).toBe(false);
    expect(drillRes.error).toContain("Schema/data smoke check failed: Empty database");
  });

  it("fails drill when RTO exceeds threshold", async () => {
    const fs = makeFs();
    const svc = new BackupService({
      backupDir: BACKUP_DIR,
      databaseUrl: DATABASE_URL,
      maxRtoMs: 1, // unrealistically low RTO threshold (1ms) to trigger failure
      spawn: makeSpawn(0),
      fs,
      restoreRunner: makeRestoreRunner({
        restoreDump: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 10));
          return { exitCode: 0, stderr: "" };
        })
      }),
      now: () => FIXED_NOW
    });

    const backupRes = await svc.run();
    const drillRes = await svc.runRestoreDrill({ dumpFilePath: backupRes.filePath });

    expect(drillRes.success).toBe(false);
    expect(drillRes.error).toContain("RTO threshold exceeded");
  });
});

describe("BackupService lease fencing", () => {
  it("keeps a stale pg_dump in staging without publishing or pruning", async () => {
    const lease = makeLeaseHarness("backup");
    const fs = makeFs();
    const remoteStorage = makeRemoteStorage();
    const spawn = vi.fn<SpawnFn>().mockImplementation(async () => {
      await lease.replaceOwner();
      return { exitCode: 0, stderr: "" };
    });
    const svc = new BackupService({
      backupDir: BACKUP_DIR, databaseUrl: DATABASE_URL, fs, spawn, remoteStorage, now: () => FIXED_NOW
    });

    const result = await lease.service("old-owner").runWithLease("backup", (ctx) => svc.run(ctx));

    expect(result.status).toBe("fence_lost");
    expect(spawn.mock.calls[0]?.[1].at(-1)).toMatch(/\.sql\.gz\.partial$/);
    expect(spawn.mock.calls[0]?.[3]?.aborted).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
    expect(remoteStorage.uploadFile).not.toHaveBeenCalled();
    expect(remoteStorage.deleteObject).not.toHaveBeenCalled();
  });

  it("publishes distinct retained paths for successive lease owners at the same timestamp", async () => {
    const lease = makeLeaseHarness("backup");
    const fs = makeFs();
    const svc = new BackupService({
      backupDir: BACKUP_DIR, databaseUrl: DATABASE_URL, fs, spawn: makeSpawn(), now: () => FIXED_NOW
    });

    const first = await lease.service("replica-a").runWithLease("backup", (ctx) => svc.run(ctx));
    const second = await lease.service("replica-b").runWithLease("backup", (ctx) => svc.run(ctx));

    expect(first.status).toBe("ran");
    expect(second.status).toBe("ran");
    if (first.status !== "ran" || second.status !== "ran") throw new Error("backup did not complete");
    expect(first.value.filePath).not.toBe(second.value.filePath);
    expect(fs.rename).toHaveBeenCalledWith(`${first.value.filePath}.partial`, first.value.filePath);
    expect(fs.rename).toHaveBeenCalledWith(`${second.value.filePath}.partial`, second.value.filePath);
    expect(first.value.filePath).toMatch(/\.sql\.gz$/);
    expect(first.value.manifest.checksumSha256).toBe(first.value.checksumSha256);
  });

  it("does not publish a remote catalog after ownership is lost during a dump upload", async () => {
    const lease = makeLeaseHarness("backup");
    const fs = makeFs();
    const remoteStorage = makeRemoteStorage({
      uploadFile: vi.fn().mockImplementation(async (_path: string, remoteKey: string) => {
        // Simulate an adapter that finishes its accepted request despite losing
        // the lease. No subsequent catalog upload or cleanup may be started.
        await lease.replaceOwner();
        return { remoteKey };
      })
    });
    const svc = new BackupService({
      backupDir: BACKUP_DIR, databaseUrl: DATABASE_URL, fs, spawn: makeSpawn(), remoteStorage, now: () => FIXED_NOW
    });

    const result = await lease.service("old-owner").runWithLease("backup", (ctx) => svc.run(ctx));

    expect(result.status).toBe("fence_lost");
    expect(remoteStorage.uploadFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(remoteStorage.uploadFile).mock.calls[0]?.[3]?.aborted).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(remoteStorage.listObjects).not.toHaveBeenCalled();
    expect(remoteStorage.deleteObject).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("rejects a lost fence before deleting a local retained artifact", async () => {
    const lease = makeLeaseHarness("backup");
    const fs = makeFs({
      readdir: vi.fn().mockResolvedValue(["backup-expired.sql.gz"]),
      mtimeMs: vi.fn().mockImplementation(async () => {
        await lease.replaceOwner();
        return FIXED_NOW.getTime() - 10 * 24 * 60 * 60 * 1000;
      })
    });
    const svc = new BackupService({ backupDir: BACKUP_DIR, databaseUrl: DATABASE_URL, fs, now: () => FIXED_NOW });

    const result = await lease.service("old-owner").runWithLease("backup", (ctx) => svc.pruneOldBackups(ctx));

    expect(result.status).toBe("fence_lost");
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("propagates remote-list cancellation and does not swallow it as a pruning warning", async () => {
    const lease = makeLeaseHarness("backup");
    const remoteStorage = makeRemoteStorage({
      listObjects: vi.fn().mockImplementation(async () => {
        await lease.replaceOwner();
        return [{
          remoteKey: "backup-expired.sql.gz", fileSizeBytes: 1,
          uploadedAt: new Date(FIXED_NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString()
        }];
      })
    });
    const svc = new BackupService({
      backupDir: BACKUP_DIR, databaseUrl: DATABASE_URL, remoteStorage, now: () => FIXED_NOW
    });

    const result = await lease.service("old-owner").runWithLease("backup", (ctx) => svc.pruneOldRemoteBackups(ctx));

    expect(result.status).toBe("fence_lost");
    expect(vi.mocked(remoteStorage.listObjects).mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(remoteStorage.deleteObject).not.toHaveBeenCalled();
  });

  it("stops a stale restore before smoke checks, database cleanup, or manifest updates", async () => {
    const lease = makeLeaseHarness("restore-drill");
    const fs = makeFs();
    const restoreRunner = makeRestoreRunner({
      restoreDump: vi.fn().mockImplementation(async () => {
        await lease.replaceOwner();
        return { exitCode: 0, stderr: "" };
      })
    });
    const svc = new BackupService({
      backupDir: BACKUP_DIR, databaseUrl: DATABASE_URL, fs, spawn: makeSpawn(), restoreRunner, now: () => FIXED_NOW
    });
    const backup = await svc.run();
    vi.mocked(fs.writeFile).mockClear();

    const result = await lease.service("old-owner").runWithLease("restore-drill", (ctx) =>
      svc.runRestoreDrill({ dumpFilePath: backup.filePath }, ctx));

    expect(result.status).toBe("fence_lost");
    const restoreCall = vi.mocked(restoreRunner.restoreDump).mock.calls[0];
    expect(restoreCall?.[0]).toMatch(/^vaultquest_restore_test_[a-f0-9]+_1$/);
    expect(restoreCall?.[2]?.aborted).toBe(true);
    expect(restoreRunner.createDatabase).toHaveBeenCalledWith(restoreCall?.[0], restoreCall?.[2]);
    expect(restoreRunner.runSmokeChecks).not.toHaveBeenCalled();
    expect(restoreRunner.dropDatabase).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("creates and drops a dedicated database for the default leased restore runner", async () => {
    const lease = makeLeaseHarness("restore-drill");
    const fs = makeFs();
    const spawn = vi.fn<SpawnFn>().mockResolvedValue({ exitCode: 0, stderr: "" });
    const svc = new BackupService({
      backupDir: BACKUP_DIR, databaseUrl: DATABASE_URL, fs, spawn,
      pgRestorePath: "/opt/postgres/pg_restore", now: () => FIXED_NOW
    });
    const backup = await svc.run();
    spawn.mockClear();

    const result = await lease.service("replica-a").runWithLease("restore-drill", (ctx) =>
      svc.runRestoreDrill({ dumpFilePath: backup.filePath, targetDatabaseName: "restore_".repeat(12) }, ctx));

    expect(result.status).toBe("ran");
    expect(spawn.mock.calls.map(([command]) => command)).toEqual([
      "/opt/postgres/createdb", "/opt/postgres/pg_restore", "/opt/postgres/dropdb"
    ]);
    const dbName = spawn.mock.calls[0]?.[1].at(-1);
    expect(dbName).toMatch(/_[a-f0-9]+_1$/);
    expect(Buffer.byteLength(dbName!)).toBeLessThanOrEqual(63);
    expect(spawn.mock.calls[1]?.[1]).toContain(dbName);
    expect(spawn.mock.calls[2]?.[1].at(-1)).toBe(dbName);
    for (const call of spawn.mock.calls) expect(call[3]).toBeInstanceOf(AbortSignal);
  });
});

describe("Backup subprocess cancellation", () => {
  it("waits for an in-flight child to exit after cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vaultquest-backup-abort-"));
    const readyFile = join(dir, "ready");
    const abort = new AbortController();
    const reason = new Error("lease lost during subprocess");
    let signalReady!: () => void;
    const ready = new Promise<void>((resolve) => { signalReady = resolve; });
    const watcher = watch(dir, (_event, filename) => {
      if (filename === "ready") signalReady();
    });
    const timeout = setTimeout(() => abort.abort(new Error("child did not become ready")), 4_000);
    const running = defaultSpawn(process.execPath, [
      "-e",
      "const fs = require('node:fs'); const p = process.argv[1]; " +
      "fs.writeFileSync(p + '.tmp', String(process.pid)); fs.renameSync(p + '.tmp', p); " +
      "setInterval(() => {}, 1000);",
      readyFile
    ], {}, abort.signal);
    const outcome = running.catch((error: unknown) => error);
    try {
      await Promise.race([ready, running]);
      const pid = Number(await readFile(readyFile, "utf8"));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      abort.abort(reason);
      expect(await outcome).toBe(reason);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      clearTimeout(timeout);
      abort.abort(reason);
      await outcome;
      watcher.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 5_000);

  it("rejects before spawning when already aborted", async () => {
    const abort = new AbortController();
    const reason = new Error("lease expired before subprocess start");
    abort.abort(reason);
    await expect(defaultSpawn(process.execPath, ["-e", "process.exit(0)"], {}, abort.signal)).rejects.toBe(reason);
  });

  it("rejects spawn errors instead of leaving the backup pending", async () => {
    await expect(defaultSpawn("/vaultquest/nonexistent-pg_dump", [], {})).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ─── startBackupCron & startRestoreDrillCron wiring smoke tests ─────────────

describe("Cron wiring", () => {
  it("exports startBackupCron and startRestoreDrillCron from cron.ts", async () => {
    const { startBackupCron, startRestoreDrillCron } = await import("../src/cron.js");
    expect(typeof startBackupCron).toBe("function");
    expect(typeof startRestoreDrillCron).toBe("function");
  });
});
