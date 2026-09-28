import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export type VerificationStrategy =
  | "execution"
  | "system"
  | "business"
  | "resource-start"
  | "resource-release"
  | "cost-reconciliation";

export type VerificationVerdict = "verified" | "failed" | "uncertain";

export type VerificationValue = string | number | boolean | null;

export type VerificationCheckOperator =
  | "exists"
  | "equals"
  | "not-equals"
  | "gte"
  | "lte"
  | "contains"
  | "truthy";

export interface VerificationContractCheck {
  id: string;
  key: string;
  operator: VerificationCheckOperator;
  expected?: VerificationValue;
  required: boolean;
  description?: string;
}

export interface VerificationContract {
  id: string;
  checks: readonly VerificationContractCheck[];
  contractHash: string;
}

export interface VerificationCheckResult {
  checkId: string;
  key: string;
  verdict: VerificationVerdict;
  actual?: VerificationValue;
  expected?: VerificationValue;
  evidenceIds: readonly string[];
  reason: string;
}

export interface VerifiedCurrentState {
  values: Readonly<Record<string, VerificationValue>>;
  sourceEvidenceIds: readonly string[];
  sourceEvidenceHashes: readonly string[];
  conflictingKeys: readonly string[];
  observedAt: string;
  stateHash: string;
}

export type VerificationSubjectType =
  | "task"
  | "job"
  | "outcome"
  | "resource"
  | "deployment"
  | "placement"
  | "allocation";

export interface VerificationSubject {
  type: VerificationSubjectType;
  id: string;
}

export interface VerificationRequest {
  id: string;
  correlationId?: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  subject: VerificationSubject;
  strategies: readonly VerificationStrategy[];
  requiresIndependentEvidence: boolean;
  executionIndependenceKey?: string;
  contract?: VerificationContract;
  maxEvidenceAgeSeconds: number;
  requestedAt: string;
  expiresAt: string;
  requestHash: string;
}

export type VerificationEvidenceResult = "pass" | "fail" | "unknown";

export interface VerificationEvidence {
  id: string;
  correlationId?: string;
  portfolioId: string;
  companyId: string;
  subject: VerificationSubject;
  strategy: VerificationStrategy;
  result: VerificationEvidenceResult;
  sourceType:
    | "system-probe"
    | "provider"
    | "worker"
    | "business-metric"
    | "human"
    | "resource-agent";
  sourceId: string;
  independenceKey: string;
  observedAt: string;
  expiresAt?: string;
  observations?: Readonly<Record<string, VerificationValue>>;
  payloadHash: string;
  provenance: string;
  confidence?: number;
  evidenceHash: string;
}

export interface VerificationStrategyResult {
  strategy: VerificationStrategy;
  verdict: VerificationVerdict;
  evidenceIds: readonly string[];
  evidenceHashes: readonly string[];
  reason: string;
}

export interface VerificationReceipt {
  id: string;
  correlationId?: string;
  requestId: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  subject: VerificationSubject;
  verdict: VerificationVerdict;
  strategyResults: readonly VerificationStrategyResult[];
  contractHash?: string;
  contractResults?: readonly VerificationCheckResult[];
  verifiedCurrentState?: VerifiedCurrentState;
  evidenceIds: readonly string[];
  evidenceHashes: readonly string[];
  verifiedAt: string;
  expiresAt: string;
  receiptHash: string;
}

function parseTime(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", label + " must be a valid timestamp");
  }
  return parsed;
}

function sameSubject(left: VerificationSubject, right: VerificationSubject) {
  return left.type === right.type && left.id === right.id;
}

function uniqueSorted<T extends string>(values: readonly T[]) {
  return [...new Set(values)].sort() as T[];
}


