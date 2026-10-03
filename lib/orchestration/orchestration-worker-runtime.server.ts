import { getAIGatewayFromEnv } from "@/lib/ai-gateway/runtime.server";
import type { AIBudgetSnapshot } from "@/lib/ai-gateway/contracts";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import type { KillSwitch } from "@/lib/domain/kill-switch";
import {
  createCredentialAvailabilitySnapshot,
  evaluateCredentialAvailability,
  type CredentialAvailabilitySnapshot,
  type CredentialBindingReference,
  type CredentialBindingRequirement
} from "@/lib/domain/credential-binding";
import { PreferenceLearningService } from "@/lib/domain/preference-learning";
import {
  assertCredentialLease,
  type CredentialLease
} from "@/lib/credentials/broker";
import type { ContextItem, ContextScope } from "@/lib/intelligence/context";
import type { CompanyIntegration, IntegrationKind } from "@/lib/integrations/contracts";
import { assertCompanyIntegrationIntegrity } from "@/lib/integrations/registry";
import {
  AIGatewayDurablePlanner,
  type PlannerAIBudgetProvider
} from "@/lib/orchestration/ai-gateway-planner";
import { AuthoritativeExecutionCoordinator } from "@/lib/orchestration/authoritative-execution-coordinator";
import type { OrchestrationRunRecord } from "@/lib/orchestration/contracts";
import type { AuthoritativeObjective } from "@/lib/orchestration/objective-flow";
import { PostgresObjectiveOutcomePort } from "@/lib/orchestration/objective-outcome-runtime.server";
import {
  PostgresGovernedJobRuntime,
  type OrchestrationCredentialLeaseResolver
} from "@/lib/orchestration/post-authorization-runtime.server";
import {
  createDedicatedOrchestrationWorkerProcessFromEnv
} from "@/lib/orchestration/runtime.server";
import type {
  DurablePolicyInputResolver,
  DurableValidationInputResolver
} from "@/lib/orchestration/validation-policy-flow";
import {
  PostgresEntityStore
} from "@/lib/persistence/postgres/authority-stores";
import {
  PostgresOwnerIntentStore
} from "@/lib/persistence/postgres/control-api-stores";
import {
  PostgresOrchestrationAuthorizationGrantStore,
  PostgresOrchestrationDecisionStore
} from "@/lib/persistence/postgres/orchestration-authorization-stores";
import {
  PostgresOrchestrationContextSnapshotStore
} from "@/lib/persistence/postgres/orchestration-context-snapshot-store";
import {
  PostgresOrchestrationJobGraphStore,
  PostgresOrchestrationTaskDagStore,
  PostgresOrchestrationTaskDedupeStore
} from "@/lib/persistence/postgres/orchestration-execution-stores";
import {
  PostgresOrchestrationPlanProposalStore,
  PostgresPlannerInputStore
} from "@/lib/persistence/postgres/orchestration-planning-stores";
import {
  PostgresOrchestrationPolicyEvaluationStore,
  PostgresOrchestrationPolicyStepSnapshotStore,
  PostgresOrchestrationValidationArtifactStore
} from "@/lib/persistence/postgres/orchestration-validation-policy-stores";
import {
  PostgresPreferenceLearningStore
} from "@/lib/persistence/postgres/preference-learning-store";
import {
  getPostgresRuntimeFromEnv
} from "@/lib/persistence/postgres/runtime.server";
import type {
  GeneratedTask,
  TaskGenerationDedupeStore
} from "@/lib/planning/task-generator";
import type { AuthorizationConsumptionRecord } from "@/lib/authorization/grants";
import type { PlanStep } from "@/lib/planning/plan-schema";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

export const AUTHORITATIVE_ORCHESTRATION_WORKER_RUNTIME_VERSION = "1.0.0";

export interface AuthoritativeOrchestrationRuntimeConfig {
  maxPlanCostCents: number;
  maxStepCostCents: number;
  aiCompanyDailyBudgetCents: number;
  aiPortfolioDailyBudgetCents: number;
  aiConcurrencyLimit: number;
  validationTtlSeconds: number;
}

function positiveInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number
) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      `${name} must be a positive integer`
    );
  }
  return value;
}

export function readAuthoritativeOrchestrationRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): AuthoritativeOrchestrationRuntimeConfig {
  const config = {
    maxPlanCostCents: positiveInteger(
      env,
      "GETDONE_ORCHESTRATION_MAX_PLAN_COST_CENTS",
      10_000
    ),
    maxStepCostCents: positiveInteger(
      env,
      "GETDONE_ORCHESTRATION_MAX_STEP_COST_CENTS",
      5_000
    ),
    aiCompanyDailyBudgetCents: positiveInteger(
      env,
      "GETDONE_AI_COMPANY_DAILY_BUDGET_CENTS",
      5_000
    ),
    aiPortfolioDailyBudgetCents: positiveInteger(
      env,
      "GETDONE_AI_PORTFOLIO_DAILY_BUDGET_CENTS",
      20_000
    ),
    aiConcurrencyLimit: positiveInteger(
      env,
      "GETDONE_AI_CONCURRENCY_LIMIT",
      2
    ),
    validationTtlSeconds: positiveInteger(
      env,
      "GETDONE_ORCHESTRATION_VALIDATION_TTL_SECONDS",
      300
    )
  };

  if (config.maxStepCostCents > config.maxPlanCostCents) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Orchestration step cost ceiling cannot exceed the plan cost ceiling"
    );
  }

  return Object.freeze(config);
}

function utcDayStart(now: Date) {
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
}

class PostgresPlannerAIBudgetProvider implements PlannerAIBudgetProvider {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly config: AuthoritativeOrchestrationRuntimeConfig,
    private readonly now: () => Date = () => new Date()
  ) {}

  async snapshot(input: {
    plannerInput: {
      scope: {
        portfolioId: string;
        companyId: string;
      };
    };
    requestId: string;
  }): Promise<AIBudgetSnapshot> {
    const now = this.now();
    const start = utcDayStart(now).toISOString();

    const [company, portfolio] = await Promise.all([
      this.db.query<{ cents: string | number }>(
        `SELECT COALESCE(SUM(actual_cost_cents),0) AS cents
           FROM ai_call_audits
          WHERE portfolio_id=$1 AND company_id=$2 AND recorded_at >= $3`,
        [
          input.plannerInput.scope.portfolioId,
          input.plannerInput.scope.companyId,
          start
        ]
      ),
      this.db.query<{ cents: string | number }>(
        `SELECT COALESCE(SUM(actual_cost_cents),0) AS cents
           FROM ai_call_audits
          WHERE portfolio_id=$1 AND recorded_at >= $2`,
        [input.plannerInput.scope.portfolioId, start]
      )
    ]);

    const companySpend = Number(company.rows[0]?.cents ?? 0);
    const portfolioSpend = Number(portfolio.rows[0]?.cents ?? 0);
    if (!Number.isFinite(companySpend) || !Number.isFinite(portfolioSpend)) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        "AI spend evidence could not be resolved from PostgreSQL"
      );
    }

    return Object.freeze({
      portfolioId: input.plannerInput.scope.portfolioId,
      companyId: input.plannerInput.scope.companyId,
      period: start.slice(0, 10),
      companyRemainingCents: Math.max(
        0,
        this.config.aiCompanyDailyBudgetCents - companySpend
      ),
      portfolioRemainingCents: Math.max(
        0,
        this.config.aiPortfolioDailyBudgetCents - portfolioSpend
      ),
      activeConcurrentCalls: 0,
      concurrencyLimit: this.config.aiConcurrencyLimit,
      snapshotAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString()
    });
  }
}

interface LegacyRuntimeIntegration {
  id: string;
  portfolioId?: string;
  companyId?: string;
  company_id?: string;
  provider?: string;
  environment?: string;
  credentialBinding?: unknown;
  credential_binding?: unknown;
  supportedCapabilities?: readonly string[];
  supported_capabilities?: readonly string[];
  connectionStatus?: string;
  connection_status?: string;
  health?: string;
}

type RuntimeIntegration = LegacyRuntimeIntegration | CompanyIntegration;

const COMPANY_INTEGRATION_CAPABILITIES: Readonly<
  Partial<Record<IntegrationKind, readonly string[]>>
> = Object.freeze({
  github: Object.freeze([
    "github.repository.read",
    "github.branch.create",
    "github.commit.create",
    "github.protected-branch.commit",
    "github.pull-request.write",
    "github.issue.write",
    "github.pull-request.merge"
  ]),
  gmail: Object.freeze(["email.send"]),
  slack: Object.freeze(["slack.message.send"]),
  hubspot: Object.freeze(["crm.record.read", "crm.record.write"]),
  analytics: Object.freeze(["analytics.ingest.read"]),
  "rest-api": Object.freeze(["http.request"]),
  webhook: Object.freeze(["webhook.send"])
});

