import type { TrustedActor } from "@/lib/control-plane/request-context";
import type { StepUpProof } from "@/lib/authorization/proofs";
import type { StepUpChallenge } from "@/lib/auth/contracts";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { VerificationRequestRecord } from "@/lib/domain/services/verification-service";
import type { Resource } from "@/lib/domain/resources";
import type { ResourceEnrollmentRecord } from "@/lib/resources/enrollment";
import type {
  OwnerFailurePresentation,
  OwnerOperationExplanation
} from "@/lib/explainability/job-owner-explanation";
import type { ObjectiveIntakeInput, ObjectiveRecord } from "@/lib/domain/objective-inbox";
import type {
  ConfirmedPreferenceRule,
  LearnedRuleSuggestion,
  PreferenceSuggestionResolution,
  PreferenceSuggestionResolutionResult
} from "@/lib/domain/preference-learning";

export const CONTROL_API_SURFACE_VERSION = "1.6.0";

export type ControlApiRole = "owner" | "admin" | "operator" | "viewer";

export interface ControlApiPrincipal {
  actor: TrustedActor;
  scope: TrustedExecutionScope;
  sessionId: string;
  role: ControlApiRole;
  /** Server-resolved evidence only. Never accept this proof from request JSON. */
  stepUpProof?: StepUpProof;
}

export interface OwnerIntentInput {
  message: string;
  channel?: "chat" | "api";
}

export interface OwnerIntentRecord {
  id: string;
  correlationId?: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  userId: string;
  message: string;
  channel: "chat" | "api";
  status: "accepted";
  receivedAt: string;
}

export interface DecisionMutationInput {
  decisionId: string;
  action: "approve" | "modify" | "reject";
  note?: string;
  idempotencyKey: string;
}

export interface ResourceDiscoveryInput {
  id: string;
  type: Resource["type"];
  providerId?: string;
  poolId?: string;
  capabilityNames?: readonly string[];
  failureDomainIds?: readonly string[];
  credentialBindingIds?: readonly string[];
  policyBindingIds?: readonly string[];
  region?: string;
  architecture?: string;
  idempotencyKey: string;
}

export interface ResourceEnrollmentStartInput {
  id: string;
  requestedType: Resource["type"];
  ownerActionRequired: boolean;
  ownerActionDescription?: string;
  challengeToken: string;
  challengeExpiresAt: string;
  idempotencyKey: string;
}

export type ResourceEnrollmentAction =
  | "create"
  | "owner-action"
  | "authenticate"
  | "discover"
  | "profile"
  | "validate"
  | "test"
  | "register"
  | "ready"
  | "fail"
  | "cancel"
  | "expire"
  | "restart";

export interface ResourceEnrollmentActionInput {
  action: ResourceEnrollmentAction;
  idempotencyKey: string;
  evidenceId?: string;
  challengeToken?: string;
  authenticatedAt?: string;
  resourceId?: string;
  reason?: string;
  challengeExpiresAt?: string;
  restartedAt?: string;
}

export interface JobResultView {
  jobId: string;
  correlationId?: string;
  state: JobRecord["state"];
  verificationEvidenceIds: readonly string[];
  verificationReceiptId?: string;
  verificationReceiptHash?: string;
  verifiedCompletionFactId?: string;
  verifiedCompletionFactHash?: string;
  /** Owner-safe interpreted failure summary; raw provider errors remain internal. */
  failureReason?: string;
  explanation: OwnerOperationExplanation;
  failure?: OwnerFailurePresentation;
}

export interface StepUpSessionView {
  sessionId: string;
  userId: string;
  stepUpAuthenticatedAt: string;
}

export interface StepUpVerificationResult {
  session: StepUpSessionView;
  expiresAt: string;
  /** Server-only credential; HTTP handlers must set it as a cookie and never serialize it. */
  rotatedSessionToken: string;
}

export interface SessionRevocationView {
  sessionId: string;
  revoked: true;
}

