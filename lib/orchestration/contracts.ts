import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const ORCHESTRATION_CONTRACT_VERSION = "1.2.0";

export type OrchestrationSourceType =
  | "owner-intent"
  | "signal"
  | "investigation"
  | "objective";

export interface OrchestrationSourceRef {
  type: OrchestrationSourceType;
  id: string;
  sourceHash: string;
}

export type OrchestrationState =
  | "accepted"
  | "context-ready"
  | "planning"
  | "planned"
  | "validated"
  | "policy-evaluated"
  | "awaiting-decision"
  | "authorized"
  | "tasks-created"
  | "jobs-enqueued"
  | "executing"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type OrchestrationResumeTrigger =
  | "initial"
  | "worker-resume"
  | "decision-resolved"
  | "retry";

export interface IntegrityRef {
  id: string;
  hash: string;
}

export interface AuthorizationGrantRef extends IntegrityRef {
  disposition: "AUTO" | "APPROVAL_REQUIRED" | "STRONG_APPROVAL";
}

export interface TaskRef extends IntegrityRef {
  authorizationConsumptionHash: string;
}

export interface VerifiedOutcomeRef {
  id: string;
  verificationReceiptId: string;
  verificationReceiptHash: string;
}

export interface OrchestrationCheckpoints {
  contextSnapshot?: IntegrityRef;
  plannerInput?: IntegrityRef;
  plan?: IntegrityRef;
  validationReceipt?: IntegrityRef;
  policySnapshot?: IntegrityRef;
  taskDag?: IntegrityRef;
  decisionIds: readonly string[];
  authorizationGrants: readonly AuthorizationGrantRef[];
  tasks: readonly TaskRef[];
  jobIds: readonly string[];
  verificationRequestIds: readonly string[];
  verifiedOutcomes: readonly VerifiedOutcomeRef[];
}

export interface OrchestrationFailure {
  code: string;
  message: string;
  retryable: boolean;
  failedAt: string;
}

export interface OrchestrationRunRecord {
  id: string;
  correlationId: string;
  source: OrchestrationSourceRef;
  scope: TrustedExecutionScope;
  state: OrchestrationState;
  /**
   * Coordination is intentionally non-authoritative. The coordinator may
   * reference Decisions, approval proofs, grants, Tasks, Jobs, verification,
   * and Outcomes, but it may never mint execution authority by itself.
   */
  authority: "coordination-only";
  checkpoints: OrchestrationCheckpoints;
  failure?: OrchestrationFailure;
  blockedReason?: string;
  version: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  recordHash: string;
}

export interface OrchestrationRunStoreDescriptor {
  persistence: "durable-external" | "ephemeral-reference";
  compareAndSwap: boolean;
  uniqueCorrelationId: boolean;
  restartSafe: boolean;
  multiProcessSafe: boolean;
  productionEligible: boolean;
}

export interface OrchestrationRunStore {
  readonly descriptor: OrchestrationRunStoreDescriptor;
  create(
    record: OrchestrationRunRecord,
    idempotencyKey: string
  ): Promise<{
    status: "created" | "idempotent-replay";
    record: OrchestrationRunRecord;
  }>;
  get(id: string): Promise<OrchestrationRunRecord | null>;
  getByCorrelationId(correlationId: string): Promise<OrchestrationRunRecord | null>;
  compareAndSwap(
    next: OrchestrationRunRecord,
    input: {
      expectedVersion: number;
      expectedRecordHash: string;
      idempotencyKey: string;
    }
  ): Promise<OrchestrationRunRecord>;
  listResumable(input: {
    limit: number;
    states?: readonly OrchestrationState[];
  }): Promise<readonly OrchestrationRunRecord[]>;
}

export interface StartOrchestrationInput {
  id: string;
  correlationId: string;
  source: OrchestrationSourceRef;
  scope: TrustedExecutionScope;
  idempotencyKey: string;
  receivedAt: string;
}

export interface ResumeOrchestrationInput {
  runId: string;
  correlationId: string;
  expectedVersion: number;
  expectedRecordHash: string;
  trigger: OrchestrationResumeTrigger;
  idempotencyKey: string;
}

