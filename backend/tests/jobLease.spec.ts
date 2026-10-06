import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import {
  JobLeaseService,
  InMemoryJobLeaseStore
} from "../src/services/jobLeaseService.js";

const logger = pino({ level: "silent" });

function makeClock(startMs: number) {
  let now = startMs;
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    }
  };
}

describe("InMemoryJobLeaseStore", () => {
  it("allows only one owner under contention", async () => {
    const store = new InMemoryJobLeaseStore();
    const t0 = new Date("2026-09-25T00:00:00.000Z");
    const a = await store.tryAcquire("job-a", "owner-1", 5_000, t0);
    const b = await store.tryAcquire("job-a", "owner-2", 5_000, t0);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    if (!b.acquired) expect(b.reason).toBe("held_by_other");
  });

  it("recovers a crashed owner after lease expiry", async () => {
    const store = new InMemoryJobLeaseStore();
    const t0 = new Date("2026-09-25T00:00:00.000Z");
    const a = await store.tryAcquire("job-a", "owner-1", 1_000, t0);
    expect(a.acquired).toBe(true);

    const t1 = new Date(t0.getTime() + 1_001);
    const b = await store.tryAcquire("job-a", "owner-2", 1_000, t1);
    expect(b.acquired).toBe(true);
    if (a.acquired && b.acquired) {
      expect(b.fenceToken).toBe(a.fenceToken + BigInt(1));
    }
  });

  it("keeps the fence monotonic after a normal release", async () => {
    const store = new InMemoryJobLeaseStore();
    const now = new Date("2026-09-25T00:00:00.000Z");
    const first = await store.tryAcquire("job-a", "owner-1", 5_000, now);
    expect(first.acquired).toBe(true);
    if (!first.acquired) return;

    expect(await store.release("job-a", "owner-1", first.fenceToken)).toBe(true);
    const second = await store.tryAcquire("job-a", "owner-2", 5_000, now);
    expect(second.acquired).toBe(true);
    if (!second.acquired) return;

    expect(second.fenceToken).toBe(first.fenceToken + BigInt(1));
    expect(await store.release("job-a", "owner-1", first.fenceToken)).toBe(false);
  });

  it("rejects renew and release from a stale fence", async () => {
    const store = new InMemoryJobLeaseStore();
    const t0 = new Date("2026-09-25T00:00:00.000Z");
    const a = await store.tryAcquire("job-a", "owner-1", 1_000, t0);
    expect(a.acquired).toBe(true);
    if (!a.acquired) return;

    const t1 = new Date(t0.getTime() + 2_000);
    const b = await store.tryAcquire("job-a", "owner-2", 5_000, t1);
    expect(b.acquired).toBe(true);
    if (!b.acquired) return;

    const renew = await store.renew("job-a", "owner-1", a.fenceToken, 5_000, t1);
    expect(renew.renewed).toBe(false);
    if (!renew.renewed) expect(renew.reason).toBe("lost_fence");

    const released = await store.release("job-a", "owner-1", a.fenceToken);
    expect(released).toBe(false);

    const renew2 = await store.renew("job-a", "owner-2", b.fenceToken, 5_000, t1);
    expect(renew2.renewed).toBe(true);
  });

  it("does not let a duplicate owner ID replace a live worker", async () => {
    const store = new InMemoryJobLeaseStore();
    const t0 = new Date("2026-09-25T00:00:00.000Z");
    const a = await store.tryAcquire("job-a", "owner-1", 5_000, t0);
    expect(a.acquired).toBe(true);
    if (!a.acquired) return;

    const b = await store.tryAcquire("job-a", "owner-1", 5_000, t0);
    expect(b.acquired).toBe(false);
    const replacement = await store.tryAcquire("job-a", "owner-1", 5_000, new Date(t0.getTime() + 5_001));
    expect(replacement.acquired).toBe(true);
    if (replacement.acquired) expect(replacement.fenceToken).toBe(a.fenceToken + BigInt(1));
    const staleRenew = await store.renew("job-a", "owner-1", a.fenceToken, 5_000, new Date(t0.getTime() + 5_001));
    expect(staleRenew.renewed).toBe(false);
  });
});

