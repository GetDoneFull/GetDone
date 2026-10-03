import { describe, expect, it } from "vitest";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import type { AuditEvent, AuditLedger } from "@/lib/domain/audit";
import type { ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import { MemoryIdempotencyStore } from "@/lib/domain/idempotency";
import type { EntityStore } from "@/lib/domain/services/common";
import {
  JobService,
  type JobRecord,
  type JobStore,
  type JobStores
} from "@/lib/domain/services/job-service";
import {
  createVerificationContract,
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest,
  type VerificationReceipt,
  type VerificationReceiptStore
} from "@/lib/verification/verification";

const now = new Date("2026-09-20T19:31:00Z");
const scope = {
  userId: "owner-a",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "staging" as const
};

class MemoryAudit implements AuditLedger {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent) { this.events.push(event); }
  async listByCorrelationId(correlationId: string) {
    return this.events.filter((event) => event.correlationId === correlationId);
  }
}

class MemoryJobStore implements JobStore {
  constructor(public value: JobRecord) {}
  async get(id: string) { return id === this.value.id ? { ...this.value } : null; }
  async save(next: JobRecord, expectedVersion: number) {
    if (this.value.version !== expectedVersion) throw new Error("version conflict");
    this.value = { ...next };
  }
}

class MemoryReceiptStore implements VerificationReceiptStore {
  constructor(private readonly receipts: readonly VerificationReceipt[]) {}
  async getReceipt(id: string) {
    return this.receipts.find((receipt) => receipt.id === id) ?? null;
  }
}

function manager(
  jobs: EntityStore<JobRecord>,
  receipts: readonly VerificationReceipt[],
  audit = new MemoryAudit()
): ControlPlaneTransactionManager<JobStores> {
  const idempotency = new MemoryIdempotencyStore();
  return {
    run: async (operation) => operation({
      stores: {
        jobs: jobs as JobStore,
        verificationReceipts: new MemoryReceiptStore(receipts)
      },
      audit,
      idempotency
    })
  };
}

let commandCounter = 0;
function command(type: string) {
  commandCounter += 1;
  return createCommandEnvelope({
    commandId: `tranche-c-command-${commandCounter}`,
    actor: { type: "system", id: "control-plane" },
    scope,
    correlationId: "tranche-c-job-loop",
    environment: scope.environment,
    idempotencyKey: `tranche-c-idempotency-${commandCounter}`,
    provenance: "core-tranche-c-test",
    requestedMutation: { type }
  });
}

function receipt(verdict: "verified" | "failed") {
  const contract = createVerificationContract({
    id: `job-contract-${verdict}`,
    checks: [{
      id: "sha",
      key: "deployment.sha",
      operator: "equals",
      expected: "abc123",
      required: true
    }]
  });
  const request = createVerificationRequest({
    id: `request-${verdict}`,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    environment: scope.environment,
    subject: { type: "job", id: "job-1" },
    strategies: ["system"],
    requiresIndependentEvidence: true,
    executionIndependenceKey: "provider:deploy-1",
    contract,
    maxEvidenceAgeSeconds: 600,
    requestedAt: "2026-09-20T19:30:00Z",
    expiresAt: "2026-09-20T19:40:00Z"
  });
  const evidence = createVerificationEvidence({
    id: `evidence-${verdict}`,
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    subject: request.subject,
    strategy: "system",
    result: "pass",
    sourceType: "system-probe",
    sourceId: "deployment-verifier",
    independenceKey: "verifier:deployment",
    observedAt: now.toISOString(),
    payloadHash: `payload-${verdict}`,
    provenance: "core-tranche-c-test",
    observations: {
      "deployment.sha": verdict === "verified" ? "abc123" : "deadbeef"
    }
  });
  return resolveVerificationRequest(request, [evidence], {
    receiptId: `receipt-${verdict}`,
    verifiedAt: now.toISOString(),
    receiptTtlSeconds: 300
  });
}

function executingJob(): JobRecord {
  return {
    id: "job-1",
    correlationId: "tranche-c-job-loop",
    portfolioId: scope.portfolioId,
    companyId: scope.companyId,
    state: "executing",
    taskId: "task-1",
    workerId: "worker-1",
    attempt: 1,
    maxAttempts: 3,
    verificationEvidenceIds: [],
    version: 4,
    updatedAt: "2026-09-20T19:30:30Z"
  };
}

describe("Core Tranche C authoritative Job lifecycle", () => {
  it("does not allow provider completion to become Job success before verification", async () => {
    const verifiedReceipt = receipt("verified");
    const audit = new MemoryAudit();
    const store = new MemoryJobStore(executingJob());
    const service = new JobService(manager(store, [verifiedReceipt], audit), () => now);

    const providerCompleted = await service.recordProviderCompletion(
      "job-1",
      command("job.provider-completed"),
      {
        providerResultId: "provider-result-1",
        providerResultHash: "provider-result-hash",
        completedAt: now.toISOString()
      }
    );
    expect(providerCompleted.state).toBe("provider_completed");

    await expect(
      service.verify("job-1", command("job.illegal-direct-verify"), verifiedReceipt.id)
    ).rejects.toThrow(/invalid job transition/i);

    const verifying = await service.beginVerification(
      "job-1",
      command("job.begin-verification")
    );
    expect(verifying.state).toBe("verifying");

    const verified = await service.verify(
      "job-1",
      command("job.verify"),
      verifiedReceipt.id
    );
    expect(verified.state).toBe("verified");
    expect(verified.verificationReceiptHash).toBe(verifiedReceipt.receiptHash);
    expect(audit.events.map((event) => event.eventType)).toEqual([
      "job.provider_completed",
      "job.verifying",
      "job.verified"
    ]);
  });

  it("requires a failed verification receipt before verification can fail authoritatively", async () => {
    const failedReceipt = receipt("failed");
    const store = new MemoryJobStore({
      ...executingJob(),
      state: "verifying",
      providerResultId: "provider-result-1",
      providerResultHash: "provider-result-hash",
      providerCompletedAt: now.toISOString()
    });
    const service = new JobService(manager(store, [failedReceipt]), () => now);

    await expect(
      service.fail("job-1", command("job.unverified-failure"), "health failed")
    ).rejects.toThrow(/verification failure must be backed/i);

    const failed = await service.failVerification(
      "job-1",
      command("job.verification-failed"),
      failedReceipt.id,
      "Expected deployment SHA was not present"
    );
    expect(failed.state).toBe("failed");
    expect(failed.verificationReceiptHash).toBe(failedReceipt.receiptHash);
  });
});
