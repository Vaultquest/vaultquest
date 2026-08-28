import { z } from "zod";

const placeholderPattern = /PLACEHOLDER|YOUR_|CHANGE-ME|EXAMPLE|<.+?>/i;

const schema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres")),
  INTERNAL_SERVICE_SECRET: z
    .string()
    .min(20)
    .refine((value) => !placeholderPattern.test(value), {
      message: "INTERNAL_SERVICE_SECRET must not be a placeholder value"
    }),
  ORPHAN_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Stellar indexer daemon (#indexer). Optional: when both are set the daemon
  // polls the Soroban RPC for the listed contracts' events.
  SOROBAN_RPC_URL: z.string().url().optional(),
  INDEXER_CONTRACT_IDS: z.string().optional(),
  /**
   * API key for external/third-party service endpoints (issue #273).
   * When set, all `/api/*` routes require `X-Api-Key: <value>`.
   * Leave unset in local development to skip enforcement.
   */
  API_KEY: z
    .string()
    .min(32, "API_KEY must be at least 32 characters")
    .refine((v) => !placeholderPattern.test(v), {
      message: "API_KEY must not be a placeholder value"
    })
    .optional(),
  /**
   * Automated database backup configuration (issue #275).
   * BACKUP_DIR: absolute path where pg_dump files are written.
   *   When unset, the backup cron is not started.
   * BACKUP_RETAIN_DAYS: delete backup files older than this many days (default 7).
   * BACKUP_SCHEDULE: cron expression for the backup job (default: daily at 02:00).
   * BACKUP_REMOTE_RETENTION_DAYS: off-site backup retention window in days.
   * BACKUP_REMOTE_IMMUTABLE_DAYS: off-site retention immutability period in days.
   * BACKUP_RESTORE_DRILL_SCHEDULE: cron expression for restore verification drill (default: weekly at 04:00 on Sunday).
   * BACKUP_MAX_RTO_MS: max allowed Recovery Time Objective in ms (default: 300,000 ms).
   * BACKUP_MAX_RPO_MINUTES: max allowed Recovery Point Objective in minutes (default: 1,440 mins).
   * BACKUP_PG_RESTORE_PATH: path to pg_restore binary (default: "pg_restore").
   */
  BACKUP_DIR: z.string().min(1).optional(),
  BACKUP_RETAIN_DAYS: z.coerce.number().int().positive().default(7),
  BACKUP_SCHEDULE: z.string().default("0 2 * * *"),
  BACKUP_REMOTE_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  BACKUP_REMOTE_IMMUTABLE_DAYS: z.coerce.number().int().nonnegative().default(0),
  BACKUP_RESTORE_DRILL_SCHEDULE: z.string().default("0 4 * * 0"),
  BACKUP_MAX_RTO_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  BACKUP_MAX_RPO_MINUTES: z.coerce.number().int().positive().default(24 * 60),
  BACKUP_PG_RESTORE_PATH: z.string().default("pg_restore"),
  /** Master key used for envelope encryption of PII fields (issue #76). */
  PRIVACY_MASTER_KEY: z.string().min(16).optional(),
  /**
   * Dedicated scrape credential for the raw Prometheus `/metrics` endpoint
   * (issue #102). Kept separate from API_KEY so metrics access can be
   * rotated/scoped independently of general external-service API access.
   * When set, `/metrics` requires `X-Api-Key: <value>`. Leave unset only for
   * local development, or when the endpoint is exclusively reachable over a
   * private scrape network with no public ingress.
   */
  PROMETHEUS_SCRAPE_KEY: z
    .string()
    .min(32, "PROMETHEUS_SCRAPE_KEY must be at least 32 characters")
    .refine((v) => !placeholderPattern.test(v), {
      message: "PROMETHEUS_SCRAPE_KEY must not be a placeholder value"
    })
    .optional(),
  /**
   * Salt for the identifier hashes in request logs (issue #105). Optional: when
   * unset, each process generates a random salt at boot, which redacts just as
   * strongly but makes hashes incomparable across processes and restarts. Set a
   * stable secret to correlate a wallet's requests across replicas.
   */
  LOG_REDACTION_SALT: z.string().min(16).optional(),
  /**
   * How long a signed export challenge stays valid, in milliseconds (issue #10).
   * Wide enough to absorb clock skew between a browser and the server, short
   * enough that a captured signature is not useful for long. Default 5 minutes.
   */
  EXPORT_SIGNATURE_TTL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000)
});

export type Env = z.infer<typeof schema>;

export function parseEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid backend env: ${issues}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? "",
      ORPHAN_TTL_MINUTES: Number(process.env.ORPHAN_TTL_MINUTES ?? 10),
      LOG_LEVEL: (process.env.LOG_LEVEL ?? "info") as Env["LOG_LEVEL"],
      PORT: Number(process.env.PORT ?? 3001),
      NODE_ENV: (process.env.NODE_ENV ?? "development") as Env["NODE_ENV"],
      SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL || undefined,
      INDEXER_CONTRACT_IDS: process.env.INDEXER_CONTRACT_IDS || undefined,
      API_KEY: process.env.API_KEY || undefined,
      BACKUP_DIR: process.env.BACKUP_DIR || undefined,
      BACKUP_RETAIN_DAYS: Number(process.env.BACKUP_RETAIN_DAYS ?? 7),
      BACKUP_SCHEDULE: process.env.BACKUP_SCHEDULE ?? "0 2 * * *",
      BACKUP_REMOTE_RETENTION_DAYS: process.env.BACKUP_REMOTE_RETENTION_DAYS
        ? Number(process.env.BACKUP_REMOTE_RETENTION_DAYS)
        : undefined,
      BACKUP_REMOTE_IMMUTABLE_DAYS: Number(process.env.BACKUP_REMOTE_IMMUTABLE_DAYS ?? 0),
      BACKUP_RESTORE_DRILL_SCHEDULE: process.env.BACKUP_RESTORE_DRILL_SCHEDULE ?? "0 4 * * 0",
      BACKUP_MAX_RTO_MS: Number(process.env.BACKUP_MAX_RTO_MS ?? 5 * 60 * 1000),
      BACKUP_MAX_RPO_MINUTES: Number(process.env.BACKUP_MAX_RPO_MINUTES ?? 24 * 60),
      BACKUP_PG_RESTORE_PATH: process.env.BACKUP_PG_RESTORE_PATH ?? "pg_restore",
      PRIVACY_MASTER_KEY: process.env.PRIVACY_MASTER_KEY || undefined,
      PROMETHEUS_SCRAPE_KEY: process.env.PROMETHEUS_SCRAPE_KEY || undefined,
      LOG_REDACTION_SALT: process.env.LOG_REDACTION_SALT || undefined,
      EXPORT_SIGNATURE_TTL_MS: Number(process.env.EXPORT_SIGNATURE_TTL_MS ?? 5 * 60 * 1000)
    } satisfies Env;
  }
  return parseEnv();
}
