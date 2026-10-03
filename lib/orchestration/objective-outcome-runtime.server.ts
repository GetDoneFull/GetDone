import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createAuditEvent } from "@/lib/domain/audit";
import type { OutcomeRecord } from "@/lib/domain/services/outcome-service";
import type {
  DurableJobGraphArtifact,
  DurableTaskDagArtifact,
  ObjectiveEvaluationArtifact,
  ObjectiveOutcomePort,
  VerifiedOrchestrationOutcome
} from "@/lib/orchestration/post-authorization-flow";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";
import type { PersistedPlanProposal } from "@/lib/orchestration/planning-flow";
import {
  PostgresAuditLedger,
  PostgresVerificationReceiptStore
} from "@/lib/persistence/postgres/authority-stores";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";
import {
  createVerificationEvidence,
  createVerificationRequest,
  resolveVerificationRequest,
  type VerificationEvidence
} from "@/lib/verification/verification";

export const POSTGRES_OBJECTIVE_OUTCOME_PORT_VERSION = "1.0.0";

type Observable = number | string | boolean;

function comparable(value: unknown): value is Observable {
  return typeof value === "number"
    ? Number.isFinite(value)
    : typeof value === "string" || typeof value === "boolean";
}

function sameTarget(observed: Observable, target: number | string) {
  if (typeof target === "number") return typeof observed === "number" && observed === target;
  return String(observed) === target;
}

function reservedMetric(
  metric: string,
  taskDag: DurableTaskDagArtifact,
  jobGraph: DurableJobGraphArtifact
): Observable | undefined {
  switch (metric) {
    case "verified-jobs-completed":
    case "jobs.verified":
    case "execution.verified_jobs":
      return jobGraph.jobs.filter((job) => job.state === "verified").length;
    case "verified-tasks-completed":
    case "tasks.verified":
    case "execution.verified_tasks":
      return new Set(
        jobGraph.jobs
          .filter((job) => job.state === "verified")
          .map((job) => job.taskId)
      ).size;
    case "execution.completed":
      return jobGraph.jobs.every((job) => job.state === "verified") ? "true" : "false";
    case "execution.task_count":
      return taskDag.tasks.length;
    default:
      return undefined;
  }
}

function readMetric(output: unknown, metric: string): Observable | undefined {
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined;
  const object = output as Record<string, unknown>;
  if (comparable(object[metric])) return object[metric];
  const metrics = object.metrics;
  if (metrics && typeof metrics === "object" && !Array.isArray(metrics)) {
    const value = (metrics as Record<string, unknown>)[metric];
    if (comparable(value)) return value;
  }
  return undefined;
}

export class PostgresObjectiveOutcomePort implements ObjectiveOutcomePort {
  readonly descriptor = Object.freeze({
    authoritativeState: "postgresql" as const,
    requiresVerifiedJobEvidence: true as const,
    appendsAudit: true as const
  });

  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async providerOutputs(jobIds: readonly string[]) {
    if (jobIds.length === 0) return [] as unknown[];
    const result = await this.db.query<{ payload: { output?: unknown } }>(
      `SELECT payload
       FROM business_action_executions
       WHERE job_id = ANY($1::text[])
       ORDER BY updated_at,request_id`,
      [jobIds]
    );
    return result.rows
      .map((row) => row.payload.output)
      .filter((value) => value !== undefined);
  }

  async evaluateAndRecord(input: {
    run: OrchestrationRunRecord;
    plan: PersistedPlanProposal;
    taskDag: DurableTaskDagArtifact;
    jobGraph: DurableJobGraphArtifact;
    evidence: readonly VerificationEvidence[];
    idempotencyKey: string;
  }) {
    if (!input.idempotencyKey.trim()) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Outcome idempotency key is required");
    }
    if (
      input.evidence.length === 0
      || input.jobGraph.jobs.some((job) => job.state !== "verified")
    ) {
      return {
        kind: "pending" as const,
        reason: "Objective evaluation waits for verified Job evidence"
      };
    }

