import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  assertAuthorizationConsumption,
  assertAuthorizationGrantEnvelope,
  type AuthorizationGrant,
  type AuthorizationGrantStore
} from "@/lib/authorization/grants";
import { assertTrustedExecutionScopeEqual } from "@/lib/control-plane/trusted-execution-scope";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import type { JobRecord, JobService } from "@/lib/domain/services/job-service";
import type { TaskRecord } from "@/lib/domain/services/task-service";
import type { AuthorizedBusinessActionRequest } from "@/lib/execution/adapters/business-action";
import type { BusinessActionExecutionOrchestrator } from "@/lib/execution/business-action-orchestrator";
import type { CurrentExecutionAdmissionGate } from "@/lib/execution/current-execution-admission";
import type {
  DurableJobExecutionContext,
  DurableJobExecutionHandler,
  JobExecutionOutcome
} from "@/lib/execution/job-worker-runtime";
import type {
  ProductionPromotionReceipt,
  SoftwarePostDeploymentVerificationEvidence,
  SoftwareWorkerPlan
} from "@/lib/execution/software-worker";
import type { SoftwareWorkerRuntime } from "@/lib/execution/software-worker-runtime";
import type { JobVerificationEvidenceStore } from "@/lib/persistence/postgres/worker-runtime-stores";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

export const JOB_EXECUTION_ROUTER_VERSION = "1.2.0";

export type JobExecutionSpec =
  | {
      kind: "business-action";
      jobId: string;
      authoritativeJobVersion: number;
      authoritativeJobHash: string;
      request: AuthorizedBusinessActionRequest;
    }
  | {
      kind: "software-prepare";
      jobId: string;
      plan: SoftwareWorkerPlan;
    }
  | {
      kind: "software-deploy";
      jobId: string;
      plan: SoftwareWorkerPlan;
      promotion: ProductionPromotionReceipt;
    }
  | {
      kind: "software-verify";
      jobId: string;
      plan: SoftwareWorkerPlan;
      verification: SoftwarePostDeploymentVerificationEvidence;
    }
  | {
      kind: "software-rollback";
      jobId: string;
      plan: SoftwareWorkerPlan;
    };

export interface PersistedJobExecutionSpec {
  jobId: string;
  spec: JobExecutionSpec;
  specHash: string;
  createdAt: string;
}

export interface JobExecutionSpecStore {
  get(jobId: string): Promise<PersistedJobExecutionSpec | null>;
  put(record: PersistedJobExecutionSpec): Promise<void>;
}

export interface AuthoritativeJobReadStore {
  get(jobId: string): Promise<JobRecord | null>;
}

export interface AuthoritativeTaskReadStore {
  get(taskId: string): Promise<TaskRecord | null>;
}

export interface AuthoritativeGrantReadStore {
  get(grantId: string): Promise<AuthorizationGrant | null>;
}

export function createPersistedJobExecutionSpec(
  spec: JobExecutionSpec,
  createdAt = new Date().toISOString()
): PersistedJobExecutionSpec {
  if (spec.jobId.trim().length === 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Job execution spec requires jobId");
  }
  const base = { jobId: spec.jobId, spec, createdAt };
  return Object.freeze({ ...base, specHash: sha256Hex(base) });
}

function assertPersistedSpec(record: PersistedJobExecutionSpec, jobId: string) {
  const { specHash, ...base } = record;
  if (
    sha256Hex(base) !== specHash
    || record.jobId !== jobId
    || record.spec.jobId !== jobId
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Persisted Job execution spec is tampered or bound to a different Job"
    );
  }
  return record;
}

export class RoutedJobExecutionHandler implements DurableJobExecutionHandler {
  constructor(
    private readonly specs: JobExecutionSpecStore,
    private readonly business: BusinessActionExecutionOrchestrator,
    private readonly software?: SoftwareWorkerRuntime,
    private readonly authority?: {
      jobs: AuthoritativeJobReadStore;
      tasks: AuthoritativeTaskReadStore;
      grants: Pick<AuthorizationGrantStore, "get">;
      admission: CurrentExecutionAdmissionGate;
      verificationEvidence: JobVerificationEvidenceStore;
      lifecycle: Pick<
        JobService,
        | "claim"
        | "startProviderExecution"
        | "recordProviderCompletion"
        | "retry"
        | "recoverTimeout"
        | "fail"
        | "cancel"
      >;
    },
    private readonly now: () => Date = () => new Date()
  ) {}

