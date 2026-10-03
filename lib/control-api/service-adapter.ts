import { authorizeRequest } from "@/lib/auth/guard";
import type { StepUpProof } from "@/lib/authorization/proofs";
import type { AuthAdapter, AuthSession } from "@/lib/auth/contracts";
import { createCommandEnvelope } from "@/lib/control-plane/command-envelope";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { createCorrelationId } from "@/lib/control-plane/request-context";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import {
  resolveDecision,
  type AuthoritativeDecision
} from "@/lib/domain/decision-service";
import type { DecisionTransactionManager } from "@/lib/domain/decision-transaction";
import type { JobRecord } from "@/lib/domain/services/job-service";
import { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import {
  ResourceEnrollmentService,
  type ResourceEnrollmentRecord
} from "@/lib/resources/enrollment";
import type { VerificationRequestRecord } from "@/lib/domain/services/verification-service";
import type { Resource } from "@/lib/domain/resources";
import type {
  PreferenceLearningService,
  PreferenceSuggestionResolution
} from "@/lib/domain/preference-learning";
import {
  buildJobOwnerExplanation,
  buildOwnerFailurePresentation
} from "@/lib/explainability/job-owner-explanation";
import {
  normalizeObjectiveIntake,
  type ObjectiveIntakeInput,
  type ObjectiveIntakeStore,
  type ObjectiveRecord
} from "@/lib/domain/objective-inbox";
import type {
  ControlApiApplicationAdapter,
  ControlApiHealth,
  ControlApiPrincipal,
  ControlApiRole,
  DecisionMutationInput,
  JobResultView,
  OwnerIntentInput,
  OwnerIntentRecord,
  ResourceDiscoveryInput,
  ResourceEnrollmentActionInput,
  ResourceEnrollmentStartInput
} from "@/lib/control-api/contracts";

export interface ControlApiScopeResolver {
  resolve(
    session: AuthSession,
    request: Request
  ): Promise<{ scope: TrustedExecutionScope; role: ControlApiRole }>;
}

export interface ControlApiAuthorizationEvidenceResolver {
  /**
   * Resolve proof from an authoritative server-side auth/session provider.
   * Implementations MUST NOT trust proof objects supplied in request JSON.
   */
  resolveStepUpProof(
    session: AuthSession,
    request: Request,
    scope: TrustedExecutionScope
  ): Promise<StepUpProof | undefined>;
}

export interface ScopedReadStore<T extends { id: string; portfolioId: string; companyId: string }> {
  listByScope(portfolioId: string, companyId: string): Promise<readonly T[]>;
  get(id: string): Promise<T | null>;
}

export interface OwnerIntentStore {
  /**
   * Production persistence MUST not acknowledge an accepted OwnerIntent until
   * the intent and its initial durable orchestration admission have committed
   * together. In-memory/test implementations may remain non-durable.
   */
  create(record: OwnerIntentRecord, idempotencyKey: string): Promise<OwnerIntentRecord>;
}

export interface ServiceBackedControlApiDependencies {
  auth: AuthAdapter;
  scopes: ControlApiScopeResolver;
  authorizationEvidence?: ControlApiAuthorizationEvidenceResolver;
  intents: OwnerIntentStore;
  objectives: ScopedReadStore<ObjectiveRecord>;
  objectiveIntake: ObjectiveIntakeStore;
  preferenceLearning?: PreferenceLearningService;
  decisions: ScopedReadStore<AuthoritativeDecision>;
  decisionTransactions: DecisionTransactionManager;
  /**
   * Optional post-commit dispatcher for orchestration Decisions. The Decision
   * transaction already emits a durable resume request; dispatcher failures
   * must not roll back or misreport the committed owner Decision.
   */
  decisionResumeDispatcher?: {
    processDecision(decision: AuthoritativeDecision): Promise<unknown>;
  };
  resources: ScopedReadStore<Resource>;
  resourceRegistry: ResourceRegistryService;
  resourceEnrollments: ScopedReadStore<ResourceEnrollmentRecord>;
  resourceEnrollmentService: ResourceEnrollmentService;
  jobs: ScopedReadStore<JobRecord>;
  verifications: ScopedReadStore<VerificationRequestRecord>;
  health: () => Promise<ControlApiHealth>;
  tenantScopeRunner?: <T>(
    scope: TrustedExecutionScope,
    operation: () => Promise<T> | T
  ) => Promise<T> | T;
  now?: () => Date;
}

function assertScopedEntity<T extends { portfolioId: string; companyId: string }>(
  principal: ControlApiPrincipal,
  entity: T | null
): T | null {
  if (!entity) return null;
  if (
    entity.portfolioId !== principal.scope.portfolioId
    || entity.companyId !== principal.scope.companyId
  ) {
    throw new ControlPlaneError("NOT_FOUND", "Scoped control-plane entity was not found");
  }
  return entity;
}

export function toJobResultView(job: JobRecord): JobResultView {
  const failure = buildOwnerFailurePresentation(job);
  return Object.freeze({
    jobId: job.id,
    state: job.state,
    verificationEvidenceIds: Object.freeze([...job.verificationEvidenceIds]),
    correlationId: job.correlationId,
    verificationReceiptId: job.verificationReceiptId,
    verificationReceiptHash: job.verificationReceiptHash,
    verifiedCompletionFactId: job.verifiedCompletionFactId,
    verifiedCompletionFactHash: job.verifiedCompletionFactHash,
    failureReason: failure?.summary,
    explanation: buildJobOwnerExplanation(job),
    failure
  });
}

function requireRole(
  principal: ControlApiPrincipal,
  allowed: readonly ControlApiRole[],
  action: string
) {
  if (!allowed.includes(principal.role)) {
    throw new ControlPlaneError("FORBIDDEN", `${action} requires elevated Control API role`);
  }
}

export class ServiceBackedControlApiAdapter implements ControlApiApplicationAdapter {
  private readonly now: () => Date;

  constructor(private readonly deps: ServiceBackedControlApiDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  private scoped<T>(
    principal: ControlApiPrincipal,
    operation: () => Promise<T> | T
  ): Promise<T> {
    const runner = this.deps.tenantScopeRunner;
    return Promise.resolve(
      runner ? runner(principal.scope, operation) : operation()
    );
  }

  async authenticate(request: Request): Promise<ControlApiPrincipal> {
    const { session } = await authorizeRequest(this.deps.auth, request, "session");
    const resolved = await this.deps.scopes.resolve(session, request);
    const scope = resolved.scope;
    if (
      scope.userId !== session.userId
      || !scope.portfolioId
      || !scope.companyId
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Trusted Control API scope is incomplete");
    }
    const stepUpProof = await this.deps.authorizationEvidence?.resolveStepUpProof(
      session,
      request,
      scope
    );
    return {
      actor: { type: "user", id: session.userId },
      scope,
      sessionId: session.sessionId,
      role: resolved.role,
      stepUpProof
    };
  }

  health() {
    return this.deps.health();
  }

  async beginStepUp(request: Request) {
    const { session } = await authorizeRequest(this.deps.auth, request, "session");
    return this.deps.auth.beginStepUp(session);
  }

  async verifyStepUp(request: Request, challengeId: string, response: unknown) {
    const { session: current } = await authorizeRequest(this.deps.auth, request, "session");
    const rotated = await this.deps.auth.verifyStepUp(current, challengeId, response);
    const elevated = rotated.session;
    if (elevated.sessionId !== current.sessionId || elevated.userId !== current.userId) {
      throw new ControlPlaneError("FORBIDDEN", "Step-up challenge belongs to a different session");
    }
    if (!elevated.stepUpAuthenticatedAt) {
      throw new ControlPlaneError("FORBIDDEN", "Step-up verification did not establish fresh authentication");
    }
    return Object.freeze({
      session: Object.freeze({
        sessionId: elevated.sessionId,
        userId: elevated.userId,
        stepUpAuthenticatedAt: elevated.stepUpAuthenticatedAt
      }),
      expiresAt: elevated.expiresAt,
      rotatedSessionToken: rotated.token
    });
  }

  async logout(request: Request) {
    const { session } = await authorizeRequest(this.deps.auth, request, "session");
    await this.deps.auth.revokeSession(session.sessionId);
    return Object.freeze({
      sessionId: session.sessionId,
      revoked: true as const
    });
  }

  async revokeOtherSessions(request: Request) {
    const { session } = await authorizeRequest(this.deps.auth, request, "fresh-step-up");
    const revokedOtherSessions = await this.deps.auth.revokeOtherSessions(
      session.userId,
      session.sessionId
    );
    return Object.freeze({
      sessionId: session.sessionId,
      revokedOtherSessions
    });
  }

  async submitOwnerIntent(
    principal: ControlApiPrincipal,
    input: OwnerIntentInput,
    idempotencyKey: string,
    correlationId?: string
  ) {
    return this.scoped(principal, async () => {
      requireRole(principal, ["owner"], "Owner intent submission");
      const record: OwnerIntentRecord = Object.freeze({
        id: crypto.randomUUID(),
        correlationId: correlationId ?? createCorrelationId(),
        portfolioId: principal.scope.portfolioId,
        companyId: principal.scope.companyId,
        environment: principal.scope.environment,
        userId: principal.scope.userId,
        message: input.message,
        channel: input.channel ?? "chat",
        status: "accepted",
        receivedAt: this.now().toISOString()
      });
      return this.deps.intents.create(record, idempotencyKey);
    });
  }

  async submitObjectives(
    principal: ControlApiPrincipal,
    input: ObjectiveIntakeInput,
    idempotencyKey: string,
    correlationId?: string
  ) {
    return this.scoped(principal, async () => {
      requireRole(principal, ["owner"], "Objective submission");
      const records = normalizeObjectiveIntake(input, {
        scope: principal.scope,
        correlationId: correlationId ?? createCorrelationId(),
        now: this.now().toISOString()
      });
      return this.deps.objectiveIntake.createBatch(records, idempotencyKey);
    });
  }

  listObjectives(principal: ControlApiPrincipal) {
    return this.scoped(principal, () => this.deps.objectives.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    ));
  }

  async getObjective(principal: ControlApiPrincipal, objectiveId: string) {
    return this.scoped(principal, async () =>
      assertScopedEntity(principal, await this.deps.objectives.get(objectiveId))
    );
  }

  listPreferenceSuggestions(principal: ControlApiPrincipal) {
    requireRole(principal, ["owner", "admin"], "Preference suggestions");
    if (!this.deps.preferenceLearning) {
      throw new ControlPlaneError("UNAVAILABLE", "Preference learning is not connected");
    }
    return this.scoped(principal, () =>
      this.deps.preferenceLearning!.listSuggestions(principal.scope)
    );
  }

  resolvePreferenceSuggestion(
    principal: ControlApiPrincipal,
    suggestionId: string,
    action: PreferenceSuggestionResolution
  ) {
    requireRole(principal, ["owner"], "Preference rule confirmation");
    if (!this.deps.preferenceLearning) {
      throw new ControlPlaneError("UNAVAILABLE", "Preference learning is not connected");
    }
    return this.scoped(principal, () =>
      this.deps.preferenceLearning!.resolveSuggestion({
        suggestionId,
        scope: principal.scope,
        actorId: principal.actor.id,
        action,
        resolvedAt: this.now().toISOString()
      })
    );
  }

  listConfirmedPreferenceRules(
    principal: ControlApiPrincipal,
    capability: string
  ) {
    requireRole(principal, ["owner", "admin"], "Confirmed preference rules");
    if (!this.deps.preferenceLearning) {
      throw new ControlPlaneError("UNAVAILABLE", "Preference learning is not connected");
    }
    return this.scoped(principal, () =>
      this.deps.preferenceLearning!.listActiveRules(principal.scope, capability)
    );
  }

  listDecisions(principal: ControlApiPrincipal) {
    return this.scoped(principal, () => this.deps.decisions.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    ));
  }

  async getDecision(principal: ControlApiPrincipal, decisionId: string) {
    return this.scoped(principal, async () =>
      assertScopedEntity(principal, await this.deps.decisions.get(decisionId))
    );
  }

  mutateDecision(
    principal: ControlApiPrincipal,
    input: DecisionMutationInput,
    correlationId?: string
  ) {
    requireRole(principal, ["owner", "admin"], "Decision mutation");
    return this.scoped(principal, async () => {
      const current = assertScopedEntity(
        principal,
        await this.deps.decisions.get(input.decisionId)
      );
      if (!current) {
        throw new ControlPlaneError("NOT_FOUND", "Decision was not found");
      }
      const lineageCorrelationId = current.correlationId ?? correlationId ?? createCorrelationId();
      const command = createCommandEnvelope({
        commandId: crypto.randomUUID(),
        actor: principal.actor,
        scope: principal.scope,
        correlationId: lineageCorrelationId,
        environment: principal.scope.environment,
        idempotencyKey: input.idempotencyKey,
        provenance: "control-api:decision-mutation",
        requestedMutation: {
          type: "decision.resolve" as const,
          decisionId: input.decisionId,
          action: input.action
        }
      });

      const resolved = await resolveDecision({
        command,
        transactionManager: this.deps.decisionTransactions,
        decisionId: input.decisionId,
        action: input.action,
        stepUpProof: principal.stepUpProof,
        now: this.now
      });

      // Orchestrated Decisions already wrote a durable resume request in the
      // same authoritative transaction. This call is only a low-latency wakeup;
      // if it fails, the durable queue remains pending for later recovery.
      try {
        await this.deps.decisionResumeDispatcher?.processDecision(resolved);
      } catch {
        // Do not return an HTTP failure after the owner Decision has committed.
      }

      return resolved;
    });
  }

  listResources(principal: ControlApiPrincipal) {
    return this.scoped(principal, () => this.deps.resources.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    ));
  }

  async getResource(principal: ControlApiPrincipal, resourceId: string) {
    return this.scoped(principal, async () =>
      assertScopedEntity(principal, await this.deps.resources.get(resourceId))
    );
  }

  discoverResource(principal: ControlApiPrincipal, input: ResourceDiscoveryInput) {
    return this.scoped(principal, () => {
      requireRole(principal, ["owner", "admin"], "Resource discovery");
      const correlationId = createCorrelationId();
      const command = createCommandEnvelope({
      commandId: crypto.randomUUID(),
      actor: principal.actor,
      scope: principal.scope,
      correlationId,
      environment: principal.scope.environment,
      idempotencyKey: input.idempotencyKey,
      provenance: "control-api:resource-enrollment",
      requestedMutation: {
        type: "resource.discover",
        resourceId: input.id
      }
    });

      return this.deps.resourceRegistry.discover({
      id: input.id,
      type: input.type,
      providerId: input.providerId,
      poolId: input.poolId,
      environmentPermissions: [principal.scope.environment],
      capabilityNames: input.capabilityNames,
      failureDomainIds: input.failureDomainIds,
      credentialBindingIds: input.credentialBindingIds,
      policyBindingIds: input.policyBindingIds,
      dataClassesAllowed: ["public"],
      region: input.region,
      architecture: input.architecture,
      discoveredAt: this.now().toISOString()
      }, command);
    });
  }

  listResourceEnrollments(principal: ControlApiPrincipal) {
    return this.scoped(principal, () => this.deps.resourceEnrollments.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    ));
  }

  async getResourceEnrollment(principal: ControlApiPrincipal, enrollmentId: string) {
    return this.scoped(principal, async () => assertScopedEntity(
      principal,
      await this.deps.resourceEnrollments.get(enrollmentId)
    ));
  }

  startResourceEnrollment(
    principal: ControlApiPrincipal,
    input: ResourceEnrollmentStartInput
  ) {
    return this.scoped(principal, () => {
      requireRole(principal, ["owner", "admin"], "Resource enrollment");
    const command = this.enrollmentCommand(
      principal,
      input.idempotencyKey,
      "identify",
      input.id
    );
      return this.deps.resourceEnrollmentService.identify({
      id: input.id,
      requestedType: input.requestedType,
      requestedEnvironments: [principal.scope.environment],
      ownerActionRequired: input.ownerActionRequired,
      ownerActionDescription: input.ownerActionDescription,
      challengeToken: input.challengeToken,
      challengeIssuedAt: this.now().toISOString(),
      challengeExpiresAt: input.challengeExpiresAt
      }, command);
    });
  }

  advanceResourceEnrollment(
    principal: ControlApiPrincipal,
    enrollmentId: string,
    input: ResourceEnrollmentActionInput
  ) {
    return this.scoped(principal, () => {
      requireRole(principal, ["owner", "admin"], "Resource enrollment mutation");
    const command = this.enrollmentCommand(
      principal,
      input.idempotencyKey,
      input.action,
      enrollmentId
    );
    const requireValue = (value: string | undefined, label: string) => {
      if (!value) throw new ControlPlaneError("VALIDATION_FAILED", `${label} is required`);
      return value;
    };

    switch (input.action) {
      case "create":
        return this.deps.resourceEnrollmentService.createEnrollment(enrollmentId, command);
      case "owner-action":
        return this.deps.resourceEnrollmentService.recordOwnerAction(
          enrollmentId,
          command,
          requireValue(input.evidenceId, "evidenceId")
        );
      case "authenticate":
        return this.deps.resourceEnrollmentService.authenticate(
          enrollmentId,
          command,
          requireValue(input.challengeToken, "challengeToken"),
          requireValue(input.evidenceId, "evidenceId"),
          input.authenticatedAt
        );
      case "discover":
      case "profile":
      case "validate":
      case "test":
        return this.deps.resourceEnrollmentService[input.action](
          enrollmentId,
          command,
          requireValue(input.evidenceId, "evidenceId")
        );
      case "register":
        return this.deps.resourceEnrollmentService.register(
          enrollmentId,
          command,
          requireValue(input.resourceId, "resourceId"),
          requireValue(input.evidenceId, "evidenceId")
        );
      case "ready":
        return this.deps.resourceEnrollmentService.markReady(enrollmentId, command);
      case "fail":
        return this.deps.resourceEnrollmentService.fail(
          enrollmentId,
          command,
          requireValue(input.reason, "reason")
        );
      case "cancel":
        return this.deps.resourceEnrollmentService.cancel(enrollmentId, command);
      case "expire":
        return this.deps.resourceEnrollmentService.expire(enrollmentId, command);
      case "restart":
        return this.deps.resourceEnrollmentService.restart(
          enrollmentId,
          command,
          requireValue(input.challengeToken, "challengeToken"),
          requireValue(input.challengeExpiresAt, "challengeExpiresAt"),
          input.restartedAt
        );
      }
    });
  }

  private enrollmentCommand(
    principal: ControlApiPrincipal,
    idempotencyKey: string,
    action: string,
    enrollmentId: string
  ) {
    return createCommandEnvelope({
      commandId: crypto.randomUUID(),
      actor: principal.actor,
      scope: principal.scope,
      correlationId: createCorrelationId(),
      environment: principal.scope.environment,
      idempotencyKey,
      provenance: "control-api:resource-enrollment",
      requestedMutation: {
        type: `resource-enrollment.${action}`,
        enrollmentId
      }
    });
  }

  listJobs(principal: ControlApiPrincipal) {
    return this.scoped(principal, () => this.deps.jobs.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    ));
  }

  async getJob(principal: ControlApiPrincipal, jobId: string) {
    return this.scoped(principal, async () =>
      assertScopedEntity(principal, await this.deps.jobs.get(jobId))
    );
  }

  async getJobResult(principal: ControlApiPrincipal, jobId: string): Promise<JobResultView | null> {
    return this.scoped(principal, async () => {
      const job = assertScopedEntity(principal, await this.deps.jobs.get(jobId));
      if (!job) return null;
      return toJobResultView(job);
    });
  }

  listVerifications(principal: ControlApiPrincipal) {
    return this.scoped(principal, () => this.deps.verifications.listByScope(
      principal.scope.portfolioId,
      principal.scope.companyId
    ));
  }

  async getVerification(principal: ControlApiPrincipal, verificationId: string) {
    return this.scoped(principal, async () => assertScopedEntity(
      principal,
      await this.deps.verifications.get(verificationId)
    ));
  }
}