function isCompanyIntegration(
  integration: RuntimeIntegration
): integration is CompanyIntegration {
  return "recordHash" in integration
    && typeof integration.recordHash === "string"
    && "kind" in integration
    && typeof integration.kind === "string"
    && "state" in integration
    && typeof integration.state === "string";
}

function integrationCapabilities(integration: RuntimeIntegration) {
  if (isCompanyIntegration(integration)) {
    return COMPANY_INTEGRATION_CAPABILITIES[integration.kind] ?? [];
  }
  const values = integration.supportedCapabilities
    ?? integration.supported_capabilities
    ?? [];
  return values.filter((value): value is string => typeof value === "string");
}

function integrationCompany(integration: RuntimeIntegration) {
  return integration.companyId ?? (
    isCompanyIntegration(integration) ? integration.companyId : integration.company_id
  );
}

function integrationPortfolio(integration: RuntimeIntegration) {
  return integration.portfolioId;
}

function integrationCredential(integration: RuntimeIntegration) {
  if (isCompanyIntegration(integration)) return integration.credentialBindingId;
  return integration.credentialBinding ?? integration.credential_binding;
}

function integrationConnectionStatus(integration: RuntimeIntegration) {
  if (isCompanyIntegration(integration)) return integration.state;
  return integration.connectionStatus ?? integration.connection_status;
}

function integrationHealthy(integration: RuntimeIntegration) {
  return isCompanyIntegration(integration)
    ? integration.state === "connected"
    : integration.health === "healthy";
}

function integrationProvider(integration: RuntimeIntegration) {
  if (isCompanyIntegration(integration)) return integration.adapterId;
  return integration.provider ?? integration.id;
}

function integrationGrantedScopes(integration: RuntimeIntegration) {
  if (!isCompanyIntegration(integration)) return [];
  return [...new Set([...integration.readScopes, ...integration.writeScopes])].sort();
}

export function credentialReferencesFromRuntimeIntegrations(input: {
  integrations: readonly RuntimeIntegration[];
  portfolioId: string;
  companyId: string;
  environment: OrchestrationRunRecord["scope"]["environment"];
}): readonly CredentialBindingReference[] {
  const references: CredentialBindingReference[] = [];
  for (const integration of input.integrations) {
    if (isCompanyIntegration(integration)) {
      assertCompanyIntegrationIntegrity(integration);
    }
    const credential = integrationCredential(integration);
    if (
      integrationCompany(integration) !== input.companyId
      || (
        integrationPortfolio(integration) !== undefined
        && integrationPortfolio(integration) !== input.portfolioId
      )
      || integration.environment !== input.environment
      || credential === undefined
      || credential === null
      || integrationConnectionStatus(integration) !== "connected"
      || !integrationHealthy(integration)
    ) {
      continue;
    }

    references.push({
      id: typeof credential === "string" && credential.trim()
        ? credential
        : `integration-credential:${integration.id}`,
      companyId: input.companyId,
      providerId: integrationProvider(integration),
      environment: input.environment,
      capabilityNames: integrationCapabilities(integration),
      grantedScopes: integrationGrantedScopes(integration),
      status: "active"
    });
  }
  return Object.freeze(references);
}

async function loadIntegrations(
  db: PostgresTransactionalDatabase,
  companyId: string
) {
  const result = await db.query<{ payload: RuntimeIntegration }>(
    `SELECT payload
       FROM control_plane_entities
      WHERE entity_type='integration' AND company_id=$1
      ORDER BY id`,
    [companyId]
  );
  return result.rows.map((row) => row.payload);
}

function credentialRequirements(
  run: OrchestrationRunRecord,
  steps: readonly PlanStep[]
): CredentialBindingRequirement[] {
  const requirements: CredentialBindingRequirement[] = [];
  for (const step of steps) {
    if (!step.resourceRequirements.credentialBindingRequired) continue;
    for (const request of step.capabilityRequests) {
      requirements.push({
        id: `credential-requirement:${run.id}:${step.id}:${request.capability}`,
        capability: request.capability,
        environment: run.scope.environment,
        requiredScopes: [],
        required: true
      });
    }
  }
  return [...new Map(requirements.map((item) => [item.id, item])).values()];
}