function isVerificationValue(value: unknown): value is VerificationValue {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function requiresExpected(operator: VerificationCheckOperator) {
  return ["equals", "not-equals", "gte", "lte", "contains"].includes(operator);
}

export function createVerificationContract(input: {
  id: string;
  checks: readonly Omit<VerificationContractCheck, "required">[]
    | readonly VerificationContractCheck[];
}): VerificationContract {
  if (!input.id.trim() || input.checks.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification contract requires an id and at least one check"
    );
  }

  const ids = new Set<string>();
  const checks = input.checks.map((raw) => {
    const check = {
      ...raw,
      required: "required" in raw ? raw.required : true
    } as VerificationContractCheck;

    if (!check.id.trim() || !check.key.trim() || ids.has(check.id)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Verification contract check ids and keys must be non-empty and ids must be unique"
      );
    }
    ids.add(check.id);

    if (requiresExpected(check.operator) && !isVerificationValue(check.expected)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `Verification check ${check.id} requires an expected primitive value`
      );
    }
    if (
      ["gte", "lte"].includes(check.operator)
      && typeof check.expected !== "number"
    ) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `Verification check ${check.id} requires a numeric expected value`
      );
    }
    if (check.operator === "contains" && typeof check.expected !== "string") {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `Verification check ${check.id} requires a string expected value`
      );
    }

    return Object.freeze({ ...check });
  });

  const base = {
    id: input.id,
    checks: Object.freeze(checks)
  };
  return Object.freeze({
    ...base,
    contractHash: sha256Hex(base)
  });
}

export function assertVerificationContractIntegrity(contract: VerificationContract) {
  const { contractHash, ...base } = contract;
  if (sha256Hex(base) !== contractHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification contract integrity check failed"
    );
  }
  return contract;
}

export function assertVerifiedCurrentStateIntegrity(state: VerifiedCurrentState) {
  const { stateHash, ...base } = state;
  if (sha256Hex(base) !== stateHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verified current state integrity check failed"
    );
  }
  return state;
}

export function evaluateVerificationCheck(
  check: VerificationContractCheck,
  currentState: VerifiedCurrentState | undefined
): VerificationCheckResult {
  const evidenceIds = currentState?.sourceEvidenceIds ?? [];
  const actual = currentState?.values[check.key];

  if (currentState?.conflictingKeys.includes(check.key)) {
    return Object.freeze({
      checkId: check.id,
      key: check.key,
      verdict: "uncertain" as const,
      actual,
      expected: check.expected,
      evidenceIds,
      reason: "Fresh authoritative evidence conflicts for this current-state key"
    });
  }

  if (actual === undefined) {
    return Object.freeze({
      checkId: check.id,
      key: check.key,
      verdict: check.required ? "uncertain" as const : "verified" as const,
      expected: check.expected,
      evidenceIds,
      reason: check.required
        ? "Required current-state observation is missing"
        : "Optional current-state observation is absent"
    });
  }

  let passes = false;
  switch (check.operator) {
    case "exists":
      passes = true;
      break;
    case "equals":
      passes = Object.is(actual, check.expected);
      break;
    case "not-equals":
      passes = !Object.is(actual, check.expected);
      break;
    case "gte":
      passes = typeof actual === "number"
        && typeof check.expected === "number"
        && actual >= check.expected;
      break;
    case "lte":
      passes = typeof actual === "number"
        && typeof check.expected === "number"
        && actual <= check.expected;
      break;
    case "contains":
      passes = typeof actual === "string"
        && typeof check.expected === "string"
        && actual.includes(check.expected);
      break;
    case "truthy":
      passes = actual === true;
      break;
  }

  return Object.freeze({
    checkId: check.id,
    key: check.key,
    verdict: passes ? "verified" as const : "failed" as const,
    actual,
    expected: check.expected,
    evidenceIds,
    reason: passes
      ? "Verified current state satisfies the contract check"
      : "Verified current state does not satisfy the contract check"
  });
}

function assertConfidence(confidence?: number) {
  if (
    confidence !== undefined
    && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification evidence confidence must be between 0 and 1"
    );
  }
}

export function createVerificationRequest(
  input: Omit<VerificationRequest, "requestHash">
): VerificationRequest {
  const requestedAt = parseTime(input.requestedAt, "Verification requestedAt");
  if (input.contract) assertVerificationContractIntegrity(input.contract);
  const expiresAt = parseTime(input.expiresAt, "Verification expiresAt");

  if (expiresAt <= requestedAt) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification request must expire after it is created"
    );
  }
  if (!Number.isFinite(input.maxEvidenceAgeSeconds) || input.maxEvidenceAgeSeconds < 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification max evidence age must be non-negative"
    );
  }

  const strategies = Object.freeze(uniqueSorted(input.strategies));
  if (strategies.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification request requires at least one strategy"
    );
  }
  if (input.requiresIndependentEvidence && !input.executionIndependenceKey) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Independent verification requires the execution independence key"
    );
  }

  const base: Omit<VerificationRequest, "requestHash"> = {
    ...input,
    subject: Object.freeze({ ...input.subject }),
    strategies
  };
  return Object.freeze({
    ...base,
    requestHash: sha256Hex(base)
  });
}

