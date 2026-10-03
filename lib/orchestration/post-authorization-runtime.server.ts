import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  JobService,
  type JobRecord,
  type JobStores
} from "@/lib/domain/services/job-service";
import { createAuditEvent } from "@/lib/domain/audit";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import { getDurableJobEngineFromEnv } from "@/lib/execution/durable-job-engine.server";
import { getMvpJobRuntimeFromEnv } from "@/lib/execution/mvp-job-runtime.server";
import type {
  DurableJobGraphArtifact,
  DurableTaskDagArtifact,
  GovernedJobRuntimePort,
  OrchestrationJobNode
} from "@/lib/orchestration/post-authorization-flow";
import {
  createJobGraphArtifact
} from "@/lib/orchestration/post-authorization-flow";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";
import {
  PostgresAuditLedger,
  PostgresEntityStore,
  PostgresVerificationReceiptStore
} from "@/lib/persistence/postgres/authority-stores";
import {
  PostgresControlPlaneTransactionManager
} from "@/lib/persistence/postgres/transaction-manager";
import type {
  PostgresTransactionalDatabase
} from "@/lib/persistence/postgres/client";
import {
  PostgresOrchestrationJobGraphStore
} from "@/lib/persistence/postgres/orchestration-execution-stores";
import {
  PostgresJobVerificationEvidenceStore
} from "@/lib/persistence/postgres/worker-runtime-stores";
import {
  createVerificationRequest,
  resolveVerificationRequest,
  type VerificationEvidence
} from "@/lib/verification/verification";

export const POSTGRES_GOVERNED_JOB_RUNTIME_VERSION = "1.0.0";

export interface OrchestrationCredentialLeaseResolver {
  resolve(input: {
    run: OrchestrationRunRecord;
    task: DurableTaskDagArtifact["tasks"][number];
    jobId: string;
    capability: string;
  }): Promise<string | undefined>;
}

function jobId(nodeId: string) {
  return `job:${nodeId}`;
}

function actionId(job: string) {
  return `action:${job}`;
}

function requestId(job: string) {
  return `verification:${job}`;
}

function receiptId(job: string) {
  return `verification-receipt:${job}`;
}

function requiredVerificationSatisfied(
  task: DurableTaskDagArtifact["tasks"][number],
  evidence: readonly VerificationEvidence[]
) {
  const passing = evidence.filter((item) => item.result === "pass");
  for (const requirement of task.verificationRequirements) {
    if (!requirement.required) continue;
    switch (requirement.kind) {
      case "capability-output":
      case "metric":
      case "state":
        if (passing.length === 0) {
          return {
            satisfied: false as const,
            reason: `Required ${requirement.kind} verification has no passing evidence`
          };
        }
        break;
      case "independent-check": {
        const executionKeys = new Set(
          evidence
            .filter((item) => item.sourceType === "provider" || item.sourceType === "worker")
            .map((item) => item.independenceKey)
        );
        const independent = passing.some(
          (item) =>
            item.sourceType !== "provider"
            && [...executionKeys].every((key) => item.independenceKey !== key)
        );
        if (!independent) {
          return {
            satisfied: false as const,
            reason: "Required independent-check verification has no independent passing evidence"
          };
        }
        break;
      }
    }
  }
  return { satisfied: true as const };
}

function nodeHash(input: Omit<OrchestrationJobNode, "nodeHash">) {
  return sha256Hex(input);
}

