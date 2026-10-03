import { describe, expect, it } from "vitest";
import {
  createDurableJobExecutionOutcome,
  createDurableJobRuntimeEvent
} from "@/lib/execution/job-runtime-records";

describe("durable Job outcome and event records", () => {
  it("hash-binds a durable execution outcome to the Job transaction", () => {
    const outcome = createDurableJobExecutionOutcome({
      id: "outcome-1",
      jobId: "job-1",
      kind: "provider-completed",
      runtimeState: "released",
      attempt: 1,
      occurredAt: "2026-09-21T23:00:00Z",
      transactionHash: "transaction-hash"
    });

    expect(outcome.recordHash).toHaveLength(64);
    expect(outcome).toMatchObject({
      jobId: "job-1",
      kind: "provider-completed",
      runtimeState: "released",
      attempt: 1
    });
  });

  it("binds runtime events to exact outcome and transaction lineage", () => {
    const outcome = createDurableJobExecutionOutcome({
      id: "outcome-2",
      jobId: "job-2",
      kind: "retry-scheduled",
      runtimeState: "retry-wait",
      attempt: 2,
      reason: "transient provider failure",
      occurredAt: "2026-09-21T23:01:00Z",
      transactionHash: "retry-transaction"
    });
    const event = createDurableJobRuntimeEvent({
      id: "event-2",
      jobId: "job-2",
      eventType: "job.retry-scheduled",
      attempt: 2,
      occurredAt: "2026-09-21T23:01:00Z",
      transactionHash: "retry-transaction",
      outcome
    });

    expect(event.outcomeHash).toBe(outcome.recordHash);
    expect(event.transactionHash).toBe(outcome.transactionHash);
    expect(event.recordHash).toHaveLength(64);
  });

  it("rejects invalid timestamps, attempts, and cross-Job event lineage", () => {
    expect(() => createDurableJobExecutionOutcome({
      id: "bad-time",
      jobId: "job-1",
      kind: "cancelled",
      runtimeState: "cancelled",
      attempt: 0,
      occurredAt: "not-a-time",
      transactionHash: "tx"
    })).toThrow(/timestamp/i);

    expect(() => createDurableJobExecutionOutcome({
      id: "bad-attempt",
      jobId: "job-1",
      kind: "dead-lettered",
      runtimeState: "dead-lettered",
      attempt: -1,
      occurredAt: "2026-09-21T23:00:00Z",
      transactionHash: "tx"
    })).toThrow(/attempt/i);

    const outcome = createDurableJobExecutionOutcome({
      id: "outcome-3",
      jobId: "job-a",
      kind: "provider-completed",
      runtimeState: "released",
      attempt: 1,
      occurredAt: "2026-09-21T23:00:00Z",
      transactionHash: "tx-3"
    });
    expect(() => createDurableJobRuntimeEvent({
      id: "event-3",
      jobId: "job-b",
      eventType: "job.provider-completed",
      attempt: 1,
      occurredAt: "2026-09-21T23:00:00Z",
      transactionHash: "tx-3",
      outcome
    })).toThrow(/outcome lineage/i);
  });
});