export function assertVerificationRequestIntegrity(request: VerificationRequest) {
  const { requestHash, ...base } = request;
  if (sha256Hex(base) !== requestHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification request integrity check failed"
    );
  }
}

export function createVerificationEvidence(
  input: Omit<VerificationEvidence, "evidenceHash">
): VerificationEvidence {
  parseTime(input.observedAt, "Verification evidence observedAt");
  if (input.expiresAt) {
    const expiresAt = parseTime(input.expiresAt, "Verification evidence expiresAt");
    if (expiresAt <= Date.parse(input.observedAt)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "Verification evidence must expire after observation"
      );
    }
  }
  if (!input.payloadHash || !input.provenance || !input.sourceId || !input.independenceKey) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      "Verification evidence requires source, independence, provenance, and payload hash"
    );
  }
  assertConfidence(input.confidence);
  if (input.observations) {
    for (const [key, value] of Object.entries(input.observations)) {
      if (!key.trim() || !isVerificationValue(value) || (typeof value === "number" && !Number.isFinite(value))) {
        throw new ControlPlaneError(
          "VALIDATION_FAILED",
          "Verification observations require non-empty keys and finite primitive values"
        );
      }
    }
  }

  const base: Omit<VerificationEvidence, "evidenceHash"> = {
    ...input,
    subject: Object.freeze({ ...input.subject })
  };
  return Object.freeze({
    ...base,
    evidenceHash: sha256Hex(base)
  });
}

export function assertVerificationEvidenceIntegrity(evidence: VerificationEvidence) {
  const { evidenceHash, ...base } = evidence;
  if (sha256Hex(base) !== evidenceHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification evidence integrity check failed"
    );
  }
}

export function isVerificationEvidenceFresh(
  request: VerificationRequest,
  evidence: VerificationEvidence,
  now = Date.now()
) {
  const observedAt = Date.parse(evidence.observedAt);
  const evidenceExpiresAt = evidence.expiresAt ? Date.parse(evidence.expiresAt) : Infinity;
  return (
    Number.isFinite(observedAt)
    && observedAt <= now
    && now - observedAt <= request.maxEvidenceAgeSeconds * 1000
    && evidenceExpiresAt > now
  );
}

function validateEvidenceForRequest(
  request: VerificationRequest,
  evidence: VerificationEvidence,
  now: number
) {
  assertVerificationEvidenceIntegrity(evidence);

  if (
    evidence.portfolioId !== request.portfolioId
    || evidence.companyId !== request.companyId
    || !sameSubject(evidence.subject, request.subject)
    || !request.strategies.includes(evidence.strategy)
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification evidence is outside the authoritative request scope"
    );
  }

  return isVerificationEvidenceFresh(request, evidence, now);
}

function resolveStrategy(
  request: VerificationRequest,
  strategy: VerificationStrategy,
  evidence: readonly VerificationEvidence[],
  now: number
): VerificationStrategyResult {
  const matching = evidence.filter((item) => {
    if (item.strategy !== strategy) return false;
    if (!validateEvidenceForRequest(request, item, now)) return false;
    if (
      request.requiresIndependentEvidence
      && item.independenceKey === request.executionIndependenceKey
    ) {
      return false;
    }
    return true;
  });

  const failures = matching.filter((item) => item.result === "fail");
  const passes = matching.filter((item) => item.result === "pass");

  if (failures.length > 0) {
    return Object.freeze({
      strategy,
      verdict: "failed",
      evidenceIds: Object.freeze(failures.map((item) => item.id).sort()),
      evidenceHashes: Object.freeze(failures.map((item) => item.evidenceHash).sort()),
      reason: "Fresh authoritative evidence reported failure"
    });
  }

  if (passes.length > 0) {
    return Object.freeze({
      strategy,
      verdict: "verified",
      evidenceIds: Object.freeze(passes.map((item) => item.id).sort()),
      evidenceHashes: Object.freeze(passes.map((item) => item.evidenceHash).sort()),
      reason: request.requiresIndependentEvidence
        ? "Fresh independent evidence verified the strategy"
        : "Fresh evidence verified the strategy"
    });
  }

  return Object.freeze({
    strategy,
    verdict: "uncertain",
    evidenceIds: Object.freeze([]),
    evidenceHashes: Object.freeze([]),
    reason: request.requiresIndependentEvidence
      ? "No fresh independent passing evidence is available"
      : "No fresh passing evidence is available"
  });
}