  private lifecycleCommand(
    context: DurableJobExecutionContext,
    operation: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    const idempotencyKey = [
      "job-lifecycle",
      context.envelope.jobId,
      String(context.lease.attempt),
      operation
    ].join(":");
    return createCommandEnvelope({
      commandId: idempotencyKey,
      actor: { type: "worker", id: context.lease.workerId },
      scope: context.envelope.scope,
      correlationId: context.envelope.correlationId ?? context.envelope.id,
      environment: context.envelope.scope.environment,
      idempotencyKey,
      provenance: "durable-job-worker",
      requestedMutation: {
        operation,
        durableAttempt: context.lease.attempt,
        ...details
      }
    });
  }

  private async validateBusinessAuthority(
    context: DurableJobExecutionContext,
    spec: Extract<JobExecutionSpec, { kind: "business-action" }>
  ): Promise<JobExecutionOutcome | null> {
    if (!this.authority) {
      return { kind: "dead-letter", reason: "Authoritative Job execution stores are not installed" };
    }

    let authoritative: JobRecord | null;
    try {
      authoritative = await this.authority.jobs.get(context.envelope.jobId);
    } catch (error) {
      return {
        kind: "retry",
        reason: error instanceof Error
          ? `Authoritative Job re-read failed: ${error.message}`
          : "Authoritative Job re-read failed"
      };
    }

    if (!authoritative) {
      return { kind: "dead-letter", reason: "Authoritative Job was not found before execution" };
    }
    if (authoritative.state === "cancelled") {
      return { kind: "cancelled", reason: "Authoritative Job was cancelled before execution" };
    }
    if (authoritative.state === "verified" || authoritative.state === "succeeded") {
      return { kind: "verified" };
    }
    if (authoritative.state === "provider_completed") {
      return { kind: "provider-completed" };
    }

    if (
      ["claimed", "executing", "running"].includes(authoritative.state)
      && authoritative.attempt < context.lease.attempt
    ) {
      try {
        authoritative = await this.authority.lifecycle.recoverTimeout(
          authoritative.id,
          this.lifecycleCommand(context, "recover-timeout"),
          new Date().toISOString()
        );
      } catch {
        try {
          await this.authority.lifecycle.fail(
            authoritative.id,
            this.lifecycleCommand(context, "timeout-attempts-exhausted"),
            "Execution lease expired and the authoritative retry limit is exhausted"
          );
        } catch {
          // The failure transition is best-effort here; the durable dead letter remains authoritative runtime evidence.
        }
        return {
          kind: "dead-letter",
          reason: "Authoritative Job could not recover an expired execution claim"
        };
      }
    }

    if (authoritative.state !== "queued") {
      return {
        kind: "dead-letter",
        reason: `Authoritative Job is not executable from state ${authoritative.state}`
      };
    }
    if (
      authoritative.attempt === 0
      && (
        authoritative.version !== spec.authoritativeJobVersion
        || sha256Hex(authoritative) !== spec.authoritativeJobHash
      )
    ) {
      return { kind: "dead-letter", reason: "Authoritative Job snapshot is stale" };
    }
    if (authoritative.attempt + 1 !== context.lease.attempt) {
      return {
        kind: "dead-letter",
        reason: "Durable worker attempt does not match authoritative Job attempt lineage"
      };
    }

    try {
      assertTrustedExecutionScopeEqual(spec.request.scope, context.envelope.scope, {
        requireSameResource: Boolean(
          spec.request.scope.resourceId || context.envelope.scope.resourceId
        )
      });
      if (authoritative.authorizationConsumption) {
        assertTrustedExecutionScopeEqual(
          authoritative.authorizationConsumption.scope,
          context.envelope.scope,
          {
            requireSameResource: Boolean(
              authoritative.authorizationConsumption.scope.resourceId
              || context.envelope.scope.resourceId
            )
          }
        );
      }
    } catch {
      return { kind: "dead-letter", reason: "Business action scope lineage mismatch" };
    }

    if (
      authoritative.taskId !== context.envelope.taskId
      || spec.request.jobId !== context.envelope.jobId
      || spec.request.authorizationConsumptionHash
        !== context.envelope.authorizationConsumptionHash
      || !authoritative.authorizationGrantId
      || !authoritative.authorizationGrantHash
      || !authoritative.authorizationConsumption
      || authoritative.authorizationConsumption.consumerType !== "task"
      || authoritative.authorizationConsumption.consumerId !== authoritative.taskId
      || authoritative.authorizationConsumption.grantId !== authoritative.authorizationGrantId
      || authoritative.authorizationConsumption.grantHash !== authoritative.authorizationGrantHash
      || authoritative.authorizationConsumption.consumptionHash
        !== context.envelope.authorizationConsumptionHash
    ) {
      return { kind: "dead-letter", reason: "Business action Job/authorization lineage mismatch" };
    }

    let task: TaskRecord | null;
    let grant: AuthorizationGrant | null;
    try {
      [task, grant] = await Promise.all([
        this.authority.tasks.get(authoritative.taskId),
        this.authority.grants.get(authoritative.authorizationGrantId)
      ]);
    } catch (error) {
      return {
        kind: "retry",
        reason: error instanceof Error
          ? `Current execution authority re-read failed: ${error.message}`
          : "Current execution authority re-read failed"
      };
    }

    if (!task) {
      return { kind: "dead-letter", reason: "Authoritative parent Task was not found before execution" };
    }
    if (!grant || grant.grantHash !== authoritative.authorizationGrantHash) {
      return { kind: "dead-letter", reason: "Current authorization grant is missing or changed" };
    }
    if (!["queued", "running"].includes(task.state)) {
      return {
        kind: "dead-letter",
        reason: `Parent Task is not executable from state ${task.state}`
      };
    }

    const taskConsumption = task.authorizationConsumption;
    if (
      task.id !== authoritative.taskId
      || task.portfolioId !== authoritative.portfolioId
      || task.companyId !== authoritative.companyId
      || task.authorizationGrantId !== grant.id
      || task.authorizationGrantHash !== grant.grantHash
      || !taskConsumption
      || taskConsumption.consumerType !== "task"
      || taskConsumption.consumerId !== task.id
      || taskConsumption.consumptionHash
        !== authoritative.authorizationConsumption.consumptionHash
    ) {
      return { kind: "dead-letter", reason: "Parent Task authority lineage does not match the Job" };
    }

    try {
      assertTrustedExecutionScopeEqual(grant.scope, context.envelope.scope, {
        requireSameResource: Boolean(
          grant.scope.resourceId || context.envelope.scope.resourceId
        )
      });
      assertAuthorizationGrantEnvelope(
        grant,
        context.envelope.scope,
        this.now().getTime()
      );
      assertAuthorizationConsumption(taskConsumption, grant);
      assertAuthorizationConsumption(authoritative.authorizationConsumption, grant);

      const requiredCapabilities = [...new Set(task.capabilityRequirements)].sort();
      const grantedCapabilities = [...new Set(grant.capabilityNames)].sort();
      if (
        requiredCapabilities.length !== grantedCapabilities.length
        || requiredCapabilities.some(
          (capability, index) => capability !== grantedCapabilities[index]
        )
        || !grantedCapabilities.includes(spec.request.capability)
      ) {
        throw new ControlPlaneError(
          "FORBIDDEN",
          "Current Task/capability authorization no longer matches the requested operation"
        );
      }

      validateCapabilityInput(spec.request.capability, spec.request.input);
      await this.authority.admission.assertAllowed({
        scope: context.envelope.scope,
        grant,
        capability: spec.request.capability,
        timeoutMs: spec.request.timeoutMs,
        attempt: context.lease.attempt
      });
    } catch (error) {
      return {
        kind: "dead-letter",
        reason: error instanceof Error
          ? `Current execution authority is invalid: ${error.message}`
          : "Current execution authority is invalid"
      };
    }

    return null;
  }