export interface NervousSystemCoordinator {
  /**
   * Persist or idempotently replay the orchestration run, then schedule the
   * existing durable runtime to advance it. This must not synchronously wait
   * for planning or execution to finish.
   */
  start(input: StartOrchestrationInput): Promise<OrchestrationRunRecord>;

  /**
   * Resume from the exact persisted checkpoint. Completed stages must not be
   * replayed simply because a worker restarted.
   */
  resume(input: ResumeOrchestrationInput): Promise<OrchestrationRunRecord>;
}

const transitions: Record<OrchestrationState, readonly OrchestrationState[]> = {
  "accepted": ["context-ready", "blocked", "failed", "cancelled"],
  "context-ready": ["planning", "blocked", "failed", "cancelled"],
  "planning": ["planned", "blocked", "failed", "cancelled"],
  "planned": ["validated", "blocked", "failed", "cancelled"],
  "validated": ["policy-evaluated", "blocked", "failed", "cancelled"],
  "policy-evaluated": ["awaiting-decision", "authorized", "blocked", "failed", "cancelled"],
  "awaiting-decision": ["authorized", "blocked", "failed", "cancelled"],
  "authorized": ["tasks-created", "blocked", "failed", "cancelled"],
  "tasks-created": ["jobs-enqueued", "blocked", "failed", "cancelled"],
  "jobs-enqueued": ["executing", "blocked", "failed", "cancelled"],
  "executing": ["verifying", "blocked", "failed", "cancelled"],
  "verifying": ["completed", "blocked", "failed", "cancelled"],
  "completed": [],
  "blocked": [],
  "failed": [],
  "cancelled": []
};

const terminalStates = new Set<OrchestrationState>([
  "completed",
  "blocked",
  "failed",
  "cancelled"
]);