async function credentialSnapshot(input: {
  db: PostgresTransactionalDatabase;
  run: OrchestrationRunRecord;
  steps: readonly PlanStep[];
  now: Date;
}): Promise<CredentialAvailabilitySnapshot | undefined> {
  const requirements = credentialRequirements(input.run, input.steps);
  if (requirements.length === 0) return undefined;

  const integrations = await loadIntegrations(input.db, input.run.scope.companyId);
  const references = credentialReferencesFromRuntimeIntegrations({
    integrations,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    environment: input.run.scope.environment
  });

  return createCredentialAvailabilitySnapshot({
    id: `credential-snapshot:${input.run.id}:v${input.run.version}`,
    portfolioId: input.run.scope.portfolioId,
    companyId: input.run.scope.companyId,
    requirements,
    references,
    checkedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + 60_000).toISOString()
  });
}

const KILL_SWITCH_SCOPES = new Set<KillSwitch["scopeType"]>([
  "global",
  "portfolio",
  "company",
  "integration",
  "capability",
  "resource",
  "pool",
  "provider",
  "failure-domain",
  "workload-class"
]);

function validKillSwitch(value: unknown): value is KillSwitch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<KillSwitch>;
  return typeof item.id === "string"
    && typeof item.scopeType === "string"
    && KILL_SWITCH_SCOPES.has(item.scopeType as KillSwitch["scopeType"])
    && typeof item.scopeId === "string"
    && typeof item.enabled === "boolean"
    && typeof item.reason === "string"
    && typeof item.activatedAt === "string"
    && Number.isFinite(Date.parse(item.activatedAt))
    && typeof item.activatedBy === "string";
}

async function loadKillSwitches(
  db: PostgresTransactionalDatabase
): Promise<readonly KillSwitch[]> {
  const result = await db.query<{ payload: unknown }>(
    `SELECT payload
       FROM control_plane_entities
      WHERE entity_type='kill-switch'
      ORDER BY id`
  );
  const switches: KillSwitch[] = [];
  for (const row of result.rows) {
    if (!validKillSwitch(row.payload)) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Malformed authoritative kill-switch record"
      );
    }
    switches.push(row.payload);
  }
  return Object.freeze(switches);
}

function exactContextScope(run: OrchestrationRunRecord): ContextScope {
  return {
    portfolioId: run.scope.portfolioId,
    companyId: run.scope.companyId,
    allowedResourceIds: run.scope.resourceId
      ? [run.scope.resourceId]
      : undefined,
    allowedSensitivity: ["public", "internal", "customer", "sensitive"]
  };
}

const emptyOwnerIntentCandidates = {
  async listForIntent(): Promise<readonly ContextItem[]> {
    return [];
  }
};

const emptyObjectiveCandidates = {
  async listForObjective(): Promise<readonly ContextItem[]> {
    return [];
  }
};

function exactContextPolicy() {
  return {
    async resolve(input: { run: OrchestrationRunRecord }) {
      return {
        scope: exactContextScope(input.run),
        options: {
          maxItems: 30,
          maxCharacters: 24_000
        }
      };
    }
  };
}

function taskRunId(task: GeneratedTask) {
  const prefix = "task:";
  const suffix = `:${task.planStepId}`;
  if (
    !task.id.startsWith(prefix)
    || !task.id.endsWith(suffix)
    || task.id.length <= prefix.length + suffix.length
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Generated Task ID does not contain deterministic orchestration lineage"
    );
  }
  return task.id.slice(prefix.length, -suffix.length);
}

export function createRunScopedTaskDedupeStore(
  db: PostgresTransactionalDatabase
): TaskGenerationDedupeStore {
  return {
    claim(
      task: GeneratedTask,
      consumption: AuthorizationConsumptionRecord
    ) {
      return new PostgresOrchestrationTaskDedupeStore(
        db,
        taskRunId(task)
      ).claim(task, consumption);
    }
  };
}