function eligibleEvidenceForCurrentState(
  request: VerificationRequest,
  evidence: readonly VerificationEvidence[],
  now: number
) {
  return evidence.filter((item) => {
    if (!request.strategies.includes(item.strategy)) return false;
    if (!validateEvidenceForRequest(request, item, now)) return false;
    if (
      request.requiresIndependentEvidence
      && item.independenceKey === request.executionIndependenceKey
    ) {
      return false;
    }
    return item.result !== "unknown";
  });
}

function buildVerifiedCurrentState(
  request: VerificationRequest,
  evidence: readonly VerificationEvidence[],
  now: number
): VerifiedCurrentState | undefined {
  const eligible = eligibleEvidenceForCurrentState(request, evidence, now)
    .filter((item) => item.observations && Object.keys(item.observations).length > 0);

  if (eligible.length === 0) return undefined;

  const latest = new Map<string, {
    observedAt: number;
    value: VerificationValue;
    evidenceIds: string[];
    evidenceHashes: string[];
    conflict: boolean;
  }>();

  for (const item of eligible) {
    const observedAt = Date.parse(item.observedAt);
    for (const [key, value] of Object.entries(item.observations ?? {})) {
      const current = latest.get(key);
      if (!current || observedAt > current.observedAt) {
        latest.set(key, {
          observedAt,
          value,
          evidenceIds: [item.id],
          evidenceHashes: [item.evidenceHash],
          conflict: false
        });
        continue;
      }
      if (observedAt === current.observedAt) {
        current.evidenceIds.push(item.id);
        current.evidenceHashes.push(item.evidenceHash);
        if (!Object.is(current.value, value)) current.conflict = true;
      }
    }
  }

  const values: Record<string, VerificationValue> = {};
  const sourceEvidenceIds = new Set<string>();
  const sourceEvidenceHashes = new Set<string>();
  const conflictingKeys: string[] = [];
  let observedAt = 0;

  for (const key of [...latest.keys()].sort()) {
    const entry = latest.get(key)!;
    values[key] = entry.value;
    observedAt = Math.max(observedAt, entry.observedAt);
    entry.evidenceIds.forEach((id) => sourceEvidenceIds.add(id));
    entry.evidenceHashes.forEach((hash) => sourceEvidenceHashes.add(hash));
    if (entry.conflict) conflictingKeys.push(key);
  }

  const base = {
    values: Object.freeze(values),
    sourceEvidenceIds: Object.freeze([...sourceEvidenceIds].sort()),
    sourceEvidenceHashes: Object.freeze([...sourceEvidenceHashes].sort()),
    conflictingKeys: Object.freeze(conflictingKeys.sort()),
    observedAt: new Date(observedAt).toISOString()
  };
  return Object.freeze({
    ...base,
    stateHash: sha256Hex(base)
  });
}