export interface OtherSessionRevocationView {
  sessionId: string;
  revokedOtherSessions: number;
}

export interface ControlApiHealth {
  service: "getdone-control-api";
  surfaceVersion: string;
  status: "ready" | "degraded" | "unavailable";
  authConnected: boolean;
  persistenceConnected: boolean;
  aiGatewayAdapterInstalled: boolean;
  durableJobStoreConnected: boolean;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ControlApiApplicationAdapter {
  authenticate(request: Request): Promise<ControlApiPrincipal>;
  health(): Promise<ControlApiHealth>;
  beginStepUp(request: Request): Promise<StepUpChallenge>;
  verifyStepUp(
    request: Request,
    challengeId: string,
    response: unknown
  ): Promise<StepUpVerificationResult>;
  logout(request: Request): Promise<SessionRevocationView>;
  revokeOtherSessions(request: Request): Promise<OtherSessionRevocationView>;

  submitOwnerIntent(
    principal: ControlApiPrincipal,
    input: OwnerIntentInput,
    idempotencyKey: string,
    correlationId?: string
  ): Promise<OwnerIntentRecord>;

  submitObjectives(
    principal: ControlApiPrincipal,
    input: ObjectiveIntakeInput,
    idempotencyKey: string,
    correlationId?: string
  ): Promise<readonly ObjectiveRecord[]>;
  listObjectives(principal: ControlApiPrincipal): Promise<readonly ObjectiveRecord[]>;
  getObjective(principal: ControlApiPrincipal, objectiveId: string): Promise<ObjectiveRecord | null>;

  listPreferenceSuggestions(
    principal: ControlApiPrincipal
  ): Promise<readonly LearnedRuleSuggestion[]>;
  resolvePreferenceSuggestion(
    principal: ControlApiPrincipal,
    suggestionId: string,
    action: PreferenceSuggestionResolution
  ): Promise<PreferenceSuggestionResolutionResult>;
  listConfirmedPreferenceRules(
    principal: ControlApiPrincipal,
    capability: string
  ): Promise<readonly ConfirmedPreferenceRule[]>;

  listDecisions(principal: ControlApiPrincipal): Promise<readonly AuthoritativeDecision[]>;
  getDecision(principal: ControlApiPrincipal, decisionId: string): Promise<AuthoritativeDecision | null>;
  mutateDecision(
    principal: ControlApiPrincipal,
    input: DecisionMutationInput,
    correlationId?: string
  ): Promise<AuthoritativeDecision>;

  listResources(principal: ControlApiPrincipal): Promise<readonly Resource[]>;
  getResource(principal: ControlApiPrincipal, resourceId: string): Promise<Resource | null>;
  discoverResource(
    principal: ControlApiPrincipal,
    input: ResourceDiscoveryInput
  ): Promise<Resource>;

  listResourceEnrollments(
    principal: ControlApiPrincipal
  ): Promise<readonly ResourceEnrollmentRecord[]>;
  getResourceEnrollment(
    principal: ControlApiPrincipal,
    enrollmentId: string
  ): Promise<ResourceEnrollmentRecord | null>;
  startResourceEnrollment(
    principal: ControlApiPrincipal,
    input: ResourceEnrollmentStartInput
  ): Promise<ResourceEnrollmentRecord>;
  advanceResourceEnrollment(
    principal: ControlApiPrincipal,
    enrollmentId: string,
    input: ResourceEnrollmentActionInput
  ): Promise<ResourceEnrollmentRecord>;

  listJobs(principal: ControlApiPrincipal): Promise<readonly JobRecord[]>;
  getJob(principal: ControlApiPrincipal, jobId: string): Promise<JobRecord | null>;
  getJobResult(principal: ControlApiPrincipal, jobId: string): Promise<JobResultView | null>;

  listVerifications(principal: ControlApiPrincipal): Promise<readonly VerificationRequestRecord[]>;
  getVerification(
    principal: ControlApiPrincipal,
    verificationId: string
  ): Promise<VerificationRequestRecord | null>;
}