    const existing = await this.db.query<{
      evaluation: ObjectiveEvaluationArtifact;
      outcome: VerifiedOrchestrationOutcome;
    }>(
      `SELECT e.payload AS evaluation,o.payload AS outcome
       FROM orchestration_objective_evaluations e
       JOIN orchestration_outcomes o ON o.objective_evaluation_id=e.id
       WHERE e.run_id=$1 AND o.run_id=$1`,
      [input.run.id]
    );
    if (existing.rows[0]) {
      const persisted = existing.rows[0];
      const { evaluationHash, ...evaluationBase } = persisted.evaluation;
      const { outcomeHash, ...outcomeBase } = persisted.outcome;
      if (
        sha256Hex(evaluationBase) !== evaluationHash
        || sha256Hex(outcomeBase) !== outcomeHash
        || persisted.evaluation.runId !== input.run.id
        || persisted.outcome.runId !== input.run.id
        || persisted.outcome.objectiveEvaluationId !== persisted.evaluation.id
        || persisted.outcome.objectiveEvaluationHash !== evaluationHash
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Persisted Objective outcome lineage failed integrity validation"
        );
      }
      return {
        kind: "verified" as const,
        evaluation: persisted.evaluation,
        outcome: persisted.outcome
      };
    }

    const outputs = await this.providerOutputs(
      input.jobGraph.jobs.map((job) => job.id)
    );
    const expected = input.plan.proposal.objective
      ? [{
          metric: input.plan.proposal.objective.metric,
          target: input.plan.proposal.objective.target
        }]
      : input.plan.proposal.expectedOutcomes.map((item) => ({
          metric: item.metric,
          target: item.target
        }));

    const observations = expected.map((item) => {
      let observed = reservedMetric(item.metric, input.taskDag, input.jobGraph);
      if (observed === undefined) {
        for (const output of outputs) {
          observed = readMetric(output, item.metric);
          if (observed !== undefined) break;
        }
      }
      return Object.freeze({
        metric: item.metric,
        target: item.target,
        observed,
        met: observed === undefined ? null : sameTarget(observed, item.target),
        evidenceIds: Object.freeze(input.evidence.map((entry) => entry.id).sort())
      });
    });

    if (observations.some((item) => item.met === null)) {
      return {
        kind: "pending" as const,
        reason:
          "Objective metric is not yet observable from verified provider output; GetDone will not invent completion"
      };
    }

    const status = observations.every((item) => item.met === true)
      ? "met" as const
      : "not-met" as const;
    const evaluatedAt = this.now().toISOString();
    const evaluationBase = {
      id: `objective-evaluation:${input.run.id}`,
      runId: input.run.id,
      planId: input.plan.proposal.id,
      planHash: input.plan.planHash,
      status,
      observations: Object.freeze(observations),
      evaluatedAt
    };
    const evaluation: ObjectiveEvaluationArtifact = Object.freeze({
      ...evaluationBase,
      evaluationHash: sha256Hex(evaluationBase)
    });

    if (status === "not-met") {
      await this.persistEvaluationOnly(input.run, evaluation);
      return {
        kind: "failed" as const,
        code: "OBJECTIVE_NOT_MET",
        reason: "Verified execution completed, but the authoritative objective target was not met"
      };
    }

    const outcomeId = `outcome:${input.run.id}`;
    const aggregatePayloadHash = sha256Hex({
      jobVerificationReceipts: input.jobGraph.jobs.map((job) => ({
        jobId: job.id,
        receiptId: job.verificationReceiptId,
        receiptHash: job.verificationReceiptHash
      })).sort((a, b) => a.jobId.localeCompare(b.jobId)),
      evaluationHash: evaluation.evaluationHash
    });
    const requestedAt = evaluatedAt;
    const expiresAt = new Date(Date.parse(requestedAt) + 15 * 60_000).toISOString();
    const request = createVerificationRequest({
      id: `outcome-verification:${input.run.id}`,
      correlationId: input.run.correlationId,
      portfolioId: input.run.scope.portfolioId,
      companyId: input.run.scope.companyId,
      environment: input.run.scope.environment,
      subject: { type: "outcome", id: outcomeId },
      strategies: ["system"],
      requiresIndependentEvidence: false,
      maxEvidenceAgeSeconds: 15 * 60,
      requestedAt,
      expiresAt
    });
    const aggregateEvidence = createVerificationEvidence({
      id: `outcome-evidence:${input.run.id}`,
      correlationId: input.run.correlationId,
      portfolioId: input.run.scope.portfolioId,
      companyId: input.run.scope.companyId,
      subject: { type: "outcome", id: outcomeId },
      strategy: "system",
      result: "pass",
      sourceType: "system-probe",
      sourceId: "getdone-objective-evaluator",
      independenceKey: evaluation.evaluationHash,
      observedAt: evaluatedAt,
      payloadHash: aggregatePayloadHash,
      provenance: `orchestration-objective-evaluation:${evaluation.id}`
    });
    const receipt = resolveVerificationRequest(request, [aggregateEvidence], {
      receiptId: `outcome-verification-receipt:${input.run.id}`,
      verifiedAt: evaluatedAt,
      receiptTtlSeconds: 15 * 60
    });
    if (receipt.verdict !== "verified") {
      throw new ControlPlaneError("FORBIDDEN", "Outcome verification failed after objective evaluation");
    }

    const outcomeBase = {
      id: outcomeId,
      runId: input.run.id,
      objectiveEvaluationId: evaluation.id,
      objectiveEvaluationHash: evaluation.evaluationHash,
      verificationReceiptId: receipt.id,
      verificationReceiptHash: receipt.receiptHash,
      state: "verified" as const,
      recordedAt: evaluatedAt
    };
    const outcome: VerifiedOrchestrationOutcome = Object.freeze({
      ...outcomeBase,
      outcomeHash: sha256Hex(outcomeBase)
    });
    const outcomeRecord: OutcomeRecord = Object.freeze({
      id: outcome.id,
      correlationId: input.run.correlationId,
      portfolioId: input.run.scope.portfolioId,
      companyId: input.run.scope.companyId,
      state: "verified",
      objectiveId: input.plan.proposal.objective?.id,
      metric: input.plan.proposal.objective?.metric
        ?? input.plan.proposal.expectedOutcomes[0]?.metric
        ?? "execution.completed",
      value: input.plan.proposal.objective?.target
        ?? input.plan.proposal.expectedOutcomes[0]?.target
        ?? "true",
      evidenceIds: Object.freeze([aggregateEvidence.id, ...input.evidence.map((entry) => entry.id)]),
      verificationReceiptId: receipt.id,
      verificationReceiptHash: receipt.receiptHash,
      confidence: 1,
      version: 1,
      updatedAt: evaluatedAt
    });

    await this.db.transaction(async (client) => {
      await new PostgresVerificationReceiptStore(client).insert(receipt);
      await this.insertEvaluation(client, input.run, evaluation);
      const insertedOutcome = await client.query(
        `INSERT INTO orchestration_outcomes(
          id,run_id,portfolio_id,company_id,objective_evaluation_id,
          verification_receipt_id,verification_receipt_hash,outcome_hash,payload,recorded_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
        ON CONFLICT (run_id) DO NOTHING`,
        [
          outcome.id,
          input.run.id,
          input.run.scope.portfolioId,
          input.run.scope.companyId,
          evaluation.id,
          receipt.id,
          receipt.receiptHash,
          outcome.outcomeHash,
          JSON.stringify(outcome),
          evaluatedAt
        ]
      );
      if (insertedOutcome.rowCount !== 1) {
        const priorOutcome = await client.query<{
          outcome_hash: string;
          payload: VerifiedOrchestrationOutcome;
        }>(
          "SELECT outcome_hash,payload FROM orchestration_outcomes WHERE run_id=$1",
          [input.run.id]
        );
        if (
          priorOutcome.rows[0]?.outcome_hash !== outcome.outcomeHash
          || priorOutcome.rows[0]?.payload.outcomeHash !== outcome.outcomeHash
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Objective outcome run already exists with different authoritative content"
          );
        }
      }
      const insertedOwnerOutcome = await client.query(
        `INSERT INTO control_plane_entities(
          entity_type,id,portfolio_id,company_id,version,updated_at,payload
        ) VALUES('outcome',$1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (entity_type,id) DO NOTHING`,
        [
          outcomeRecord.id,
          outcomeRecord.portfolioId,
          outcomeRecord.companyId,
          outcomeRecord.version,
          outcomeRecord.updatedAt,
          JSON.stringify(outcomeRecord)
        ]
      );
      if (insertedOwnerOutcome.rowCount !== 1) {
        const priorOwnerOutcome = await client.query<{ payload: OutcomeRecord }>(
          `SELECT payload FROM control_plane_entities
            WHERE entity_type='outcome' AND id=$1`,
          [outcomeRecord.id]
        );
        if (
          !priorOwnerOutcome.rows[0]
          || sha256Hex(priorOwnerOutcome.rows[0].payload) !== sha256Hex(outcomeRecord)
        ) {
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Owner outcome entity already exists with different authoritative content"
          );
        }
      }
      await new PostgresAuditLedger(client).append(createAuditEvent({
        correlationId: input.run.correlationId,
        eventType: "outcome.verified",
        actor: { type: "system", id: "getdone-objective-evaluator" },
        scope: {
          userId: input.run.scope.userId,
          portfolioId: input.run.scope.portfolioId,
          companyId: input.run.scope.companyId
        },
        environment: input.run.scope.environment,
        entityType: "outcome",
        entityId: outcome.id,
        newState: "verified",
        provenance: "orchestration:verification-objective-outcome",
        metadata: {
          runId: input.run.id,
          objectiveEvaluationId: evaluation.id,
          objectiveEvaluationHash: evaluation.evaluationHash,
          verificationReceiptId: receipt.id,
          verificationReceiptHash: receipt.receiptHash
        }
      }));
    });

    return { kind: "verified" as const, evaluation, outcome };
  }

  private async persistEvaluationOnly(
    run: OrchestrationRunRecord,
    evaluation: ObjectiveEvaluationArtifact
  ) {
    await this.db.transaction((client) => this.insertEvaluation(client, run, evaluation));
  }

  private async insertEvaluation(
    db: SqlQueryable,
    run: OrchestrationRunRecord,
    evaluation: ObjectiveEvaluationArtifact
  ) {
    const inserted = await db.query(
      `INSERT INTO orchestration_objective_evaluations(
        id,run_id,portfolio_id,company_id,status,evaluation_hash,payload,evaluated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      ON CONFLICT (run_id) DO NOTHING`,
      [
        evaluation.id,
        run.id,
        run.scope.portfolioId,
        run.scope.companyId,
        evaluation.status,
        evaluation.evaluationHash,
        JSON.stringify(evaluation),
        evaluation.evaluatedAt
      ]
    );
    if (inserted.rowCount === 1) return;

    const existing = await db.query<{
      evaluation_hash: string;
      payload: ObjectiveEvaluationArtifact;
    }>(
      "SELECT evaluation_hash,payload FROM orchestration_objective_evaluations WHERE run_id=$1",
      [run.id]
    );
    if (
      existing.rows[0]?.evaluation_hash === evaluation.evaluationHash
      && existing.rows[0]?.payload.evaluationHash === evaluation.evaluationHash
    ) return;
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Objective evaluation run already exists with different authoritative content"
    );
  }
}
