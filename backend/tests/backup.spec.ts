/**
 * Unit and integration tests for BackupService (issues #275 & #112).
 *
 * Checks cryptographic checksums, manifest generation, off-site storage replication,
 * immutability/retention policies, corruption detection, and automated restore drills.
 *
 * All external I/O (pg_dump/pg_restore spawn, filesystem operations, remote storage,
 * and database restore runners) is injected so no real database or cloud infrastructure is needed.
 */

import { describe, it, expect, vi } from "vitest";
import {
  BackupService,
  type SpawnFn,
  type FsAdapter,
  type RemoteStorageAdapter,
  type RemoteObjectMetadata,
  type DbRestoreRunner
} from "../src/services/backupService.js";

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

// ─── Core Backup & Manifest Generation ───────────────────────────────────────

describe("BackupService core execution & manifest generation", () => {
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

// ─── startBackupCron & startRestoreDrillCron wiring smoke tests ─────────────

describe("Cron wiring", () => {
  it("exports startBackupCron and startRestoreDrillCron from cron.ts", async () => {
    const { startBackupCron, startRestoreDrillCron } = await import("../src/cron.js");
    expect(typeof startBackupCron).toBe("function");
    expect(typeof startRestoreDrillCron).toBe("function");
  });
});
