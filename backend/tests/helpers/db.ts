import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TestDb = {
  prisma: PrismaClient;
  databaseUrl: string;
  stop: () => Promise<void>;
};

export async function startTestDb(): Promise<TestDb> {
  const backendDir = fileURLToPath(new URL("../../", import.meta.url));
  const prismaCliPath = resolve(backendDir, "node_modules/prisma/build/index.js");
  // A caller may supply an isolated, disposable PostgreSQL test database when
  // Docker is unavailable. Never point this at application/production data.
  let databaseUrl = process.env.VAULTQUEST_TEST_DATABASE_URL;
  let container: StartedPostgreSqlContainer | undefined;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("vaultquest_test")
      .withUsername("test")
      .withPassword("test")
      .start();
    databaseUrl = container.getConnectionUri();
  }

  execFileSync(process.execPath, [prismaCliPath, "db", "push", "--accept-data-loss"], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit"
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  return {
    prisma,
    databaseUrl,
    stop: async () => {
      await prisma.$disconnect();
      await container?.stop();
    }
  };
}

async function safeDelete(deleteFn: () => Promise<any>) {
  try {
    await deleteFn();
  } catch (err: any) {
    if (
      err.message &&
      (err.message.includes("does not exist") ||
        err.message.includes("P2021") ||
        err.code === "P2021")
    ) {
      return;
    }
    throw err;
  }
}

export async function resetDb(prisma: PrismaClient): Promise<void> {
  await safeDelete(() => prisma.jobLease.deleteMany({}));
  await safeDelete(() => prisma.actionLedger.deleteMany({}));
  await safeDelete(() => prisma.pendingEvent.deleteMany({}));
  await safeDelete(() => prisma.indexerCheckpoint.deleteMany({}));
  await safeDelete(() => prisma.vaultSettlement.deleteMany({}));
  await safeDelete(() => prisma.userQuest.deleteMany({}));
  await safeDelete(() => prisma.savedPool.deleteMany({}));
  await safeDelete(() => prisma.userProfile.deleteMany({}));
  await safeDelete(() => prisma.userNotificationPref.deleteMany({}));
  await safeDelete(() => prisma.userSupportEvidence.deleteMany({}));
  await safeDelete(() => prisma.userActivityLog.deleteMany({}));
  await safeDelete(() => prisma.legalHold.deleteMany({}));
  await safeDelete(() => prisma.deletionManifest.deleteMany({}));
  await safeDelete(() => prisma.backupExpiryManifest.deleteMany({}));
  await safeDelete(() => prisma.privacyAuditLog.deleteMany({}));
}
