import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

export type LeaseAcquisition =
  | { acquired: true; fenceToken: bigint; ownerId: string; expiresAt: Date }
  | { acquired: false; reason: "held_by_other" | "clock_skew" | "store_error"; holder?: string };

export type LeaseRenewal =
  | { renewed: true; expiresAt: Date }
  | { renewed: false; reason: "lost_fence" | "expired" | "store_error" };

export interface JobLeaseStore {
  tryAcquire(jobName: string, ownerId: string, ttlMs: number, now?: Date): Promise<LeaseAcquisition>;
  renew(jobName: string, ownerId: string, fenceToken: bigint, ttlMs: number, now?: Date): Promise<LeaseRenewal>;
  release(jobName: string, ownerId: string, fenceToken: bigint): Promise<boolean>;
  runFenced<T>(
    jobName: string,
    ownerId: string,
    fenceToken: bigint,
    signal: AbortSignal,
    work: (tx?: Prisma.TransactionClient) => Promise<T>,
    now?: () => Date
  ): Promise<T>;
}

export class LeaseLostError extends Error {
  constructor(jobName: string) {
    super(`Job lease is no longer current: ${jobName}`);
    this.name = "LeaseLostError";
  }
}

export interface JobLeaseContext {
  jobName: string;
  ownerId: string;
  fenceToken: bigint;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  /** Serializes a short external effect with lease handoff; not a remote transaction. */
  withFence<T>(work: () => Promise<T>): Promise<T>;
  /** All database writes must use this transaction's client, never the outer client. */
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

export type RunWithLeaseResult<T> =
  | { status: "ran"; value: T; fenceToken: bigint }
  | { status: "skipped"; reason: string }
  | { status: "fence_lost"; error?: unknown };

export type JobLeaseServiceOptions = {
  /** Required unless `store` is provided (tests). */
  prisma?: PrismaClient;
  logger: Logger;
  /** Stable owner id for this process. Defaults to hostname:pid:uuid. */
  ownerId?: string;
  /** Lease TTL. Must exceed max expected tick duration + heartbeat interval. */
  ttlMs?: number;
  /** Heartbeat cadence while a job is running. */
  heartbeatMs?: number;
  /** Optional injectable store (tests). Defaults to PrismaJobLeaseStore. */
  store?: JobLeaseStore;
  /** Clock for tests. */
  now?: () => Date;
};

/**
 * Distributed job lease manager (#93).
 *
 * Guarantees:
 * - At most one owner holds a named lease across replicas.
 * - Heartbeats renew the lease; a stale owner is recoverable after expiry.
 * - fenceToken is monotonic per job; a worker that lost the fence cannot renew
 *   or release, and runWithLease aborts before returning success.
 */
export class JobLeaseService {
  readonly ownerId: string;
  private readonly store: JobLeaseStore;
  private readonly logger: Logger;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => Date;
  private readonly active = new Map<
    string,
    { fenceToken: bigint; heartbeat: NodeJS.Timeout; abort: AbortController }
  >();
  private readonly acquiring = new Set<string>();
  private readonly drainWaiters = new Set<() => void>();
  private shuttingDown = false;

  constructor(opts: JobLeaseServiceOptions) {
    this.ownerId = opts.ownerId ?? `${hostname()}:${process.pid}:${randomUUID()}`;
    if (opts.store) {
      this.store = opts.store;
    } else if (opts.prisma) {
      this.store = new PrismaJobLeaseStore(opts.prisma);
    } else {
      throw new Error("JobLeaseService requires prisma or store");
    }
    this.logger = opts.logger;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.heartbeatMs = opts.heartbeatMs ?? Math.max(1, Math.floor(this.ttlMs / 3));
    this.now = opts.now ?? (() => new Date());
  }