export class PostgresOrchestrationCredentialLeaseResolver
  implements OrchestrationCredentialLeaseResolver {
  constructor(
    private readonly db: PostgresTransactionalDatabase,
    private readonly now: () => Date = () => new Date()
  ) {}

  async resolve(input: {
    run: OrchestrationRunRecord;
    task: GeneratedTask;
    jobId: string;
    capability: string;
  }): Promise<string | undefined> {
    const resourceId = input.task.scope.resourceId?.trim();
    if (!resourceId) return undefined;

    const resolvedAt = this.now();
    const result = await this.db.query<{ payload: CredentialLease }>(
      `SELECT payload
         FROM credential_leases
        WHERE portfolio_id=$1
          AND company_id=$2
          AND job_id=$3
          AND resource_id=$4
          AND capability=$5
          AND status='active'
          AND expires_at>$6
        ORDER BY expires_at DESC,id
        LIMIT 2`,
      [
        input.run.scope.portfolioId,
        input.run.scope.companyId,
        input.jobId,
        resourceId,
        input.capability,
        resolvedAt.toISOString()
      ]
    );

    if (result.rows.length === 0) return undefined;
    if (result.rows.length > 1) {
      throw new ControlPlaneError(
        "FORBIDDEN",
        "Multiple active credential leases matched one production Job"
      );
    }

    const lease = result.rows[0]?.payload;
    if (!lease) return undefined;
    assertCredentialLease(lease, {
      scope: input.task.scope,
      jobId: input.jobId,
      resourceId,
      capability: input.capability,
      now: resolvedAt.getTime()
    });
    return lease.id;
  }
}

function validationResolver(
  db: PostgresTransactionalDatabase,
  config: AuthoritativeOrchestrationRuntimeConfig,
  now: () => Date
): DurableValidationInputResolver {
  return {
    async resolve({ run, planArtifact }) {
      const at = now();
      const credentials = await credentialSnapshot({
        db,
        run,
        steps: planArtifact.proposal.steps,
        now: at
      });
      const hasCredentialRequirements = planArtifact.proposal.steps.some(
        (step) => step.resourceRequirements.credentialBindingRequired
      );
      const credentialsAvailable = !hasCredentialRequirements
        || Boolean(
          credentials
          && evaluateCredentialAvailability(credentials, {
            scope: run.scope,
            capabilities: planArtifact.proposal.requestedCapabilities,
            now: at.getTime()
          }).satisfied
        );
      const hasComputeRequirements = planArtifact.proposal.steps.some(
        (step) => Boolean(step.resourceRequirements.compute)
      );
      const expiresAt = new Date(
        at.getTime() + config.validationTtlSeconds * 1_000
      ).toISOString();
      const receiptExpiresAt = new Date(
        at.getTime() + Math.max(1, config.validationTtlSeconds - 30) * 1_000
      ).toISOString();

      return {
        validationPolicy: {
          trustedScope: {
            portfolioId: run.scope.portfolioId,
            companyId: run.scope.companyId
          },
          allowedEnvironments: [run.scope.environment],
          allowedDataClasses: [planArtifact.proposal.scope.dataClass],
          maxPlanCostCents: config.maxPlanCostCents,
          maxStepCostCents: config.maxStepCostCents,
          minimumReliabilityTier: "standard",
          fallbackRequiredForProduction: true,
          fallbackRequiredForCustomerData: true,
          requireRollbackForRiskAtOrAbove: "high",
          availableCredentialBindings: credentialsAvailable
        },
        snapshot: {
          configurationVersion: AUTHORITATIVE_ORCHESTRATION_WORKER_RUNTIME_VERSION,
          evidenceRequirements: {
            health: "not-applicable",
            capacity: hasComputeRequirements ? "required" : "not-applicable",
            credentials: hasCredentialRequirements ? "required" : "not-applicable"
          },
          credentialReference: credentials
            ? {
                id: credentials.id,
                hash: credentials.snapshotHash,
                observedAt: credentials.checkedAt,
                expiresAt: credentials.expiresAt
              }
            : undefined,
          expiresAt
        },
        receiptExpiresAt
      };
    }
  };
}