function requireNonEmpty(value: string, label: string) {
  if (!value.trim()) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is required`);
  }
  return value;
}

function parseTimestamp(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed;
}

function freezeCheckpoints(
  checkpoints: OrchestrationCheckpoints
): OrchestrationCheckpoints {
  return Object.freeze({
    contextSnapshot: checkpoints.contextSnapshot
      ? Object.freeze({ ...checkpoints.contextSnapshot })
      : undefined,
    plannerInput: checkpoints.plannerInput
      ? Object.freeze({ ...checkpoints.plannerInput })
      : undefined,
    plan: checkpoints.plan ? Object.freeze({ ...checkpoints.plan }) : undefined,
    validationReceipt: checkpoints.validationReceipt
      ? Object.freeze({ ...checkpoints.validationReceipt })
      : undefined,
    policySnapshot: checkpoints.policySnapshot
      ? Object.freeze({ ...checkpoints.policySnapshot })
      : undefined,
    taskDag: checkpoints.taskDag
      ? Object.freeze({ ...checkpoints.taskDag })
      : undefined,
    decisionIds: Object.freeze([...checkpoints.decisionIds]),
    authorizationGrants: Object.freeze(
      checkpoints.authorizationGrants.map((item) => Object.freeze({ ...item }))
    ),
    tasks: Object.freeze(
      checkpoints.tasks.map((item) => Object.freeze({ ...item }))
    ),
    jobIds: Object.freeze([...checkpoints.jobIds]),
    verificationRequestIds: Object.freeze([...checkpoints.verificationRequestIds]),
    verifiedOutcomes: Object.freeze(
      checkpoints.verifiedOutcomes.map((item) => Object.freeze({ ...item }))
    )
  });
}

function emptyCheckpoints(): OrchestrationCheckpoints {
  return freezeCheckpoints({
    decisionIds: [],
    authorizationGrants: [],
    tasks: [],
    jobIds: [],
    verificationRequestIds: [],
    verifiedOutcomes: []
  });
}

function assertIntegrityRef(ref: IntegrityRef, label: string) {
  requireNonEmpty(ref.id, `${label}.id`);
  requireNonEmpty(ref.hash, `${label}.hash`);
}

function assertCheckpointRequirements(
  state: OrchestrationState,
  checkpoints: OrchestrationCheckpoints
) {
  if (
    [
      "context-ready",
      "planning",
      "planned",
      "validated",
      "policy-evaluated",
      "awaiting-decision",
      "authorized",
      "tasks-created",
      "jobs-enqueued",
      "executing",
      "verifying",
      "completed"
    ].includes(state)
  ) {
    if (!checkpoints.contextSnapshot) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Orchestration state ${state} requires a frozen context snapshot`
      );
    }
    assertIntegrityRef(checkpoints.contextSnapshot, "contextSnapshot");
  }

  if (
    [
      "planning",
      "planned",
      "validated",
      "policy-evaluated",
      "awaiting-decision",
      "authorized",
      "tasks-created",
      "jobs-enqueued",
      "executing",
      "verifying",
      "completed"
    ].includes(state)
  ) {
    if (!checkpoints.plannerInput) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Orchestration state ${state} requires a frozen planner input`
      );
    }
    assertIntegrityRef(checkpoints.plannerInput, "plannerInput");
  }

  if (
    [
      "planned",
      "validated",
      "policy-evaluated",
      "awaiting-decision",
      "authorized",
      "tasks-created",
      "jobs-enqueued",
      "executing",
      "verifying",
      "completed"
    ].includes(state)
  ) {
    if (!checkpoints.plan) {
      throw new ControlPlaneError("CONFLICT", `Orchestration state ${state} requires a plan`);
    }
    assertIntegrityRef(checkpoints.plan, "plan");
  }

  if (
    [
      "validated",
      "policy-evaluated",
      "awaiting-decision",
      "authorized",
      "tasks-created",
      "jobs-enqueued",
      "executing",
      "verifying",
      "completed"
    ].includes(state)
  ) {
    if (!checkpoints.validationReceipt) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Orchestration state ${state} requires a validation receipt`
      );
    }
    assertIntegrityRef(checkpoints.validationReceipt, "validationReceipt");
  }

  if (
    [
      "policy-evaluated",
      "awaiting-decision",
      "authorized",
      "tasks-created",
      "jobs-enqueued",
      "executing",
      "verifying",
      "completed"
    ].includes(state)
  ) {
    if (!checkpoints.policySnapshot) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Orchestration state ${state} requires a policy snapshot`
      );
    }
    assertIntegrityRef(checkpoints.policySnapshot, "policySnapshot");
  }

  if (state === "awaiting-decision" && checkpoints.decisionIds.length === 0) {
    throw new ControlPlaneError(
      "CONFLICT",
      "awaiting-decision requires at least one authoritative Decision reference"
    );
  }

  if (
    [
      "authorized",
      "tasks-created",
      "jobs-enqueued",
      "executing",
      "verifying",
      "completed"
    ].includes(state)
    && checkpoints.authorizationGrants.length === 0
  ) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Orchestration state ${state} requires authorization grant lineage`
    );
  }

  for (const grant of checkpoints.authorizationGrants) {
    assertIntegrityRef(grant, "authorizationGrant");
  }

  if (
    ["tasks-created", "jobs-enqueued", "executing", "verifying", "completed"].includes(state)
    && checkpoints.tasks.length === 0
  ) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Orchestration state ${state} requires generated Task lineage`
    );
  }

  for (const task of checkpoints.tasks) {
    assertIntegrityRef(task, "task");
    requireNonEmpty(task.authorizationConsumptionHash, "task.authorizationConsumptionHash");
  }

  if (
    ["tasks-created", "jobs-enqueued", "executing", "verifying", "completed"].includes(state)
  ) {
    if (!checkpoints.taskDag) {
      throw new ControlPlaneError(
        "CONFLICT",
        `Orchestration state ${state} requires a Task DAG checkpoint`
      );
    }
    assertIntegrityRef(checkpoints.taskDag, "taskDag");
  }

  if (
    ["jobs-enqueued", "executing", "verifying", "completed"].includes(state)
    && checkpoints.jobIds.length === 0
  ) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Orchestration state ${state} requires durable Job lineage`
    );
  }

  if (
    ["verifying", "completed"].includes(state)
    && checkpoints.verificationRequestIds.length === 0
  ) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Orchestration state ${state} requires verification request lineage`
    );
  }

  if (state === "completed" && checkpoints.verifiedOutcomes.length === 0) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Completed orchestration requires at least one independently verified Outcome"
    );
  }

  for (const outcome of checkpoints.verifiedOutcomes) {
    requireNonEmpty(outcome.id, "verifiedOutcome.id");
    requireNonEmpty(outcome.verificationReceiptId, "verifiedOutcome.verificationReceiptId");
    requireNonEmpty(outcome.verificationReceiptHash, "verifiedOutcome.verificationReceiptHash");
  }
}

function recordBase(
  record: Omit<OrchestrationRunRecord, "recordHash">
) {
  return {
    ...record,
    source: Object.freeze({ ...record.source }),
    scope: Object.freeze({ ...record.scope }),
    checkpoints: freezeCheckpoints(record.checkpoints),
    failure: record.failure ? Object.freeze({ ...record.failure }) : undefined
  };
}

export function createOrchestrationSourceRef(
  type: OrchestrationSourceType,
  id: string,
  sourceRecord: unknown
): OrchestrationSourceRef {
  requireNonEmpty(id, "source.id");
  return Object.freeze({
    type,
    id,
    sourceHash: sha256Hex(sourceRecord)
  });
}

export function createOrchestrationRun(
  input: Omit<
    OrchestrationRunRecord,
    "state" | "authority" | "checkpoints" | "version" | "attempt" | "recordHash"
  > & {
    checkpoints?: OrchestrationCheckpoints;
  }
): OrchestrationRunRecord {
  requireNonEmpty(input.id, "orchestration.id");
  requireNonEmpty(input.correlationId, "orchestration.correlationId");
  requireNonEmpty(input.source.id, "orchestration.source.id");
  requireNonEmpty(input.source.sourceHash, "orchestration.source.sourceHash");
  requireNonEmpty(input.scope.userId, "orchestration.scope.userId");
  requireNonEmpty(input.scope.portfolioId, "orchestration.scope.portfolioId");
  requireNonEmpty(input.scope.companyId, "orchestration.scope.companyId");

  const createdAt = parseTimestamp(input.createdAt, "orchestration.createdAt");
  const updatedAt = parseTimestamp(input.updatedAt, "orchestration.updatedAt");
  if (updatedAt < createdAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "orchestration.updatedAt cannot precede createdAt"
    );
  }

  const base = recordBase({
    ...input,
    state: "accepted",
    authority: "coordination-only",
    checkpoints: input.checkpoints ?? emptyCheckpoints(),
    version: 1,
    attempt: 1,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString()
  });

  assertCheckpointRequirements(base.state, base.checkpoints);
  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function assertOrchestrationRunIntegrity(record: OrchestrationRunRecord) {
  const { recordHash, ...raw } = record;
  const base = recordBase(raw);
  if (
    record.authority !== "coordination-only"
    || sha256Hex(base) !== recordHash
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Orchestration run integrity or authority boundary is invalid",
      { correlationId: record.correlationId }
    );
  }

  if (
    !Number.isInteger(record.version)
    || record.version < 1
    || !Number.isInteger(record.attempt)
    || record.attempt < 1
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Orchestration version and attempt must be positive integers",
      { correlationId: record.correlationId }
    );
  }

  parseTimestamp(record.createdAt, "orchestration.createdAt");
  parseTimestamp(record.updatedAt, "orchestration.updatedAt");
  assertCheckpointRequirements(record.state, record.checkpoints);

  if (record.state === "failed") {
    if (!record.failure) {
      throw new ControlPlaneError(
        "CONFLICT",
        "Failed orchestration requires failure evidence",
        { correlationId: record.correlationId }
      );
    }
    requireNonEmpty(record.failure.code, "orchestration.failure.code");
    requireNonEmpty(record.failure.message, "orchestration.failure.message");
    parseTimestamp(record.failure.failedAt, "orchestration.failure.failedAt");
  }

  if (record.state === "blocked" && !record.blockedReason?.trim()) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Blocked orchestration requires a reason",
      { correlationId: record.correlationId }
    );
  }

  return record;
}

export function canTransitionOrchestration(
  from: OrchestrationState,
  to: OrchestrationState
) {
  return transitions[from].includes(to);
}

export function transitionOrchestrationRun(
  current: OrchestrationRunRecord,
  input: {
    to: OrchestrationState;
    now: string;
    checkpointPatch?: Partial<OrchestrationCheckpoints>;
    failure?: OrchestrationFailure;
    blockedReason?: string;
    incrementAttempt?: boolean;
  }
): OrchestrationRunRecord {
  assertOrchestrationRunIntegrity(current);

  if (!canTransitionOrchestration(current.state, input.to)) {
    throw new ControlPlaneError(
      "CONFLICT",
      `Invalid orchestration transition: ${current.state} -> ${input.to}`,
      { correlationId: current.correlationId }
    );
  }

  const now = parseTimestamp(input.now, "orchestration transition time");
  if (now < Date.parse(current.updatedAt)) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Orchestration transition cannot move time backward",
      { correlationId: current.correlationId }
    );
  }

  const checkpointPatch = input.checkpointPatch ?? {};
  const checkpoints = freezeCheckpoints({
    contextSnapshot: checkpointPatch.contextSnapshot ?? current.checkpoints.contextSnapshot,
    plannerInput: checkpointPatch.plannerInput ?? current.checkpoints.plannerInput,
    plan: checkpointPatch.plan ?? current.checkpoints.plan,
    validationReceipt:
      checkpointPatch.validationReceipt ?? current.checkpoints.validationReceipt,
    policySnapshot: checkpointPatch.policySnapshot ?? current.checkpoints.policySnapshot,
    taskDag: checkpointPatch.taskDag ?? current.checkpoints.taskDag,
    decisionIds: checkpointPatch.decisionIds ?? current.checkpoints.decisionIds,
    authorizationGrants:
      checkpointPatch.authorizationGrants ?? current.checkpoints.authorizationGrants,
    tasks: checkpointPatch.tasks ?? current.checkpoints.tasks,
    jobIds: checkpointPatch.jobIds ?? current.checkpoints.jobIds,
    verificationRequestIds:
      checkpointPatch.verificationRequestIds ?? current.checkpoints.verificationRequestIds,
    verifiedOutcomes:
      checkpointPatch.verifiedOutcomes ?? current.checkpoints.verifiedOutcomes
  });

  assertCheckpointRequirements(input.to, checkpoints);

  if (input.to === "failed" && !input.failure) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Failed orchestration transition requires failure evidence",
      { correlationId: current.correlationId }
    );
  }

  if (input.to === "blocked" && !input.blockedReason?.trim()) {
    throw new ControlPlaneError(
      "CONFLICT",
      "Blocked orchestration transition requires a reason",
      { correlationId: current.correlationId }
    );
  }

  const { recordHash: _currentRecordHash, ...currentWithoutHash } = current;
  const base = recordBase({
    ...currentWithoutHash,
    state: input.to,
    checkpoints,
    failure: input.to === "failed" ? input.failure : undefined,
    blockedReason: input.to === "blocked" ? input.blockedReason : undefined,
    version: current.version + 1,
    attempt: current.attempt + (input.incrementAttempt ? 1 : 0),
    updatedAt: new Date(now).toISOString()
  });

  return Object.freeze({ ...base, recordHash: sha256Hex(base) });
}

export function isOrchestrationTerminal(state: OrchestrationState) {
  return terminalStates.has(state);
}

export function isOrchestrationWorkerResumable(record: OrchestrationRunRecord) {
  assertOrchestrationRunIntegrity(record);
  // awaiting-decision is safe to recover: the worker can only advance after
  // re-reading the authoritative Decision and exact approval proof.
  return !isOrchestrationTerminal(record.state);
}

export function assertProductionOrchestrationRunStoreDescriptor(
  descriptor: OrchestrationRunStoreDescriptor
) {
  if (
    descriptor.persistence !== "durable-external"
    || !descriptor.compareAndSwap
    || !descriptor.uniqueCorrelationId
    || !descriptor.restartSafe
    || !descriptor.multiProcessSafe
    || !descriptor.productionEligible
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Production orchestration requires durable CAS persistence, correlation uniqueness, restart safety, and multi-process safety"
    );
  }
  return descriptor;
}