  async execute(context: DurableJobExecutionContext): Promise<JobExecutionOutcome> {
    return runWithPostgresTenantScope(context.envelope.scope, () =>
      this.executeScoped(context)
    );
  }

  private async executeScoped(context: DurableJobExecutionContext): Promise<JobExecutionOutcome> {
    const persisted = await this.specs.get(context.envelope.jobId);
    if (!persisted) {
      return { kind: "dead-letter", reason: "Job execution spec is missing" };
    }
    const { spec } = assertPersistedSpec(persisted, context.envelope.jobId);

    switch (spec.kind) {
      case "business-action": {
        const authorityFailure = await this.validateBusinessAuthority(context, spec);
        if (authorityFailure) return authorityFailure;

        const claimed = await this.authority!.lifecycle.claim(
          spec.jobId,
          this.lifecycleCommand(context, "claim"),
          context.lease.workerId
        );
        const executing = await this.authority!.lifecycle.startProviderExecution(
          spec.jobId,
          this.lifecycleCommand(context, "start-provider-execution"),
          context.lease.workerId
        );

        let result;
        try {
          result = await this.business.execute(spec.request);
        } catch (error) {
          const reason = error instanceof Error
            ? `Provider execution threw before completion: ${error.message}`
            : "Provider execution threw before completion";
          if (executing.attempt >= (executing.maxAttempts ?? 5)) {
            await this.authority!.lifecycle.fail(
              spec.jobId,
              this.lifecycleCommand(context, "provider-exception-terminal"),
              reason
            );
            return { kind: "dead-letter", reason };
          }
          await this.authority!.lifecycle.retry(
            spec.jobId,
            this.lifecycleCommand(context, "provider-exception-retry"),
            reason
          );
          return { kind: "retry", reason };
        }

        if (result.verificationEvidence) {
          await this.authority!.verificationEvidence.put(
            spec.jobId,
            spec.request.id,
            result.verificationEvidence
          );
        }

        switch (result.record.state) {
          case "completed":
            if (!result.verificationEvidence) {
              await this.authority!.lifecycle.fail(
                spec.jobId,
                this.lifecycleCommand(context, "provider-completed-without-evidence"),
                "Completed provider action did not produce verification evidence"
              );
              return {
                kind: "dead-letter",
                reason: "Completed business action did not produce verification evidence"
              };
            }
            await this.authority!.lifecycle.recordProviderCompletion(
              spec.jobId,
              this.lifecycleCommand(context, "provider-completed", {
                providerResultHash: result.record.recordHash
              }),
              {
                providerResultId: result.record.providerOperationId ?? result.record.requestId,
                providerResultHash: result.record.recordHash,
                completedAt: result.record.updatedAt
              }
            );
            return { kind: "provider-completed" };
          case "cancelled":
            await this.authority!.lifecycle.cancel(
              spec.jobId,
              this.lifecycleCommand(context, "provider-cancelled")
            );
            return { kind: "cancelled", reason: "Provider operation was cancelled" };
          case "rejected":
            await this.authority!.lifecycle.fail(
              spec.jobId,
              this.lifecycleCommand(context, "provider-rejected"),
              "Provider rejected the authorized action"
            );
            return { kind: "dead-letter", reason: "Provider rejected the authorized action" };
          case "failed": {
            const reason = result.record.retryable
              ? "Provider reported retryable action failure"
              : "Provider reported terminal action failure";
            if (result.record.retryable && claimed.attempt < (claimed.maxAttempts ?? 5)) {
              await this.authority!.lifecycle.retry(
                spec.jobId,
                this.lifecycleCommand(context, "provider-failed-retry"),
                reason
              );
              return { kind: "retry", reason };
            }
            await this.authority!.lifecycle.fail(
              spec.jobId,
              this.lifecycleCommand(context, "provider-failed-terminal"),
              reason
            );
            return { kind: "dead-letter", reason };
          }
          default: {
            const reason = "Provider operation is still pending";
            if (claimed.attempt >= (claimed.maxAttempts ?? 5)) {
              await this.authority!.lifecycle.fail(
                spec.jobId,
                this.lifecycleCommand(context, "provider-pending-terminal"),
                "Provider did not reach completion before the authoritative attempt limit"
              );
              return {
                kind: "dead-letter",
                reason: "Provider did not reach completion before the authoritative attempt limit"
              };
            }
            await this.authority!.lifecycle.retry(
              spec.jobId,
              this.lifecycleCommand(context, "provider-pending-retry"),
              reason
            );
            return { kind: "retry", reason, delayMs: 2_000 };
          }
        }
      }
      case "software-prepare": {
        if (!this.software) return { kind: "dead-letter", reason: "Software executor is not installed" };
        const runtime = await this.software.prepare(spec.plan);
        return runtime.pipeline.state === "awaiting-production-approval"
          ? { kind: "provider-completed" }
          : { kind: "retry", reason: `Software preparation paused at ${runtime.pipeline.state}` };
      }
      case "software-deploy": {
        if (!this.software) return { kind: "dead-letter", reason: "Software executor is not installed" };
        const result = await this.software.deployProduction(spec.plan, spec.promotion);
        return result.runtime.pipeline.state === "post-deploy-verifying"
          ? { kind: "provider-completed" }
          : { kind: "retry", reason: "Software deployment did not reach verification handoff" };
      }
      case "software-verify": {
        if (!this.software) return { kind: "dead-letter", reason: "Software executor is not installed" };
        const runtime = await this.software.completeProductionVerification(
          spec.plan,
          spec.verification
        );
        return runtime.pipeline.state === "succeeded"
          ? { kind: "verified" }
          : { kind: "dead-letter", reason: "Software verification failed to establish verified state" };
      }
      case "software-rollback": {
        if (!this.software) return { kind: "dead-letter", reason: "Software executor is not installed" };
        const runtime = await this.software.rollback(spec.plan);
        return runtime.pipeline.state === "rolled-back"
          ? { kind: "provider-completed" }
          : { kind: "dead-letter", reason: "Software rollback did not reach terminal state" };
      }
    }
  }
}
