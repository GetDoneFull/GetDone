import { describe, expect, it } from "vitest";
import {
  normalizeObjectiveIntake,
  objectiveInboxCounts
} from "@/lib/domain/objective-inbox";

const scope = {
  userId: "user-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};

function parse(rawText: string, source?: Parameters<typeof normalizeObjectiveIntake>[0]["source"]) {
  let sequence = 0;
  return normalizeObjectiveIntake(
    { rawText, source },
    {
      scope,
      correlationId: "corr-a",
      now: "2026-09-28T18:00:00.000Z",
      nextId: () => `objective-${++sequence}`
    }
  );
}

describe("objective inbox normalization", () => {
  it("keeps a natural-language governed command as one objective and extracts owner constraints", () => {
    const [objective] = parse(
      "Fix onboarding. Make safe fixes yourself. Deploy staging automatically. Ask me before production."
    );

    expect(objective).toMatchObject({
      id: "objective-1",
      objectiveId: "objective-1",
      portfolioId: "portfolio-a",
      companyId: "company-a",
      source: "free_text",
      normalizedGoal: "Fix onboarding",
      desiredOutcome: "Fix onboarding",
      status: "queued",
      relationship: "independent",
      riskLevel: "high"
    });
    expect(objective.constraints).toEqual([
      "Make safe fixes yourself",
      "Deploy staging automatically",
      "Ask me before production"
    ]);
  });

  it("splits independent list items into independent objectives", () => {
    const objectives = parse("- Improve onboarding\n- Reduce support backlog\n- Audit billing");
    expect(objectives).toHaveLength(3);
    expect(objectives.map((objective) => objective.normalizedGoal)).toEqual([
      "Improve onboarding",
      "Reduce support backlog",
      "Audit billing"
    ]);
    expect(objectives.every((objective) => objective.relationship === "independent")).toBe(true);
  });

  it("turns a heading plus checklist into one parent objective with step objectives", () => {
    const objectives = parse(
      "Improve OpsManagerPro onboarding:\n- [ ] Investigate signup funnel\n- [ ] Reproduce frontend bug\n- [ ] Verify staging"
    );
    expect(objectives).toHaveLength(4);
    expect(objectives[0]).toMatchObject({
      normalizedGoal: "Improve OpsManagerPro onboarding",
      relationship: "independent"
    });
    expect(objectives.slice(1).every((objective) =>
      objective.relationship === "step"
      && objective.parentObjectiveId === "objective-1"
    )).toBe(true);
  });

  it("records explicit dependent list items without collapsing them into steps", () => {
    const objectives = parse(
      "- Prepare staging build\n- Then: verify staging\n- Then: request production approval"
    );
    expect(objectives).toHaveLength(3);
    expect(objectives[1]).toMatchObject({
      relationship: "dependent",
      dependsOnObjectiveIds: ["objective-1"]
    });
    expect(objectives[2]).toMatchObject({
      relationship: "dependent",
      dependsOnObjectiveIds: ["objective-2"]
    });
  });

  it("splits an unmarked multiline batch into independent objectives", () => {
    const objectives = parse("Improve onboarding\nReduce support backlog\nAudit billing");
    expect(objectives.map((objective) => objective.normalizedGoal)).toEqual([
      "Improve onboarding",
      "Reduce support backlog",
      "Audit billing"
    ]);
    expect(objectives.every((objective) => objective.source === "multiline_list")).toBe(true);
  });

  it("classifies pasted multi-paragraph text as one document objective", () => {
    const objectives = parse(
      "Onboarding review\n\nInvestigate where users abandon signup.\nVerify the resulting fix in staging before release."
    );
    expect(objectives).toHaveLength(1);
    expect(objectives[0].source).toBe("pasted_document");
  });

  it("splits a list-shaped uploaded task file but keeps prose documents together", () => {
    const tasks = parse("Patch onboarding\nVerify staging\nThen: request production approval", "uploaded_text");
    expect(tasks).toHaveLength(3);
    expect(tasks[2]).toMatchObject({
      relationship: "dependent",
      dependsOnObjectiveIds: ["objective-2"]
    });

    const document = parse(
      "Onboarding review\n\nWe need to examine the full funnel before deciding on a release.\nKeep this document together.",
      "uploaded_text"
    );
    expect(document).toHaveLength(1);
  });

  it("supports structured JSON with constraints, success criteria, priority and dependencies", () => {
    const objectives = parse(JSON.stringify({
      objectives: [
        {
          goal: "Patch onboarding",
          desired_outcome: "Onboarding passes verification",
          constraints: ["staging first"],
          success_criteria: ["42 tests pass"],
          priority: "high"
        },
        {
          goal: "Release onboarding",
          relationship: "dependent",
          depends_on_indexes: [0],
          risk_level: "high"
        }
      ]
    }), "structured_json");

    expect(objectives[0]).toMatchObject({
      normalizedGoal: "Patch onboarding",
      desiredOutcome: "Onboarding passes verification",
      priority: "high",
      constraints: ["staging first"],
      successCriteria: ["42 tests pass"]
    });
    expect(objectives[1].dependsOnObjectiveIds).toEqual(["objective-1"]);
  });

  it("computes owner-facing home counts without exposing task/job state", () => {
    const counts = objectiveInboxCounts([
      { status: "executing", updatedAt: "2026-09-28T17:00:00.000Z" },
      { status: "needs_owner_input", updatedAt: "2026-09-28T17:00:00.000Z" },
      { status: "completed", completedAt: "2026-09-28T16:00:00.000Z", updatedAt: "2026-09-28T16:00:00.000Z" },
      { status: "completed", completedAt: "2026-09-27T16:00:00.000Z", updatedAt: "2026-09-27T16:00:00.000Z" }
    ], new Date("2026-09-28T18:00:00.000Z"));

    expect(counts).toEqual({
      running: 1,
      waitingForOwner: 1,
      completedToday: 1
    });
  });
});
