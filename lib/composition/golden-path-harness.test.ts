import { describe, expect, it } from "vitest";
import { runDeterministicGoldenPath } from "@/lib/composition/golden-path-harness";

const expectedStages = [
  "objective",
  "plan",
  "validation",
  "policy",
  "decision",
  "approval",
  "authorization",
  "task",
  "job",
  "placement",
  "governor",
  "reservation",
  "credential-admission",
  "dispatch-admission",
  "start-verification",
  "job-executing",
  "provider-completed",
  "completion-verification",
  "outcome",
  "event-audit",
  "owner-visibility",
  "memory",
  "resource-release"
] as const;

describe("cross-phase deterministic golden path", () => {
  it("composes the full governed path without claiming production execution", async () => {
    const result = await runDeterministicGoldenPath();

    expect(result.simulationOnly).toBe(true);
    expect(result.productionExecutionClaimed).toBe(false);
    expect(result.stages.map((item) => item.name)).toEqual(expectedStages);
    expect(result.stages.every((item) => item.status === "passed")).toBe(true);
    expect(result.stages.every((item) => item.artifactHash.length === 64)).toBe(true);

    expect(result.final).toEqual({
      jobState: "verified",
      outcomeState: "verified",
      eventState: "processed",
      ownerVisibleJobState: "verified",
      auditEventCount: 4,
      memoryAuthority: "advisory",
      reservationState: "released",
      credentialState: "released",
      reservedCapacity: { cpu: 0, memoryMb: 0 }
    });
  });

  it("is deterministic across repeated runs", async () => {
    const first = await runDeterministicGoldenPath();
    const second = await runDeterministicGoldenPath();

    expect(second.resultHash).toBe(first.resultHash);
    expect(second.stages).toEqual(first.stages);
    expect(second.final).toEqual(first.final);
  });


  it("preserves the authoritative lifecycle ordering without shortcutting approval, verification, audit, or owner visibility", async () => {
    const result = await runDeterministicGoldenPath();
    const index = (name: (typeof expectedStages)[number]) =>
      result.stages.findIndex((item) => item.name === name);

    const authorityOrder = [
      "objective",
      "plan",
      "decision",
      "approval",
      "authorization",
      "task",
      "job",
      "dispatch-admission",
      "start-verification",
      "job-executing",
      "provider-completed",
      "completion-verification",
      "outcome",
      "event-audit",
      "owner-visibility"
    ] as const;

    for (let i = 1; i < authorityOrder.length; i += 1) {
      expect(index(authorityOrder[i])).toBeGreaterThan(index(authorityOrder[i - 1]));
    }
  });

  it("places Job execution only after independent resource-start verification", async () => {
    const result = await runDeterministicGoldenPath();
    const dispatchIndex = result.stages.findIndex((item) => item.name === "dispatch-admission");
    const startIndex = result.stages.findIndex((item) => item.name === "start-verification");
    const executingIndex = result.stages.findIndex((item) => item.name === "job-executing");

    expect(dispatchIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(dispatchIndex);
    expect(executingIndex).toBeGreaterThan(startIndex);
  });

  it("does not release capacity before authoritative completion and outcome truth", async () => {
    const result = await runDeterministicGoldenPath();
    const completionIndex = result.stages.findIndex((item) => item.name === "completion-verification");
    const outcomeIndex = result.stages.findIndex((item) => item.name === "outcome");
    const memoryIndex = result.stages.findIndex((item) => item.name === "memory");
    const releaseIndex = result.stages.findIndex((item) => item.name === "resource-release");

    expect(outcomeIndex).toBeGreaterThan(completionIndex);
    expect(memoryIndex).toBeGreaterThan(outcomeIndex);
    expect(releaseIndex).toBeGreaterThan(memoryIndex);
  });
});
