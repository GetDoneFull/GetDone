import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type {
  AuthoritativeDecision,
  DecisionAuthorityStore,
  DecisionResumeRequest
} from "@/lib/domain/decision-service";
import { resolveDecision } from "@/lib/domain/decision-service";
import type { DecisionTransaction, DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import type { IdempotencyClaim, IdempotencyRecord, IdempotencyStore } from "@/lib/domain/idempotency";
import { createStepUpProof, type StepUpProof } from "@/lib/authorization/proofs";

class MemoryDecisionTransactionManager implements DecisionTransactionManager {
  private decisionValue: AuthoritativeDecision;
  private auditEvents: AuditEvent[] = [];
  private idempotencyRecords = new Map<string, IdempotencyRecord>();
  private resumeRequests = new Map<string, DecisionResumeRequest>();
  failAudit = false;

  constructor(initialDecision: AuthoritativeDecision) {
    this.decisionValue = { ...initialDecision };
  }

  decision() { return { ...this.decisionValue }; }
  events() { return [...this.auditEvents]; }
  idempotency(key: string) { return this.idempotencyRecords.get(key); }
  resumeRequest(id: string) { return this.resumeRequests.get(id); }

  async run<T>(operation: (transaction: DecisionTransaction) => Promise<T>): Promise<T> {
    let stagedDecision = { ...this.decisionValue };
    const stagedEvents = [...this.auditEvents];
    const stagedIdempotency = new Map(this.idempotencyRecords);
    const stagedResumeRequests = new Map(this.resumeRequests);

    const decisions: DecisionAuthorityStore = {
      get: async (id) => id === stagedDecision.id ? { ...stagedDecision } : null,
      save: async (next, expectedVersion) => {
        if (stagedDecision.version !== expectedVersion) throw new Error("optimistic concurrency conflict");
        stagedDecision = { ...next };
      }
    };

    const audit: AuditLedger = {
      append: async (event) => {
        if (this.failAudit) throw new Error("simulated audit persistence failure");
        stagedEvents.push(event);
      },
      listByCorrelationId: async (correlationId) => stagedEvents.filter((event) => event.correlationId === correlationId)
    };

    const idempotency: IdempotencyStore = {
      async claim<R = unknown>(key: string, fingerprint: string, createdAt: string): Promise<IdempotencyClaim<R>> {
        const existing = stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined;
        if (existing) {
          if (existing.fingerprint !== fingerprint) return { state: "CONFLICT", record: existing };
          return { state: existing.status, record: existing };
        }
        const record: IdempotencyRecord<R> = { key, fingerprint, status: "IN_PROGRESS", createdAt };
        stagedIdempotency.set(key, record as IdempotencyRecord);
        return { state: "CREATED", record };
      },
      async complete<R = unknown>(key: string, fingerprint: string, result: R, completedAt: string) {
        const existing = stagedIdempotency.get(key);
        if (!existing || existing.fingerprint !== fingerprint) throw new Error("idempotency completion conflict");
        const record: IdempotencyRecord<R> = { ...existing, status: "COMPLETED", completedAt, result };
        stagedIdempotency.set(key, record as IdempotencyRecord);
        return record;
      },
      async fail(key: string, fingerprint: string, errorCode: string, failedAt: string) {
        const existing = stagedIdempotency.get(key);
        if (!existing || existing.fingerprint !== fingerprint) throw new Error("idempotency failure conflict");
        const record: IdempotencyRecord = { ...existing, status: "FAILED", failedAt, errorCode };
        stagedIdempotency.set(key, record);
        return record;
      },
      async get<R = unknown>(key: string) {
        return (stagedIdempotency.get(key) as IdempotencyRecord<R> | undefined) ?? null;
      }
    };

    const result = await operation({
      stores: {
        decisions,
        resumeRequests: {
          create: async (request: DecisionResumeRequest) => {
            const existing = stagedResumeRequests.get(request.id);
            if (existing && existing.requestHash !== request.requestHash) {
              throw new Error("resume request conflict");
            }
            stagedResumeRequests.set(request.id, request);
          }
        }
      },
      audit,
      idempotency
    });
    this.decisionValue = stagedDecision;
    this.auditEvents = stagedEvents;
    this.idempotencyRecords = stagedIdempotency;
    this.resumeRequests = stagedResumeRequests;
    return result;
  }
}

function decision(overrides: Partial<AuthoritativeDecision> = {}): AuthoritativeDecision {
  return {
    id: "decision-1",
    portfolioId: "portfolio-a",
    companyId: "company-a",
    status: "pending",
    version: 1,
    requiresStepUp: false,
    updatedAt: "2026-09-20T16:00:00Z",
    ...overrides
  };
}

function command(companyId = "company-a", action: "approve" | "modify" | "reject" = "approve") {
  return createCommandEnvelope({
    commandId: `decision-command-${companyId}-${action}`,
    actor: { type: "user", id: "user-a" },
    scope: {
      userId: "user-a",
      portfolioId: "portfolio-a",
      companyId,
      environment: "development"
    },
    correlationId: "decision-correlation-1",
    environment: "development",
    idempotencyKey: `decision-action-${companyId}-${action}`,
    provenance: "owner-ui",
    requestedMutation: {
      type: "decision.resolve" as const,
      decisionId: "decision-1",
      action
    }
  });
}

function stepUp(): StepUpProof {
  return createStepUpProof({
    id: "decision-stepup-1",
    actorId: "user-a",
    scope: command().scope,
    method: "passkey",
    authenticatedAt: "2026-09-20T17:59:00Z",
    expiresAt: "2099-01-01T00:00:00Z"
  });
}

function input(transactionManager: DecisionTransactionManager, overrides: Partial<Parameters<typeof resolveDecision>[0]> = {}) {
  return {
    command: command(),
    transactionManager,
    decisionId: "decision-1",
    action: "approve" as const,
    ...overrides
  };
}

describe("decision authority service", () => {
  it("commits decision, audit, and idempotency together", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());
    const result = await resolveDecision(input(transactionManager));

    expect(result.status).toBe("approved");
    expect(transactionManager.decision().version).toBe(2);
    expect(transactionManager.events()).toHaveLength(1);
    expect(transactionManager.idempotency("decision-action-company-a-approve")?.status).toBe("COMPLETED");
  });

  it("does not duplicate a transition on an idempotent retry", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());
    const request = input(transactionManager);

    const first = await resolveDecision(request);
    const retry = await resolveDecision(request);

    expect(retry).toEqual(first);
    expect(transactionManager.events()).toHaveLength(1);
  });

  it("rolls back state and idempotency if audit persistence fails", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());
    transactionManager.failAudit = true;

    await expect(resolveDecision(input(transactionManager))).rejects.toThrow("simulated audit persistence failure");

    expect(transactionManager.decision().status).toBe("pending");
    expect(transactionManager.events()).toHaveLength(0);
    expect(transactionManager.idempotency("decision-action-company-a-approve")).toBeUndefined();
  });

  it("rejects cross-company decision access", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());

    await expect(resolveDecision(input(transactionManager, {
      command: command("company-b", "reject"),
      action: "reject"
    }))).rejects.toThrow();

    expect(transactionManager.decision().status).toBe("pending");
  });

  it("requires a fresh step-up proof for a strong approval", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision({ requiresStepUp: true }));

    await expect(resolveDecision(input(transactionManager))).rejects.toThrow();
    expect((await resolveDecision(input(transactionManager, {
      command: createCommandEnvelope({
        ...command(),
        commandId: "decision-command-stepup",
        idempotencyKey: "decision-action-stepup-approve"
      }),
      stepUpProof: stepUp()
    }))).status).toBe("approved");
  });

  it("creates an exact-hash approval proof and durable resume request for an orchestrated Decision", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision({
      correlationId: "orchestration-correlation",
      approvalBinding: {
        trustedScope: command().scope,
        orchestrationRunId: "orchestration-run-1",
        policyEvaluationArtifactId: "policy-evaluation-1",
        policyEvaluationArtifactHash: "a".repeat(64),
        planArtifactId: "plan-artifact-1",
        planArtifactHash: "b".repeat(64),
        planHash: "c".repeat(64),
        stepId: "step-1",
        stepHash: "d".repeat(64),
        policySnapshotId: "policy-snapshot-1",
        policySnapshotHash: "e".repeat(64),
        validationReceiptId: "validation-receipt-1",
        validationReceiptHash: "f".repeat(64),
        requirement: "approval",
        proofExpiresAt: "2099-01-01T00:00:00Z"
      }
    }));

    const result = await resolveDecision(input(transactionManager, {
      now: () => new Date("2026-09-28T13:00:00Z")
    }));

    expect(result.status).toBe("approved");
    expect(result.approvalProof).toMatchObject({
      decisionId: "decision-1",
      approvalId: "approval:decision-1",
      planHash: "c".repeat(64),
      stepHash: "d".repeat(64),
      level: "approval",
      actorId: "user-a"
    });
    expect(result.approvalProof?.proofHash).toHaveLength(64);

    const resume = transactionManager.resumeRequest("decision-resume:decision-1:v2");
    expect(resume).toMatchObject({
      runId: "orchestration-run-1",
      decisionId: "decision-1",
      decisionVersion: 2,
      resolution: "approved"
    });
    expect(resume?.requestHash).toHaveLength(64);
  });

  it("binds strong orchestration approval to fresh step-up proof and emits one resume request", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision({
      requiresStepUp: true,
      correlationId: "orchestration-correlation",
      approvalBinding: {
        trustedScope: command().scope,
        orchestrationRunId: "orchestration-run-strong",
        policyEvaluationArtifactId: "policy-evaluation-strong",
        policyEvaluationArtifactHash: "1".repeat(64),
        planArtifactId: "plan-artifact-strong",
        planArtifactHash: "2".repeat(64),
        planHash: "3".repeat(64),
        stepId: "step-strong",
        stepHash: "4".repeat(64),
        policySnapshotId: "policy-snapshot-strong",
        policySnapshotHash: "5".repeat(64),
        validationReceiptId: "validation-receipt-strong",
        validationReceiptHash: "6".repeat(64),
        requirement: "strong-approval",
        proofExpiresAt: "2099-01-01T00:00:00Z"
      }
    }));

    await expect(resolveDecision(input(transactionManager, {
      now: () => new Date("2026-09-28T13:00:00Z")
    }))).rejects.toThrow(/step-up/i);

    const freshStepUp = createStepUpProof({
      id: "strong-orchestration-stepup",
      actorId: "user-a",
      scope: command().scope,
      method: "passkey",
      authenticatedAt: "2026-09-28T12:59:00Z",
      expiresAt: "2026-09-28T13:05:00Z"
    });
    const approved = await resolveDecision(input(transactionManager, {
      command: createCommandEnvelope({
        ...command(),
        commandId: "decision-command-strong-orchestration",
        idempotencyKey: "decision-action-strong-orchestration"
      }),
      stepUpProof: freshStepUp,
      now: () => new Date("2026-09-28T13:00:00Z")
    }));

    expect(approved.approvalProof?.level).toBe("strong-approval");
    expect(approved.approvalProof?.stepUpProofId).toBe(freshStepUp.id);
    expect(approved.stepUpProof?.proofHash).toBe(freshStepUp.proofHash);
    expect(transactionManager.resumeRequest("decision-resume:decision-1:v2")?.resolution)
      .toBe("approved");
  });

  it("emits a resume request for rejection without creating approval authority", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision({
      correlationId: "orchestration-correlation",
      approvalBinding: {
        trustedScope: command().scope,
        orchestrationRunId: "orchestration-run-reject",
        policyEvaluationArtifactId: "policy-evaluation-reject",
        policyEvaluationArtifactHash: "a".repeat(64),
        planArtifactId: "plan-artifact-reject",
        planArtifactHash: "b".repeat(64),
        planHash: "c".repeat(64),
        stepId: "step-reject",
        stepHash: "d".repeat(64),
        policySnapshotId: "policy-snapshot-reject",
        policySnapshotHash: "e".repeat(64),
        validationReceiptId: "validation-receipt-reject",
        validationReceiptHash: "f".repeat(64),
        requirement: "approval",
        proofExpiresAt: "2099-01-01T00:00:00Z"
      }
    }));

    const result = await resolveDecision(input(transactionManager, {
      command: command("company-a", "reject"),
      action: "reject",
      now: () => new Date("2026-09-28T13:00:00Z")
    }));

    expect(result.status).toBe("rejected");
    expect(result.approvalProof).toBeUndefined();
    expect(transactionManager.resumeRequest("decision-resume:decision-1:v2")?.resolution)
      .toBe("rejected");
  });

  it("rejects a command whose embedded mutation does not match the requested action", async () => {
    const transactionManager = new MemoryDecisionTransactionManager(decision());
    await expect(resolveDecision(input(transactionManager, {
      command: command("company-a", "reject"),
      action: "approve"
    }))).rejects.toThrow();
  });
});