  /** In-process overlap guard + distributed lease for a named job tick. */
  async runWithLease<T>(
    jobName: string,
    work: (ctx: JobLeaseContext) => Promise<T>
  ): Promise<RunWithLeaseResult<T>> {
    if (this.shuttingDown) {
      return { status: "skipped", reason: "shutting_down" };
    }
    if (this.active.has(jobName) || this.acquiring.has(jobName)) {
      this.logger.info({ jobName }, "job lease skipped: local overlap");
      return { status: "skipped", reason: "local_overlap" };
    }

    this.acquiring.add(jobName);
    let acquisition: LeaseAcquisition;
    try {
      acquisition = await this.store.tryAcquire(jobName, this.ownerId, this.ttlMs, this.now());
      if (this.shuttingDown && acquisition.acquired) {
        try {
          await this.store.release(jobName, this.ownerId, acquisition.fenceToken);
        } catch (err) {
          this.logger.warn({ err, jobName }, "job lease release after shutdown failed");
        }
        return { status: "skipped", reason: "shutting_down" };
      }
    } finally {
      this.acquiring.delete(jobName);
      this.notifyDrainWaiters();
    }
    if (!acquisition.acquired) {
      this.logger.info(
        { jobName, reason: acquisition.reason, holder: acquisition.holder },
        "job lease skipped: not acquired"
      );
      return { status: "skipped", reason: acquisition.reason };
    }

    const abort = new AbortController();
    const fenced = async <V>(fn: (tx?: Prisma.TransactionClient) => Promise<V>): Promise<V> => {
      try {
        abort.signal.throwIfAborted();
        return await this.store.runFenced(
          jobName, this.ownerId, acquisition.fenceToken, abort.signal, fn, this.now
        );
      } catch (error) {
        // A failed ownership check or uncertain transaction must stop this run,
        // including callers whose error-isolation code catches the rejection.
        abort.abort(error);
        throw error;
      }
    };
    const context: JobLeaseContext = {
      jobName,
      ownerId: this.ownerId,
      fenceToken: acquisition.fenceToken,
      signal: abort.signal,
      assertCurrent: () => fenced(async () => undefined),
      withFence: (fn) => fenced(() => fn()),
      transaction: (fn) => fenced((tx) => {
        if (!tx) throw new Error("Database fencing requires a PostgreSQL lease store");
        return fn(tx);
      })
    };
    // A fenced transaction may hold the lease row while renewal waits. Keep
    // the existing cadence, but never queue another renewal for this run.
    let renewalInFlight = false;
    const heartbeat = setInterval(() => {
      if (renewalInFlight || abort.signal.aborted) return;
      renewalInFlight = true;
      void this.heartbeat(jobName, acquisition.fenceToken, abort).finally(() => {
        renewalInFlight = false;
      });
    }, this.heartbeatMs);
    // Allow process to exit even if a heartbeat timer is pending.
    heartbeat.unref?.();

    this.active.set(jobName, { fenceToken: acquisition.fenceToken, heartbeat, abort });

    try {
      const value = await work(context);
      if (abort.signal.aborted) {
        return { status: "fence_lost" };
      }
      await context.assertCurrent();
      return { status: "ran", value, fenceToken: acquisition.fenceToken };
    } catch (error) {
      if (abort.signal.aborted) {
        return { status: "fence_lost", error };
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      try {
        await this.store.release(jobName, this.ownerId, acquisition.fenceToken);
      } catch (err) {
        this.logger.warn({ err, jobName }, "job lease release failed");
      } finally {
        this.active.delete(jobName);
        this.notifyDrainWaiters();
      }
    }
  }

  /** Stop new lease runs and let every in-flight acquisition/run drain. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    while (this.acquiring.size > 0 || this.active.size > 0) {
      await new Promise<void>((resolve) => {
        this.drainWaiters.add(resolve);
      });
    }
  }

  private notifyDrainWaiters(): void {
    if (this.drainWaiters.size === 0) return;
    const waiters = [...this.drainWaiters];
    this.drainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private async heartbeat(jobName: string, fenceToken: bigint, abort: AbortController): Promise<void> {
    if (abort.signal.aborted) return;
    try {
      const result = await this.store.renew(jobName, this.ownerId, fenceToken, this.ttlMs, this.now());
      if (!result.renewed) {
        this.logger.warn({ jobName, reason: result.reason, fenceToken: fenceToken.toString() }, "job lease fence lost");
        abort.abort(new LeaseLostError(jobName));
      }
    } catch (err) {
      this.logger.warn({ err, jobName }, "job lease heartbeat failed");
      abort.abort(new LeaseLostError(jobName));
    }
  }
}

/**
 * Postgres-backed lease store using compare-and-set fencing tokens.
 *
 * Acquire steals only when the existing lease is expired (or absent). Renew
 * and release require the caller to present the current owner+fence pair.
 */
export class PrismaJobLeaseStore implements JobLeaseStore {
  constructor(private readonly prisma: PrismaClient) {}

  async tryAcquire(
    jobName: string,
    ownerId: string,
    ttlMs: number,
    _now?: Date
  ): Promise<LeaseAcquisition> {
    // Use the database clock for every replica. A fast host clock must not
    // steal a live lease; a restarted process must not reuse a live owner ID.
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ owner_id: string; fence_token: bigint; expires_at: Date }>
      >`
        INSERT INTO job_leases
          (job_name, owner_id, fence_token, expires_at, heartbeat_at, updated_at)
        VALUES (${jobName}, ${ownerId}, 1,
          clock_timestamp() + ${ttlMs} * interval '1 millisecond',
          clock_timestamp(), clock_timestamp())
        ON CONFLICT (job_name) DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          fence_token = job_leases.fence_token + 1,
          expires_at = clock_timestamp() + ${ttlMs} * interval '1 millisecond',
          heartbeat_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE job_leases.expires_at <= clock_timestamp()
        RETURNING owner_id, fence_token, expires_at
      `;
      const row = rows[0];
      if (row) {
        return { acquired: true, ownerId: row.owner_id,
          fenceToken: row.fence_token, expiresAt: row.expires_at };
      }
      const held = await this.prisma.jobLease.findUnique({ where: { jobName } });
      return { acquired: false, reason: "held_by_other", holder: held?.ownerId };
    } catch {
      return { acquired: false, reason: "store_error" };
    }
  }