describe("JobLeaseService.runWithLease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs work for the lease holder and skips the contender", async () => {
    const store = new InMemoryJobLeaseStore();
    const clock = makeClock(Date.parse("2026-09-25T00:00:00.000Z"));

    const a = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-a",
      ttlMs: 5_000,
      heartbeatMs: 60_000,
      now: clock.now
    });
    const b = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-b",
      ttlMs: 5_000,
      heartbeatMs: 60_000,
      now: clock.now
    });

    let ran = 0;
    const first = a.runWithLease("cron:reconciler", async () => {
      ran += 1;
      return "ok";
    });
    await Promise.resolve();
    const second = await b.runWithLease("cron:reconciler", async () => {
      ran += 1;
      return "nope";
    });
    const firstResult = await first;

    expect(firstResult.status).toBe("ran");
    expect(second.status).toBe("skipped");
    expect(ran).toBe(1);
  });

  it("skips overlapping ticks in the same process", async () => {
    const store = new InMemoryJobLeaseStore();
    const svc = new JobLeaseService({
      logger,
      store,
      ownerId: "solo",
      ttlMs: 30_000,
      heartbeatMs: 60_000
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = svc.runWithLease("cron:quest", async () => {
      await gate;
      return 1;
    });
    await Promise.resolve();
    const overlap = await svc.runWithLease("cron:quest", async () => 2);
    release();
    const firstResult = await first;

    expect(firstResult.status).toBe("ran");
    expect(overlap.status).toBe("skipped");
    if (overlap.status === "skipped") expect(overlap.reason).toBe("local_overlap");
  });

  it("guards pending acquisition and releases it if shutdown wins", async () => {
    let completeAcquire!: () => void;
    const gate = new Promise<void>((resolve) => {
      completeAcquire = resolve;
    });
    const store = new (class extends InMemoryJobLeaseStore {
      calls = 0;

      override async tryAcquire(jobName: string, ownerId: string, ttlMs: number, now?: Date) {
        this.calls += 1;
        await gate;
        return super.tryAcquire(jobName, ownerId, ttlMs, now);
      }
    })();
    const svc = new JobLeaseService({
      logger,
      store,
      ownerId: "solo",
      heartbeatMs: 60_000
    });

    let ran = 0;
    const pending = svc.runWithLease("cron:pending", async () => {
      ran += 1;
      return true;
    });
    const overlap = await svc.runWithLease("cron:pending", async () => {
      ran += 1;
      return false;
    });
    expect(overlap).toEqual({ status: "skipped", reason: "local_overlap" });
    expect(store.calls).toBe(1);

    const shutdown = svc.shutdown();
    completeAcquire();
    await shutdown;
    expect(await pending).toEqual({ status: "skipped", reason: "shutting_down" });
    expect(ran).toBe(0);
    expect(store.peek("cron:pending")?.ownerId).toBe("");
  });

  it("keeps only one pending heartbeat per run and resumes after renewal", async () => {
    const store = new InMemoryJobLeaseStore();
    const actualRenew = store.renew.bind(store);
    let releaseRenewal!: () => void;
    const renewalGate = new Promise<void>((resolve) => { releaseRenewal = resolve; });
    const renew = vi.spyOn(store, "renew").mockImplementation(async (...args) => {
      await renewalGate;
      return actualRenew(...args);
    });
    const svc = new JobLeaseService({
      logger, store, ownerId: "slow-store", ttlMs: 30_000, heartbeatMs: 10
    });
    let completeWork!: () => void;
    const workGate = new Promise<void>((resolve) => { completeWork = resolve; });
    const running = svc.runWithLease("cron:slow", async () => {
      await workGate;
      return "done";
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renew).toHaveBeenCalledTimes(1);
      releaseRenewal();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(renew).toHaveBeenCalledTimes(2);
      completeWork();
      expect((await running).status).toBe("ran");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      releaseRenewal();
      completeWork();
      await running;
      await svc.shutdown();
    }
  });

  it("marks fence_lost when another owner steals after expiry mid-run", async () => {
    const store = new InMemoryJobLeaseStore();
    const clock = makeClock(Date.parse("2026-09-25T00:00:00.000Z"));

    const a = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-a",
      ttlMs: 1_000,
      heartbeatMs: 200,
      now: clock.now
    });
    const b = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-b",
      ttlMs: 5_000,
      heartbeatMs: 60_000,
      now: clock.now
    });

    const resultPromise = a.runWithLease("cron:indexer", async ({ signal }) => {
      clock.advance(1_500);
      const stolen = await b.runWithLease("cron:indexer", async () => "stolen");
      expect(stolen.status).toBe("ran");
      await vi.advanceTimersByTimeAsync(250);
      expect(signal.aborted).toBe(true);
      return "stale";
    });

    const result = await resultPromise;
    expect(result.status).toBe("fence_lost");
  });

  it("rejects a stale effect before the next heartbeat observes takeover", async () => {
    const store = new InMemoryJobLeaseStore();
    const clock = makeClock(Date.parse("2026-09-25T00:00:00.000Z"));
    const a = new JobLeaseService({ logger, store, ownerId: "a", ttlMs: 1_000, heartbeatMs: 60_000, now: clock.now });
    const b = new JobLeaseService({ logger, store, ownerId: "b", ttlMs: 1_000, heartbeatMs: 60_000, now: clock.now });
    const commit = vi.fn(async () => undefined);
    const result = await a.runWithLease("job", async (lease) => {
      clock.advance(1_001);
      expect((await b.runWithLease("job", async () => undefined)).status).toBe("ran");
      await expect(lease.withFence(commit)).rejects.toThrow("no longer current");
      expect(lease.signal.aborted).toBe(true);
    });
    expect(commit).not.toHaveBeenCalled();
    expect(result.status).toBe("fence_lost");
  });

  it("cannot report success after expiry even without a replacement or heartbeat", async () => {
    const clock = makeClock(Date.parse("2026-09-25T00:00:00.000Z"));
    const svc = new JobLeaseService({ logger, store: new InMemoryJobLeaseStore(), ttlMs: 1_000, heartbeatMs: 60_000, now: clock.now });
    expect((await svc.runWithLease("job", async () => clock.advance(1_001))).status).toBe("fence_lost");
  });

  it("releases leases on shutdown so another replica can acquire", async () => {
    const store = new InMemoryJobLeaseStore();
    const a = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-a",
      ttlMs: 30_000,
      heartbeatMs: 60_000
    });
    const b = new JobLeaseService({
      logger,
      store,
      ownerId: "replica-b",
      ttlMs: 30_000,
      heartbeatMs: 60_000
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const running = a.runWithLease("cron:backup", async () => {
      await gate;
      return true;
    });
    await Promise.resolve();

    const blocked = await b.runWithLease("cron:backup", async () => false);
    expect(blocked.status).toBe("skipped");

    const shutdown = a.shutdown();
    release();
    await running;
    await shutdown;

    const after = await b.runWithLease("cron:backup", async () => true);
    expect(after.status).toBe("ran");
  });
});