export function resolveVerificationRequest(
  request: VerificationRequest,
  evidence: readonly VerificationEvidence[],
  input: {
    receiptId: string;
    verifiedAt?: string;
    receiptTtlSeconds?: number;
  }
): VerificationReceipt {
  assertVerificationRequestIntegrity(request);

  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const now = parseTime(verifiedAt, "Verification receipt verifiedAt");
  const requestExpiresAt = Date.parse(request.expiresAt);

  if (now >= requestExpiresAt) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification request is expired"
    );
  }

  const results = request.strategies.map((strategy) =>
    resolveStrategy(request, strategy, evidence, now)
  );
  const verifiedCurrentState = buildVerifiedCurrentState(request, evidence, now);
  const contractResults = request.contract
    ? request.contract.checks.map((check) =>
        evaluateVerificationCheck(check, verifiedCurrentState)
      )
    : undefined;
  const requiredContractResults = request.contract
    ? contractResults!.filter((_result, index) => request.contract!.checks[index].required)
    : [];

  const strategyFailed = results.some((item) => item.verdict === "failed");
  const strategiesVerified = results.every((item) => item.verdict === "verified");
  const contractFailed = requiredContractResults.some((item) => item.verdict === "failed");
  const contractVerified = requiredContractResults.every((item) => item.verdict === "verified");

  const verdict: VerificationVerdict = strategyFailed || contractFailed
    ? "failed"
    : strategiesVerified && contractVerified
      ? "verified"
      : "uncertain";

  const evidenceIds = uniqueSorted([
    ...results.flatMap((item) => item.evidenceIds),
    ...(verifiedCurrentState?.sourceEvidenceIds ?? [])
  ]);
  const evidenceHashes = uniqueSorted([
    ...results.flatMap((item) => item.evidenceHashes),
    ...(verifiedCurrentState?.sourceEvidenceHashes ?? [])
  ]);
  const ttlSeconds = Math.max(1, input.receiptTtlSeconds ?? request.maxEvidenceAgeSeconds);
  const expiresAtMs = Math.min(requestExpiresAt, now + ttlSeconds * 1000);

  const base: Omit<VerificationReceipt, "receiptHash"> = {
    id: input.receiptId,
    correlationId: request.correlationId,
    requestId: request.id,
    portfolioId: request.portfolioId,
    companyId: request.companyId,
    environment: request.environment,
    subject: Object.freeze({ ...request.subject }),
    verdict,
    strategyResults: Object.freeze(results),
    ...(request.contract ? {
      contractHash: request.contract.contractHash,
      contractResults: Object.freeze(contractResults!),
      verifiedCurrentState
    } : {}),
    evidenceIds: Object.freeze(evidenceIds),
    evidenceHashes: Object.freeze(evidenceHashes),
    verifiedAt,
    expiresAt: new Date(expiresAtMs).toISOString()
  };

  return Object.freeze({
    ...base,
    receiptHash: sha256Hex(base)
  });
}

export function assertVerificationReceiptIntegrity(receipt: VerificationReceipt) {
  const { receiptHash, ...base } = receipt;
  if (sha256Hex(base) !== receiptHash) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification receipt integrity check failed"
    );
  }
  if (receipt.verifiedCurrentState) {
    assertVerifiedCurrentStateIntegrity(receipt.verifiedCurrentState);
  }
  return receipt;
}

export function assertVerificationReceipt(
  receipt: VerificationReceipt,
  input: {
    scope: TrustedExecutionScope;
    subject: VerificationSubject;
    now?: number;
    allowedVerdicts?: readonly VerificationVerdict[];
  }
) {
  assertVerificationReceiptIntegrity(receipt);

  const now = input.now ?? Date.now();
  if (
    receipt.portfolioId !== input.scope.portfolioId
    || receipt.companyId !== input.scope.companyId
    || receipt.environment !== input.scope.environment
    || !sameSubject(receipt.subject, input.subject)
    || Date.parse(receipt.verifiedAt) > now
    || Date.parse(receipt.expiresAt) <= now
  ) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification receipt is stale or outside authoritative scope"
    );
  }

  const allowed = input.allowedVerdicts ?? ["verified"];
  if (!allowed.includes(receipt.verdict)) {
    throw new ControlPlaneError(
      "FORBIDDEN",
      "Verification receipt verdict does not authorize this transition"
    );
  }

  return receipt;
}


export interface VerificationReceiptStore {
  getReceipt(id: string): Promise<VerificationReceipt | null>;
}

export async function requireAuthoritativeVerificationReceipt(
  store: VerificationReceiptStore,
  receiptId: string,
  input: Parameters<typeof assertVerificationReceipt>[1]
) {
  const receipt = await store.getReceipt(receiptId);
  if (!receipt) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      "Authoritative verification receipt was not found"
    );
  }

  assertVerificationReceipt(receipt, input);
  return receipt;
}
