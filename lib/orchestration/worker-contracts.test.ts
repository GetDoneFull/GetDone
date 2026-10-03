import { describe, expect, it } from "vitest";
import {
  assertOrchestrationLease,
  computeOrchestrationBackoffMs,
  createOrchestrationLease,
  orchestrationClaimIdempotencyKey,
  orchestrationDeferIdempotencyKey,
  orchestrationHeartbeatIdempotencyKey,
  orchestrationReleaseIdempotencyKey,
  orchestrationRetryIdempotencyKey,
  renewOrchestrationLease
} from "@/lib/orchestration/worker-contracts";

describe("orchestration worker contracts", () => {
  it("creates and validates a hash-bound lease", () => {
    const lease = createOrchestrationLease({
      id: "lease-1",
      runId: "run-1",
      workerId: "worker-1",
      claimedRunVersion: 4,
      claimedRecordHash: "a".repeat(64),
      attempt: 2,
      consecutiveFailures: 1,
      issuedAt: "2026-09-28T10:00:00.000Z",
      leaseSeconds: 60
    });

    expect(lease.version).toBe(1);
    expect(lease.attempt).toBe(2);
    expect(lease.consecutiveFailures).toBe(1);
    expect(assertOrchestrationLease(lease, {
      runId: "run-1",
      workerId: "worker-1",
      now: Date.parse("2026-09-28T10:00:30.000Z")
    })).toBe(lease);
  });

  it("rejects tampered or expired leases", () => {
    const lease = createOrchestrationLease({
      id: "lease-1",
      runId: "run-1",
      workerId: "worker-1",
      claimedRunVersion: 4,
      claimedRecordHash: "a".repeat(64),
      attempt: 1,
      consecutiveFailures: 0,
      issuedAt: "2026-09-28T10:00:00.000Z",
      leaseSeconds: 60
    });

    expect(() => assertOrchestrationLease({
      ...lease,
      workerId: "worker-2"
    })).toThrow(/integrity/i);

    expect(() => assertOrchestrationLease(lease, {
      now: Date.parse("2026-09-28T10:01:00.000Z")
    })).toThrow(/expired/i);
  });

  it("renews a lease by advancing its lease version and hash", () => {
    const lease = createOrchestrationLease({
      id: "lease-1",
      runId: "run-1",
      workerId: "worker-1",
      claimedRunVersion: 4,
      claimedRecordHash: "a".repeat(64),
      attempt: 1,
      consecutiveFailures: 0,
      issuedAt: "2026-09-28T10:00:00.000Z",
      leaseSeconds: 60
    });
    const renewed = renewOrchestrationLease(lease, {
      now: "2026-09-28T10:00:20.000Z",
      extendSeconds: 60
    });

    expect(renewed.version).toBe(2);
    expect(renewed.leaseHash).not.toBe(lease.leaseHash);
    expect(renewed.expiresAt).toBe("2026-09-28T10:01:20.000Z");
  });

  it("uses deterministic worker operation idempotency keys", () => {
    const lease = createOrchestrationLease({
      id: "lease-1",
      runId: "run-1",
      workerId: "worker-1",
      claimedRunVersion: 4,
      claimedRecordHash: "a".repeat(64),
      attempt: 3,
      consecutiveFailures: 2,
      issuedAt: "2026-09-28T10:00:00.000Z",
      leaseSeconds: 60
    });

    expect(orchestrationClaimIdempotencyKey({
      runId: "run-1",
      runVersion: 4,
      workerId: "worker-1"
    })).toBe("orchestration-worker:claim:run-1:v4:worker-1");
    expect(orchestrationHeartbeatIdempotencyKey(lease))
      .toBe("orchestration-worker:heartbeat:lease-1:v1");
    expect(orchestrationReleaseIdempotencyKey(lease))
      .toBe("orchestration-worker:release:lease-1");
    expect(orchestrationRetryIdempotencyKey(lease))
      .toBe("orchestration-worker:retry:lease-1:attempt3");
    expect(orchestrationDeferIdempotencyKey(lease))
      .toBe("orchestration-worker:defer:lease-1:attempt3");
  });

  it("computes deterministic capped exponential backoff with bounded jitter", () => {
    const first = computeOrchestrationBackoffMs({
      runId: "run-1",
      attempt: 1,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000
    });
    const same = computeOrchestrationBackoffMs({
      runId: "run-1",
      attempt: 1,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000
    });
    const later = computeOrchestrationBackoffMs({
      runId: "run-1",
      attempt: 8,
      baseDelayMs: 1_000,
      maxDelayMs: 10_000
    });

    expect(first).toBe(same);
    expect(first).toBeGreaterThanOrEqual(750);
    expect(first).toBeLessThanOrEqual(1_000);
    expect(later).toBeGreaterThanOrEqual(7_500);
    expect(later).toBeLessThanOrEqual(10_000);
  });
});
