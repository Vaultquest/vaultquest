import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { InMemoryJobLeaseStore, JobLeaseService } from "../src/services/jobLeaseService.js";

const logger = { info() {}, warn() {} } as unknown as Logger;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("default job lease heartbeat", () => {
  it.each([
    { label: "300ms lease", ttlMs: 300, heartbeatMs: undefined, cadence: 100 },
    { label: "900ms lease", ttlMs: 900, heartbeatMs: undefined, cadence: 300 },
    { label: "default lease", ttlMs: undefined, heartbeatMs: undefined, cadence: 10_000 },
    { label: "explicit override", ttlMs: 900, heartbeatMs: 200, cadence: 200 }
  ])("renews $label without losing ownership", async ({ ttlMs, heartbeatMs, cadence }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    const interval = vi.spyOn(globalThis, "setInterval");
    const store = new InMemoryJobLeaseStore();
    const service = new JobLeaseService({ store, logger, ownerId: "worker", ttlMs, heartbeatMs });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const run = service.runWithLease("heartbeat", async () => {
      await gate;
      return "completed";
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync((ttlMs ?? 30_000) * 2);
      expect(store.peek("heartbeat")?.expiresAt).toBeGreaterThan(Date.now());
      expect(interval).toHaveBeenCalledWith(expect.any(Function), cadence);
      expect(await store.tryAcquire("heartbeat", "rival", ttlMs ?? 30_000))
        .toMatchObject({ acquired: false });
    } finally {
      finish();
      await run;
      await service.shutdown();
    }

    expect(await run).toMatchObject({ status: "ran", value: "completed" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
