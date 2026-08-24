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
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vaultquest_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  const databaseUrl = container.getConnectionUri();

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
      await container.stop();
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
  await safeDelete(() => prisma.pendingEvent.deleteMany({}));
  await safeDelete(() => prisma.savedPool.deleteMany({}));
  await safeDelete(() => prisma.userQuest.deleteMany({}));
  await safeDelete(() => prisma.actionLedger.deleteMany({}));
  await safeDelete(() => prisma.indexerCheckpoint.deleteMany({}));
  await safeDelete(() => prisma.userNotificationPref.deleteMany({}));
  await safeDelete(() => prisma.userSupportEvidence.deleteMany({}));
  await safeDelete(() => prisma.userActivityLog.deleteMany({}));
  await safeDelete(() => prisma.legalHold.deleteMany({}));
  await safeDelete(() => prisma.deletionManifest.deleteMany({}));
  await safeDelete(() => prisma.backupExpiryManifest.deleteMany({}));
  await safeDelete(() => prisma.privacyAuditLog.deleteMany({}));
}