  async renew(
    jobName: string,
    ownerId: string,
    fenceToken: bigint,
    ttlMs: number,
    _now?: Date
  ): Promise<LeaseRenewal> {
    const rows = await this.prisma.$queryRaw<Array<{ expires_at: Date }>>`
      UPDATE job_leases
      SET expires_at = clock_timestamp() + ${ttlMs} * interval '1 millisecond',
          heartbeat_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE job_name = ${jobName} AND owner_id = ${ownerId}
        AND fence_token = ${fenceToken} AND expires_at > clock_timestamp()
      RETURNING expires_at
    `;
    if (rows[0]) return { renewed: true, expiresAt: rows[0].expires_at };
    return { renewed: false, reason: "lost_fence" };
  }

  async runFenced<T>(
    jobName: string,
    ownerId: string,
    fenceToken: bigint,
    signal: AbortSignal,
    work: (tx?: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    signal.throwIfAborted();
    return this.prisma.$transaction(async (tx) => {
      // Lock first, then check time in a separate statement: a lock wait must
      // not preserve an expiry value evaluated before another writer finished.
      await tx.$queryRaw`
        SELECT job_name FROM job_leases WHERE job_name = ${jobName} FOR UPDATE
      `;
      const assertCurrent = async () => {
        signal.throwIfAborted();
        const rows = await tx.$queryRaw<Array<{ job_name: string }>>`
          SELECT job_name FROM job_leases
          WHERE job_name = ${jobName} AND owner_id = ${ownerId}
            AND fence_token = ${fenceToken} AND expires_at > clock_timestamp()
        `;
        if (rows.length !== 1) throw new LeaseLostError(jobName);
      };
      await assertCurrent();
      const value = await work(tx);
      // A transaction that outlives its lease, or an aborted run, rolls back
      // all domain writes. A successor cannot change the fence while locked.
      await assertCurrent();
      return value;
    });
  }

  async release(jobName: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    // Keep the row so the next acquisition increments the existing fence token.
    // Deleting it would reset the token to 1 after every successful run.
    const result = await this.prisma.jobLease.updateMany({
      where: { jobName, ownerId, fenceToken },
      data: { ownerId: "", expiresAt: new Date(0) }
    });
    return result.count === 1;
  }
}

/**
 * In-memory lease store for multi-process contention tests without Docker.
 * Simulates shared state across JobLeaseService instances that share one store.
 */
export class InMemoryJobLeaseStore implements JobLeaseStore {
  private readonly leases = new Map<
    string,
    { ownerId: string; fenceToken: bigint; expiresAt: number; heartbeatAt: number }
  >();