function policyResolver(
  db: PostgresTransactionalDatabase,
  now: () => Date
): DurablePolicyInputResolver {
  return {
    async resolveStep({ run, planArtifact, step }) {
      const at = now();
      const credentials = await credentialSnapshot({
        db,
        run,
        steps: [step],
        now: at
      });
      const killSwitches = await loadKillSwitches(db);
      const allowedRegions = step.resourceRequirements.data.allowedRegions;

      return {
        region: allowedRegions.length === 1 ? allowedRegions[0] : undefined,
        allowedEnvironments: [run.scope.environment],
        allowedDataClasses: [planArtifact.proposal.scope.dataClass],
        allowedRegions: allowedRegions.length > 0 ? [...allowedRegions] : undefined,
        objectiveId: run.source.type === "objective" ? run.source.id : undefined,
        killSwitches,
        credentialRequirementIds: credentials
          ? credentials.requirements.map((item) => item.id)
          : [],
        credentialSnapshot: credentials,
        capacityEvidenceRequired: Boolean(step.resourceRequirements.compute),
        fallbackRequired: step.resourceRequirements.reliability.fallbackRequired,
        fallbackAvailable: !step.resourceRequirements.reliability.fallbackRequired
      };
    }
  };
}

export function createAuthoritativeExecutionCoordinatorFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: () => Date = () => new Date()
) {
  const db = getPostgresRuntimeFromEnv(env).database;
  const config = readAuthoritativeOrchestrationRuntimeConfig(env);

  const snapshots = new PostgresOrchestrationContextSnapshotStore(db);
  const plannerInputs = new PostgresPlannerInputStore(db);
  const plans = new PostgresOrchestrationPlanProposalStore(db);
  const validations = new PostgresOrchestrationValidationArtifactStore(db);
  const policyStepSnapshots = new PostgresOrchestrationPolicyStepSnapshotStore(db);
  const policies = new PostgresOrchestrationPolicyEvaluationStore(db);
  const decisions = new PostgresOrchestrationDecisionStore(db);
  const grants = new PostgresOrchestrationAuthorizationGrantStore(db);
  const taskDags = new PostgresOrchestrationTaskDagStore(db);
  const jobGraphs = new PostgresOrchestrationJobGraphStore(db);
  const objectives = new PostgresEntityStore<ObjectiveRecord>(db, "objective");
  const preferenceLearning = new PreferenceLearningService(
    new PostgresPreferenceLearningStore(db)
  );
  const governedJobs = new PostgresGovernedJobRuntime(
    db,
    env,
    now,
    new PostgresOrchestrationCredentialLeaseResolver(db, now)
  );
  const outcomes = new PostgresObjectiveOutcomePort(db, now);
  const planner = new AIGatewayDurablePlanner(
    getAIGatewayFromEnv(env),
    new PostgresPlannerAIBudgetProvider(db, config, now)
  );

  return new AuthoritativeExecutionCoordinator({
    ownerIntentContext: {
      ownerIntents: new PostgresOwnerIntentStore(db),
      candidates: emptyOwnerIntentCandidates,
      policy: exactContextPolicy(),
      snapshots,
      now
    },
    objectiveContext: {
      objectives: objectives as {
        get(id: string): Promise<AuthoritativeObjective | null>;
      },
      candidates: emptyObjectiveCandidates,
      policy: exactContextPolicy(),
      snapshots,
      now
    },
    contextPlanning: {
      snapshots,
      plannerInputs,
      now
    },
    planner: {
      plannerInputs,
      plans,
      planner,
      now
    },
    validation: {
      plans,
      validations,
      resolver: validationResolver(db, config, now),
      now
    },
    policy: {
      plans,
      validations,
      policyStepSnapshots,
      policies,
      resolver: policyResolver(db, now),
      preferenceLearning,
      now
    },
    authorization: {
      plans,
      validations,
      policies,
      decisions,
      grants,
      preferenceLearning,
      now
    },
    decisionResume: {
      plans,
      validations,
      policies,
      decisions,
      grants,
      preferenceLearning,
      now
    },
    taskDag: {
      plans,
      validations,
      grants,
      taskDedupe: createRunScopedTaskDedupeStore(db),
      taskDags,
      objectives: objectives as {
        get(id: string): Promise<AuthoritativeObjective | null>;
      },
      now
    },
    jobs: {
      taskDags,
      runtime: governedJobs,
      now
    },
    execution: {
      taskDags,
      jobGraphs,
      runtime: governedJobs,
      now
    },
    completion: {
      plans,
      taskDags,
      jobGraphs,
      runtime: governedJobs,
      outcomes,
      now
    }
  });
}

export async function createAuthoritativeOrchestrationWorkerProcessFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const coordinator = createAuthoritativeExecutionCoordinatorFromEnv(env);
  return createDedicatedOrchestrationWorkerProcessFromEnv(coordinator, env);
}
