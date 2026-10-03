import { describe, expect, it } from "vitest";
import { createPolicySnapshot, assertPolicySnapshotIntegrity } from "@/lib/planning/policy-snapshot";
import { POLICY_ENGINE_VERSION, POLICY_RULES_HASH } from "@/lib/planning/policy-engine";
import { CURRENT_POLICY_VERSION, CURRENT_POLICY_REGISTRY_HASH } from "@/lib/domain/policy-registry";
import { validPlan } from "@/lib/planning/test-fixture";
import { fixtureNow, fixtureScope } from "@/lib/planning/test-security-fixture";
import { hashPlan, hashPlanStep } from "@/lib/planning/plan-hash";

describe("policy snapshot", () => {
  it("captures stable policy versioning, scope, admission context, and resource requirements immutably", () => {
    const plan = validPlan();
    const step = plan.steps[0];
    const snapshot = createPolicySnapshot({
      id: "policy-snapshot-test",
      policyVersion: CURRENT_POLICY_VERSION,
      scope: fixtureScope(plan),
      planHash: hashPlan(plan),
      stepHash: hashPlanStep(step),
      capabilityNames: ["repository.inspect"],
      dataClass: "internal",
      region: "us-west",
      allowedEnvironments: ["staging"],
      allowedDataClasses: ["internal"],
      allowedRegions: ["us-west"],
      integrationId: "github-binding",
      providerId: "github",
      workloadClass: "repository-read",
      killSwitches: [],
      credentialRequirementIds: [],
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: "policy-snapshot-12345678",
      resourceRequirements: step.resourceRequirements,
      createdAt: fixtureNow.toISOString()
    });

    expect(snapshot.capabilityRegistryHash).toHaveLength(64);
    expect(snapshot.resourceRequirementsHash).toHaveLength(64);
    expect(snapshot.policyInputHash).toHaveLength(64);
    expect(snapshot.snapshotHash).toHaveLength(64);
    expect(snapshot.policyEngineVersion).toBe(POLICY_ENGINE_VERSION);
    expect(snapshot.policyRegistryHash).toBe(CURRENT_POLICY_REGISTRY_HASH);
    expect(snapshot.killSwitchSnapshotHash).toHaveLength(64);
    expect(snapshot.policyRulesHash).toBe(POLICY_RULES_HASH);
    expect(snapshot.integrationId).toBe("github-binding");
    expect(snapshot.providerId).toBe("github");
    expect(assertPolicySnapshotIntegrity(snapshot)).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("changes when a deterministic policy input changes", () => {
    const plan = validPlan();
    const step = plan.steps[0];
    const base = {
      id: "policy-snapshot-test",
      policyVersion: CURRENT_POLICY_VERSION,
      scope: fixtureScope(plan),
      planHash: hashPlan(plan),
      stepHash: hashPlanStep(step),
      capabilityNames: ["repository.inspect"],
      dataClass: "internal" as const,
      allowedEnvironments: ["staging" as const],
      allowedDataClasses: ["internal" as const],
      killSwitches: [],
      credentialRequirementIds: [],
      fallbackRequired: false,
      fallbackAvailable: true,
      idempotencyKey: "policy-snapshot-12345678",
      resourceRequirements: step.resourceRequirements,
      createdAt: fixtureNow.toISOString()
    };

    const first = createPolicySnapshot(base);
    const second = createPolicySnapshot({ ...base, fallbackRequired: true });
    const riskBound = createPolicySnapshot({
      ...base,
      riskContext: {
        publicVisibility: true,
        customerImpact: "customer",
        confidence: 0.9,
        novelty: 0.2,
        previousApprovedPolicy: false
      },
      usageBudgets: [{
        policy: {
          id: "outbound-daily",
          scopeType: "company",
          scopeId: "company-a",
          metric: "outbound-emails",
          period: "daily",
          hardLimit: 500,
          enabled: true
        },
        currentUsage: 100,
        requestedUsage: 10
      }]
    });
    expect(second.snapshotHash).not.toBe(first.snapshotHash);
    expect(second.policyInputHash).not.toBe(first.policyInputHash);
    expect(riskBound.snapshotHash).not.toBe(first.snapshotHash);
    expect(riskBound.policyInputHash).not.toBe(first.policyInputHash);
    expect(Object.isFrozen(riskBound.riskContext)).toBe(true);
    expect(Object.isFrozen(riskBound.usageBudgets)).toBe(true);
  });
});