  async tryAcquire(
    jobName: string,
    ownerId: string,
    ttlMs: number,
    now: Date = new Date()
  ): Promise<LeaseAcquisition> {
    const nowMs = now.getTime();
    const existing = this.leases.get(jobName);
    if (existing && existing.expiresAt > nowMs) {
      return { acquired: false, reason: "held_by_other", holder: existing.ownerId };
    }
    const fenceToken = existing ? existing.fenceToken + BigInt(1) : BigInt(1);
    const expiresAt = nowMs + ttlMs;
    this.leases.set(jobName, { ownerId, fenceToken, expiresAt, heartbeatAt: nowMs });
    return { acquired: true, fenceToken, ownerId, expiresAt: new Date(expiresAt) };
  }

  async renew(
    jobName: string,
    ownerId: string,
    fenceToken: bigint,
    ttlMs: number,
    now: Date = new Date()
  ): Promise<LeaseRenewal> {
    const nowMs = now.getTime();
    const existing = this.leases.get(jobName);
    if (!existing) return { renewed: false, reason: "expired" };
    if (existing.expiresAt <= nowMs) return { renewed: false, reason: "expired" };
    if (existing.ownerId !== ownerId || existing.fenceToken !== fenceToken) {
      return { renewed: false, reason: "lost_fence" };
    }
    const expiresAt = nowMs + ttlMs;
    existing.expiresAt = expiresAt;
    existing.heartbeatAt = nowMs;
    return { renewed: true, expiresAt: new Date(expiresAt) };
  }

  async release(jobName: string, ownerId: string, fenceToken: bigint): Promise<boolean> {
    const existing = this.leases.get(jobName);
    if (!existing) return false;
    if (existing.ownerId !== ownerId || existing.fenceToken !== fenceToken) return false;
    existing.ownerId = "";
    existing.expiresAt = 0;
    return true;
  }

  async runFenced<T>(
    jobName: string,
    ownerId: string,
    fenceToken: bigint,
    signal: AbortSignal,
    work: (tx?: Prisma.TransactionClient) => Promise<T>,
    now: () => Date = () => new Date()
  ): Promise<T> {
    signal.throwIfAborted();
    const current = this.leases.get(jobName);
    if (!current || current.ownerId !== ownerId || current.fenceToken !== fenceToken ||
        current.expiresAt <= now().getTime()) {
      throw new LeaseLostError(jobName);
    }
    // The memory store exercises ownership/cancellation logic only. It has
    // no database transaction client and cannot prove PostgreSQL row locking.
    const value = await work();
    signal.throwIfAborted();
    if (this.leases.get(jobName) !== current || current.ownerId !== ownerId ||
        current.fenceToken !== fenceToken || current.expiresAt <= now().getTime()) throw new LeaseLostError(jobName);
    return value;
  }

  /** Test helper: inspect current lease. */
  peek(jobName: string) {
    return this.leases.get(jobName);
  }
}