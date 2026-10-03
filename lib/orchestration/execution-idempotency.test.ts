import { describe, expect, it } from "vitest";
import {
  jobSideEffectIdempotencyKey,
  orchestrationJobEnqueueIdempotencyKey,
  orchestrationTaskGenerationIdempotencyKey
} from "@/lib/orchestration/execution-idempotency";

describe("non-negotiable execution idempotency identities", () => {
  it("uses the required orchestration Task-generation identity", () => {
    expect(orchestrationTaskGenerationIdempotencyKey("run-123", 7))
      .toBe("orchestration:run-123:v7:task-generation");
  });

  it("uses the required orchestration Job-enqueue identity", () => {
    expect(orchestrationJobEnqueueIdempotencyKey("run-123", 8))
      .toBe("orchestration:run-123:v8:job-enqueue");
  });

  it("uses a stable per-Job side-effect identity", () => {
    expect(jobSideEffectIdempotencyKey("job-123", "operation-4"))
      .toBe("job:job-123:side-effect:operation-4");
  });

  it("fails closed on malformed identity components", () => {
    expect(() => orchestrationTaskGenerationIdempotencyKey("", 1)).toThrow();
    expect(() => orchestrationJobEnqueueIdempotencyKey("run", 0)).toThrow();
    expect(() => jobSideEffectIdempotencyKey("job", "send email")).toThrow();
  });
});