function dependencyJobIds(
  taskDag: DurableTaskDagArtifact,
  dependencyNodeIds: readonly string[]
) {
  const byId = new Map(taskDag.dag.nodes.map((node) => [node.id, node]));
  const resolved = new Set<string>();
  const visit = (nodeId: string, seen = new Set<string>()) => {
    if (seen.has(nodeId)) {
      throw new ControlPlaneError("FORBIDDEN", "Task DAG dependency cycle reached Job materialization");
    }
    const node = byId.get(nodeId);
    if (!node) {
      throw new ControlPlaneError("FORBIDDEN", `Task DAG dependency node is missing: ${nodeId}`);
    }
    if (node.kind === "capability") {
      resolved.add(jobId(node.id));
      return;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(nodeId);
    for (const upstream of node.dependsOn) visit(upstream, nextSeen);
  };
  for (const dependency of dependencyNodeIds) visit(dependency);
  return [...resolved].sort();
}

export class PostgresGovernedJobRuntime implements GovernedJobRuntimePort {
  readonly descriptor = Object.freeze({
    providerCalls: "job-worker-only" as const,
    authoritativeState: "postgresql" as const,
    requiresAuthorizationConsumption: true as const,
    verifiesBeforeSuccess: true as const
  });

  private readonly graphs: PostgresOrchestrationJobGraphStore;
  private readonly evidence: PostgresJobVerificationEvidenceStore;
  private readonly receipts: PostgresVerificationReceiptStore;
  private readonly jobLifecycle: JobService;

  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly now: () => Date = () => new Date(),
    private readonly credentialLeases?: OrchestrationCredentialLeaseResolver
  ) {
    this.graphs = new PostgresOrchestrationJobGraphStore(db);
    this.evidence = new PostgresJobVerificationEvidenceStore(db);
    this.receipts = new PostgresVerificationReceiptStore(db);
    this.jobLifecycle = new JobService(
      new PostgresControlPlaneTransactionManager<JobStores>(
        db,
        (client) => ({
          jobs: new PostgresEntityStore<JobRecord>(client, "job"),
          verificationReceipts: new PostgresVerificationReceiptStore(client)
        })
      ),
      now
    );
  }

  async materializeAndEnqueue(input: {
    run: OrchestrationRunRecord;
    taskDag: DurableTaskDagArtifact;
    idempotencyKey: string;
  }): Promise<DurableJobGraphArtifact> {
    const existing = await this.graphs.getByRunId(input.run.id);
    if (existing) {
      await this.enqueueReady(input.run, input.taskDag, existing);
      return (await this.graphs.getByRunId(input.run.id)) ?? existing;
    }

    const taskById = new Map(input.taskDag.tasks.map((task) => [task.id, task]));
    const createdAt = this.now().toISOString();
    const jobs = input.taskDag.dag.nodes
      .filter((node) => node.kind === "capability" && node.runCondition === "normal")
      .map((node) => {
        if (!node.capability) {
          throw new ControlPlaneError("FORBIDDEN", "Capability DAG node lost its capability binding");
        }
        const task = taskById.get(node.taskId);
        if (!task) {
          throw new ControlPlaneError("FORBIDDEN", "Capability DAG node references a missing Task");
        }
        const base: Omit<OrchestrationJobNode, "nodeHash"> = {
          id: jobId(node.id),
          runId: input.run.id,
          nodeId: node.id,
          taskId: task.id,
          capability: node.capability,
          capabilityInput: node.capabilityInput,
          dependsOnJobIds: dependencyJobIds(input.taskDag, node.dependsOn),
          authorizationGrantId: task.authorizationGrantId,
          authorizationGrantHash: task.authorizationGrantHash,
          authorizationConsumptionHash: task.authorizationConsumption.consumptionHash,
          state: "created",
          createdAt,
          updatedAt: createdAt
        };
        return Object.freeze({ ...base, nodeHash: nodeHash(base) });
      });

    if (jobs.length === 0) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Authorized Task DAG contains no executable capability Jobs");
    }

    const candidate = createJobGraphArtifact({
      run: input.run,
      taskDag: input.taskDag,
      jobs,
      createdAt
    });
    const persisted = await this.graphs.create(candidate, input.idempotencyKey);
    await this.enqueueReady(input.run, input.taskDag, persisted.artifact);
    return (await this.graphs.getByRunId(input.run.id)) ?? persisted.artifact;
  }

  private async enqueueReady(
    run: OrchestrationRunRecord,
    taskDag: DurableTaskDagArtifact,
    graph: DurableJobGraphArtifact
  ) {
    const nodes = await this.graphs.listNodes(run.id);
    const verified = new Set(
      nodes.filter((node) => node.state === "verified").map((node) => node.id)
    );
    for (const node of nodes) {
      if (
        node.state !== "created"
        || !node.dependsOnJobIds.every((dependency) => verified.has(dependency))
      ) continue;
      await this.enqueueNode(run, taskDag, node);
    }
  }

  private async ensureQueuedJobEntity(
    run: OrchestrationRunRecord,
    taskDag: DurableTaskDagArtifact,
    node: OrchestrationJobNode
  ) {
    const task = taskDag.tasks.find((candidate) => candidate.id === node.taskId);
    if (!task) throw new ControlPlaneError("FORBIDDEN", "Job node parent Task was not found");
    if (
      task.authorizationGrantId !== node.authorizationGrantId
      || task.authorizationGrantHash !== node.authorizationGrantHash
      || task.authorizationConsumption.consumptionHash
        !== node.authorizationConsumptionHash
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Job node authorization differs from authoritative Task");
    }

    const existing = await this.db.query<{ payload: JobRecord }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type='job' AND id=$1`,
      [node.id]
    );
    if (existing.rows[0]) {
      const prior = existing.rows[0].payload;
      if (
        prior.state === "queued"
        && prior.taskId === node.taskId
        && prior.authorizationGrantId === node.authorizationGrantId
        && prior.authorizationGrantHash === node.authorizationGrantHash
        && prior.authorizationConsumption?.consumptionHash
          === node.authorizationConsumptionHash
      ) return prior;
      if (
        (prior.state === "verified" || prior.state === "succeeded")
        && prior.taskId === node.taskId
      ) return prior;
      throw new ControlPlaneError(
        "IDEMPOTENCY_CONFLICT",
        "Persisted Job identity already exists with different orchestration lineage"
      );
    }

    const record: JobRecord = Object.freeze({
      id: node.id,
      correlationId: run.correlationId,
      portfolioId: run.scope.portfolioId,
      companyId: run.scope.companyId,
      state: "queued",
      taskId: node.taskId,
      attempt: 0,
      maxAttempts: 5,
      authorizationGrantId: node.authorizationGrantId,
      authorizationGrantHash: node.authorizationGrantHash,
      authorizationConsumption: task.authorizationConsumption,
      verificationEvidenceIds: Object.freeze([]),
      version: 1,
      updatedAt: this.now().toISOString()
    });

    await this.db.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO control_plane_entities(
          entity_type,id,portfolio_id,company_id,version,updated_at,payload
        ) VALUES('job',$1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (entity_type,id) DO NOTHING`,
        [
          record.id,
          record.portfolioId,
          record.companyId,
          record.version,
          record.updatedAt,
          JSON.stringify(record)
        ]
      );
      if (inserted.rowCount !== 1) {
        throw new ControlPlaneError("CONFLICT", "Job was concurrently materialized");
      }
      await new PostgresAuditLedger(client).append(createAuditEvent({
        correlationId: run.correlationId,
        eventType: "job.orchestration-enqueued",
        actor: { type: "system", id: "getdone-orchestration" },
        scope: {
          userId: run.scope.userId,
          portfolioId: run.scope.portfolioId,
          companyId: run.scope.companyId
        },
        environment: run.scope.environment,
        entityType: "job",
        entityId: record.id,
        newState: "queued",
        provenance: "orchestration:authorized-task-dag",
        metadata: {
          runId: run.id,
          taskId: node.taskId,
          capability: node.capability,
          authorizationConsumptionHash: node.authorizationConsumptionHash
        }
      }));
    });
    return record;
  }

  private async enqueueNode(
    run: OrchestrationRunRecord,
    taskDag: DurableTaskDagArtifact,
    node: OrchestrationJobNode
  ) {
    const record = await this.ensureQueuedJobEntity(run, taskDag, node);
    if (record.state === "verified" || record.state === "succeeded") {
      await this.graphs.updateNode({
        expectedState: node.state,
        job: {
          ...node,
          state: "verified",
          updatedAt: this.now().toISOString()
        }
      });
      return;
    }

    const task = taskDag.tasks.find((candidate) => candidate.id === node.taskId)!;
    const expectedDuration = task.resourceRequirements.execution.expectedDurationSeconds;
    const timeoutMs = Math.max(
      1_000,
      Math.min(30 * 60_000, (expectedDuration ?? 30) * 1_000)
    );
    const credentialLeaseId = await this.credentialLeases?.resolve({
      run,
      task,
      jobId: node.id,
      capability: node.capability
    });
    if (
      task.resourceRequirements.credentialBindingRequired
      && !credentialLeaseId
    ) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "Credential-bearing Job dispatch requires an authoritative scoped credential lease"
      );
    }
    const request: AuthorizedBusinessActionRequest = Object.freeze({
      id: actionId(node.id),
      correlationId: run.correlationId,
      jobId: node.id,
      scope: task.scope,
      capability: node.capability,
      input: node.capabilityInput,
      inputHash: sha256Hex(node.capabilityInput),
      authorizationConsumptionHash: node.authorizationConsumptionHash,
      credentialLeaseId,
      idempotencyKey: `orchestration:${run.id}:${node.id}:dispatch`,
      timeoutMs,
      attempt: 1
    });

    await getMvpJobRuntimeFromEnv(this.env).enqueueAuthorizedBusinessAction(
      record,
      request
    );
    await this.graphs.updateNode({
      expectedState: "created",
      job: {
        ...node,
        state: "enqueued",
        updatedAt: this.now().toISOString()
      }
    });
  }

  async reconcile(input: {
    run: OrchestrationRunRecord;
    taskDag: DurableTaskDagArtifact;
    jobGraph: DurableJobGraphArtifact;
    idempotencyKey: string;
  }) {
    if (!input.idempotencyKey.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Execution reconciliation idempotency key is required");
    }

    const engine = getDurableJobEngineFromEnv(this.env);
    const allEvidence: VerificationEvidence[] = [];
    let pendingReason = "Waiting for governed Job worker completion";

    for (const node of await this.graphs.listNodes(input.run.id)) {
      if (node.state === "verified") {
        allEvidence.push(...await this.evidence.listByJobId(node.id));
        continue;
      }
      if (node.state === "failed" || node.state === "cancelled") {
        return {
          kind: "failed" as const,
          code: "JOB_TERMINAL_FAILURE",
          reason: `Job ${node.id} is ${node.state}`
        };
      }
      if (node.state === "created") continue;

      const status = await engine.status(node.id);
      const terminal = status.outcomes.at(-1);
      if (!terminal) continue;
      if (terminal.kind === "dead-lettered" || terminal.kind === "cancelled") {
        await this.graphs.updateNode({
          expectedState: node.state,
          job: {
            ...node,
            state: terminal.kind === "cancelled" ? "cancelled" : "failed",
            updatedAt: this.now().toISOString()
          }
        });
        return {
          kind: "failed" as const,
          code: "JOB_TERMINAL_FAILURE",
          reason: terminal.reason ?? `Durable Job ended as ${terminal.kind}`
        };
      }
      if (
        terminal.kind !== "provider-completed"
        && terminal.kind !== "verified"
        && terminal.kind !== "succeeded"
      ) continue;

      const observed = await this.evidence.listByJobId(node.id);
      allEvidence.push(...observed);
      if (observed.length === 0) {
        pendingReason = `Job ${node.id} completed but Verification evidence is not persisted`;
        continue;
      }

      const task = input.taskDag.tasks.find((candidate) => candidate.id === node.taskId);
      if (!task) throw new ControlPlaneError("FORBIDDEN", "Verified Job lost parent Task lineage");
      const requirementCheck = requiredVerificationSatisfied(task, observed);
      if (!requirementCheck.satisfied) {
        pendingReason = `Job ${node.id}: ${requirementCheck.reason}`;
        continue;
      }
      const verificationRequestId = requestId(node.id);
      const requestedAt = this.now().toISOString();
      const expiresAt = new Date(Date.parse(requestedAt) + 15 * 60_000).toISOString();
      const independent = task.verificationRequirements.some(
        (requirement) => requirement.required && requirement.kind === "independent-check"
      );
      const strategies = [...new Set(observed.map((evidence) => evidence.strategy))];
      const request = createVerificationRequest({
        id: verificationRequestId,
        correlationId: input.run.correlationId,
        portfolioId: input.run.scope.portfolioId,
        companyId: input.run.scope.companyId,
        environment: input.run.scope.environment,
        subject: { type: "job", id: node.id },
        strategies,
        requiresIndependentEvidence: independent,
        executionIndependenceKey: independent ? observed[0]?.independenceKey : undefined,
        maxEvidenceAgeSeconds: 15 * 60,
        requestedAt,
        expiresAt
      });
      const receipt = resolveVerificationRequest(request, observed, {
        receiptId: receiptId(node.id),
        verifiedAt: requestedAt,
        receiptTtlSeconds: 15 * 60
      });
      if (receipt.verdict === "failed") {
        await this.markVerifiedProjection(input.run, node, receipt, "failed");
        return {
          kind: "failed" as const,
          code: "VERIFICATION_FAILED",
          reason: `Verification failed for Job ${node.id}`
        };
      }
      if (receipt.verdict !== "verified") {
        pendingReason = independent
          ? `Job ${node.id} requires independent Verification evidence`
          : `Job ${node.id} has not produced sufficient Verification evidence`;
        continue;
      }

      await this.markVerifiedProjection(input.run, node, receipt, "verified");
    }

    const refreshed = (await this.graphs.getByRunId(input.run.id));
    if (!refreshed) throw new ControlPlaneError("NOT_FOUND", "Job graph disappeared during reconciliation");
    await this.enqueueReady(input.run, input.taskDag, refreshed);

    const finalGraph = await this.graphs.getByRunId(input.run.id);
    if (!finalGraph) throw new ControlPlaneError("NOT_FOUND", "Job graph disappeared after enqueue");
    const nodes = await this.graphs.listNodes(input.run.id);
    if (!nodes.every((node) => node.state === "verified")) {
      return { kind: "pending" as const, reason: pendingReason, delayMs: 2_000 };
    }

    const verificationRequestIds = nodes
      .map((node) => node.verificationRequestId)
      .filter((value): value is string => Boolean(value));
    const evidence = (
      await Promise.all(nodes.map((node) => this.evidence.listByJobId(node.id)))
    ).flat();
    return {
      kind: "verified" as const,
      jobGraph: finalGraph,
      verificationRequestIds: Object.freeze(verificationRequestIds),
      evidence: Object.freeze(evidence)
    };
  }

  private verificationLifecycleCommand(
    run: OrchestrationRunRecord,
    node: OrchestrationJobNode,
    operation: "begin-verification" | "verify" | "fail-verification",
    receiptId: string
  ) {
    const key = `orchestration:${run.id}:${node.id}:${operation}:${receiptId}`;
    return createCommandEnvelope({
      commandId: key,
      actor: { type: "system", id: "getdone-verifier" },
      scope: run.scope,
      correlationId: run.correlationId,
      environment: run.scope.environment,
      idempotencyKey: key,
      provenance: "orchestration:provider-result-verification",
      requestedMutation: {
        operation,
        runId: run.id,
        jobId: node.id,
        verificationReceiptId: receiptId
      }
    });
  }

  private async markVerifiedProjection(
    run: OrchestrationRunRecord,
    node: OrchestrationJobNode,
    receipt: ReturnType<typeof resolveVerificationRequest>,
    state: "verified" | "failed"
  ) {
    await this.receipts.insert(receipt);

    const jobs = new PostgresEntityStore<JobRecord>(this.db, "job");
    let current = await jobs.get(node.id);
    if (!current) {
      throw new ControlPlaneError(
        "NOT_FOUND",
        "Authoritative Job projection was not found"
      );
    }

    const targetAlreadyReached = state === "verified"
      ? current.state === "verified" || current.state === "succeeded"
      : current.state === "failed";

    if (!targetAlreadyReached) {
      if (current.state === "provider_completed") {
        current = await this.jobLifecycle.beginVerification(
          node.id,
          this.verificationLifecycleCommand(
            run,
            node,
            "begin-verification",
            receipt.id
          )
        );
      }

      if (current.state !== "verifying") {
        throw new ControlPlaneError(
          "CONFLICT",
          `Verification handoff expected provider_completed or verifying Job state, received ${current.state}`
        );
      }

      if (state === "verified") {
        current = await this.jobLifecycle.verify(
          node.id,
          this.verificationLifecycleCommand(run, node, "verify", receipt.id),
          receipt.id
        );
      } else {
        current = await this.jobLifecycle.failVerification(
          node.id,
          this.verificationLifecycleCommand(
            run,
            node,
            "fail-verification",
            receipt.id
          ),
          receipt.id,
          "Authoritative verification evidence did not establish the requested Job outcome"
        );
      }
    }

    if (
      (state === "verified"
        && current.state !== "verified"
        && current.state !== "succeeded")
      || (state === "failed" && current.state !== "failed")
    ) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Authoritative Job lifecycle did not reach the verification terminal state"
      );
    }

    await this.graphs.updateNode({
      expectedState: node.state,
      job: {
        ...node,
        state,
        verificationRequestId: receipt.requestId,
        verificationReceiptId: receipt.id,
        verificationReceiptHash: receipt.receiptHash,
        updatedAt: this.now().toISOString()
      }
    });
  }
}

let installed: PostgresGovernedJobRuntime | null = null;

export function getPostgresGovernedJobRuntimeFromEnv(
  db: PostgresTransactionalDatabase,
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  if (!installed) installed = new PostgresGovernedJobRuntime(db, env);
  return installed;
}

export function resetPostgresGovernedJobRuntimeForTests() {
  installed = null;
}
