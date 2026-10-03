import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
function fail(message) {
  failures.push(message);
}
function walk(dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", ".git", "coverage", "release/out"].includes(entry.name)) return [];
      return walk(relative);
    }
    return /\.(?:ts|tsx|js|mjs)$/.test(entry.name) ? [relative.replaceAll("\\", "/")] : [];
  });
}
function importsOf(content) {
  const values = [];
  for (const match of content.matchAll(/(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
    values.push(match[1]);
  }
  return values;
}
function startsWithAny(value, prefixes) {
  return prefixes.some((prefix) => value.startsWith(prefix));
}

const bottomNav = read("components/bottom-nav.tsx");
const labels = [...bottomNav.matchAll(/label:\s*"([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(labels) !== JSON.stringify(["Home", "Decisions", "Resources"])) {
  fail(`Permanent owner navigation drifted: expected Home, Decisions, Resources; got ${labels.join(", ")}`);
}

const readme = read("README.md");
if (!readme.includes("AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.")) {
  fail("README authority rule is missing or changed");
}

const architecture = read("docs/ARCHITECTURE.md");
if (architecture.includes("full PWA/service-worker delivery remains a later phase")) {
  fail("ARCHITECTURE.md contains stale Phase 25 PWA wording");
}

const envExample = read(".env.example");
if (/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|CREDENTIAL|PASSWORD)/.test(envExample)) {
  fail(".env.example exposes a secret-like NEXT_PUBLIC variable");
}

const packageJson = JSON.parse(read("package.json"));
const allDependencies = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
const providerPackages = new Set([
  "openai",
  "@anthropic-ai/sdk",
  "@google/generative-ai",
  "@google/genai"
]);
for (const dependency of Object.keys(allDependencies)) {
  if (providerPackages.has(dependency) && !fs.existsSync(path.join(root, "lib/ai-gateway"))) {
    fail(`Provider SDK ${dependency} is installed before the GetDone-owned lib/ai-gateway boundary exists`);
  }
}

const codeFiles = [...walk("app"), ...walk("components"), ...walk("lib"), ...walk("scripts")];
const providerImportPatterns = [
  /from\s+["']openai["']/,
  /from\s+["']@anthropic-ai\/sdk["']/,
  /from\s+["']@google\/(?:generative-ai|genai)["']/,
  /https:\/\/(?:openrouter\.ai|api\.openai\.com|api\.anthropic\.com)/
];

for (const file of codeFiles) {
  const content = read(file);
  if (!file.startsWith("lib/ai-gateway/") && file !== "scripts/verify-architecture.mjs") {
    for (const pattern of providerImportPatterns) {
      if (pattern.test(content)) fail(`Model/provider integration escaped lib/ai-gateway: ${file}`);
    }
  }
  if (
    content.includes('from "@/lib/mock-data"')
    && !["lib/data/repository.ts", "lib/mock-data.test.ts", "scripts/verify-architecture.mjs"].includes(file)
  ) {
    fail(`Development seed data imported outside the repository seam: ${file}`);
  }
  if (/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|CREDENTIAL|PASSWORD)/.test(content)) {
    fail(`Secret-like public environment variable referenced in ${file}`);
  }
}

const matrix = JSON.parse(read("architecture/dependency-boundaries.json"));
for (const rule of matrix.rules) {
  for (const file of codeFiles) {
    if (!startsWithAny(file, rule.fromPrefixes)) continue;
    if (startsWithAny(file, rule.allowFromPrefixes ?? [])) continue;
    const imports = importsOf(read(file));
    for (const imported of imports) {
      if (startsWithAny(imported, rule.denyImportPrefixes)) {
        fail(`Dependency boundary ${rule.id} violated: ${file} -> ${imported}`);
      }
    }
  }
}

const simulator = read("lib/resources/policy-simulator.ts");
for (const prohibitedImport of [
  "@/lib/resources/reservations",
  "@/lib/resources/scheduler",
  "@/lib/credentials/broker",
  "@/lib/execution/"
]) {
  if (simulator.includes(prohibitedImport)) {
    fail(`Zero-side-effect simulator imports an execution-authority module: ${prohibitedImport}`);
  }
}

const schedulerPublic = read("lib/resources/scheduler.ts");
const schedulerCore = read("lib/resources/internal/scheduler-core.ts");
const schedulerTypes = read("lib/resources/internal/scheduler-types.ts");
if (
  !schedulerPublic.includes('export * from "@/lib/resources/internal/scheduler-types"')
  || !schedulerPublic.includes('export * from "@/lib/resources/internal/scheduler-core"')
) {
  fail("Scheduler stable public barrel no longer re-exports its internal contract/core modules");
}
for (const required of [
  "governorReportHash",
  "assertGovernorAllowsAutonomousScheduling",
  "credentialLeaseHash",
  "DispatchAdmissionReceipt",
  "blockingKillSwitches",
  "verificationTrustAttestation",
  "jobStateMutationApplied: false"
]) {
  if (!(schedulerCore + schedulerTypes).includes(required)) {
    fail(`Phase 34 architecture binding missing after refactor: ${required}`);
  }
}

const reservationsPublic = read("lib/resources/reservations.ts");
if (
  !reservationsPublic.includes('export * from "@/lib/resources/internal/reservation-types"')
  || !reservationsPublic.includes('export * from "@/lib/resources/internal/reservation-core"')
) {
  fail("Reservation stable public barrel no longer re-exports its internal contract/core modules");
}

const aiContracts = read("lib/ai-gateway/contracts.ts");
const aiGateway = read("lib/ai-gateway/gateway.ts");
const aiRouter = read("lib/ai-gateway/router.ts");
for (const required of [
  'AI_GATEWAY_CONTRACT_VERSION = "1.2.0"',
  '"DETERMINISTIC"',
  '"HIGH_REASONING"',
  '"CODING"',
  '"VISION"',
  '"LONG_CONTEXT"',
  "AIGatewayAdapter",
  "AIRequirementEnvelope"
]) {
  if (!aiContracts.includes(required)) fail(`Phase 13 AI Gateway contract missing: ${required}`);
}
for (const required of [
  "DETERMINISTIC work must not invoke a model adapter",
  "NO_ELIGIBLE_MODEL",
  "outputSchema.safeParse",
  "admitAIBudget"
]) {
  if (!aiGateway.includes(required)) fail(`Phase 13 gateway fail-closed behavior missing: ${required}`);
}
for (const required of ["blockingKillSwitches", "profile-not-validated", "structured-output-not-supported"]) {
  if (!aiRouter.includes(required)) fail(`Phase 13 routing guard missing: ${required}`);
}

const openRouterAdapter = read("lib/ai-gateway/openrouter-adapter.ts");
for (const required of [
  'OPENROUTER_ADAPTER_VERSION = "1.2.0"',
  'OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"',
  "AbortSignal.timeout",
  "retryableStatus",
  "x-openrouter-metadata",
  "response.model",
  "runCanary",
  "OPENROUTER_CANARY_MODEL",
  "OpenRouter canary model identity mismatch"
]) {
  if (!openRouterAdapter.includes(required)) {
    fail(`OpenRouter adapter invariant missing: ${required}`);
  }
}

const controlApiContracts = read("lib/control-api/contracts.ts");
const controlApiRuntime = read("lib/control-api/runtime.server.ts");
const controlApiHttp = read("lib/control-api/http.ts");
const controlApiServices = read("lib/control-api/service-adapter.ts");
for (const required of [
  'CONTROL_API_SURFACE_VERSION = "1.6.0"',
  "submitOwnerIntent",
  "mutateDecision",
  "discoverResource",
  "startResourceEnrollment",
  "advanceResourceEnrollment",
  "getJobResult",
  "getVerification",
  "beginStepUp",
  "verifyStepUp",
  "ControlApiRole"
]) {
  if (!controlApiContracts.includes(required)) fail(`Control API surface invariant missing: ${required}`);
}
for (const required of [
  "Control API adapter is not connected to authoritative auth/persistence",
  "createPostgresControlApiAdapter",
  "return unavailableAdapter"
]) {
  if (!controlApiRuntime.includes(required)) fail(`Control API fail-closed runtime invariant missing: ${required}`);
}
for (const required of [
  "Idempotency-Key header is required",
  "cache-control",
  "VALIDATION_FAILED",
  "adapter.authenticate(request)"
]) {
  if (!controlApiHttp.includes(required)) fail(`Control API HTTP invariant missing: ${required}`);
}
for (const required of [
  "authorizeRequest",
  "resolveStepUpProof",
  "resolveDecision",
  "ResourceRegistryService",
  "ResourceEnrollmentService",
  "dataClassesAllowed: [\"public\"]"
]) {
  if (!controlApiServices.includes(required)) fail(`Control API service authority binding missing: ${required}`);
}

const aiBudgetReservation = read("lib/ai-gateway/budget-reservation.ts");
for (const required of [
  'AI_BUDGET_RESERVATION_CONTRACT_VERSION = "1.0.0"',
  "reserveAtomic",
  "idempotent-replay",
  "expectedReservationHash",
  "actualCostCents",
  "productionEligible: false",
  "Production AI budget reservations require durable atomic CAS persistence"
]) {
  if (!aiBudgetReservation.includes(required)) {
    fail(`Atomic AI budget reservation contract missing: ${required}`);
  }
}

const integration = read("lib/integrations/registry.ts");
for (const required of [
  "credentialBindingId",
  "readScopes",
  "writeScopes",
  "outside trusted company/environment scope",
  "Mock integration adapters are DEVELOPMENT-only"
]) {
  if (!integration.includes(required)) fail(`Phase 4 Integration Registry guard missing: ${required}`);
}

const postgresClient = read("lib/persistence/postgres/client.ts");
const postgresAuthorityStores = read("lib/persistence/postgres/authority-stores.ts");
const postgresTransactionManager = read("lib/persistence/postgres/transaction-manager.ts");
const postgresReservationStore = read("lib/persistence/postgres/reservation-store.ts");
const postgresJobStore = read("lib/persistence/postgres/job-store.ts");
const jobWorkerRuntime = read("lib/execution/job-worker-runtime.ts");
const businessActionOrchestrator = read("lib/execution/business-action-orchestrator.ts");
const softwareWorkerRuntime = read("lib/execution/software-worker-runtime.ts");
const jobExecutionRouter = read("lib/execution/job-execution-router.ts");

for (const required of [
  'POSTGRES_PERSISTENCE_VERSION = "1.1.0"',
  "BEGIN ISOLATION LEVEL SERIALIZABLE",
  "DATABASE_URL is required for PostgreSQL persistence",
  "PostgresTransactionalDatabase"
]) {
  if (!postgresClient.includes(required)) fail(`PostgreSQL persistence boundary missing: ${required}`);
}
for (const required of [
  "PostgresEntityStore",
  "PostgresIdempotencyStore",
  "PostgresAuditLedger",
  "PostgresAuthorizationGrantStore",
  "PostgresVerificationReceiptStore",
  "PostgresJobExecutionBridgeStore",
  "AND version=$8",
  "SELECT * FROM idempotency_records WHERE key=$1 FOR UPDATE"
]) {
  if (!postgresAuthorityStores.includes(required)) fail(`PostgreSQL authority store invariant missing: ${required}`);
}
for (const required of [
  "PostgresControlPlaneTransactionManager",
  "PostgresAuditLedger(client)",
  "PostgresIdempotencyStore(client)"
]) {
  if (!postgresTransactionManager.includes(required)) fail(`PostgreSQL transaction manager invariant missing: ${required}`);
}
for (const required of [
  "return this.database.transaction",
  "FOR UPDATE",
  "IDEMPOTENCY_CONFLICT",
  "capacity_ledgers",
  "reservation_commits"
]) {
  if (!postgresReservationStore.includes(required)) fail(`PostgreSQL reservation atomicity invariant missing: ${required}`);
}
for (const required of [
  'persistence: "durable-external"',
  "claimAtomic",
  "FOR UPDATE OF r,l SKIP LOCKED",
  "closeActiveLease",
  "recoverExpired",
  "job_dead_letters"
]) {
  if (!postgresJobStore.includes(required)) fail(`Production durable Job Store invariant missing: ${required}`);
}
for (const required of [
  "class DurableJobWorker",
  "heartbeat",
  "maxAttempts",
  "scheduleRetry",
  "deadLetter",
  "recoverExpired"
]) {
  if (!jobWorkerRuntime.includes(required)) fail(`Durable Job worker invariant missing: ${required}`);
}
for (const required of [
  'BUSINESS_ACTION_ORCHESTRATOR_VERSION = "1.0.0"',
  "requestHash",
  "providerOperationId",
  "pollAccepted",
  "verificationFor"
]) {
  if (!businessActionOrchestrator.includes(required)) fail(`Business action orchestrator invariant missing: ${required}`);
}
for (const required of [
  'SOFTWARE_WORKER_RUNTIME_VERSION = "1.0.0"',
  "awaiting-production-approval",
  "productionPromotionReceiptHash",
  "deployProduction",
  "completeProductionVerification",
  "rollback"
]) {
  if (!softwareWorkerRuntime.includes(required)) fail(`Software worker runtime invariant missing: ${required}`);
}
for (const required of [
  'JOB_EXECUTION_ROUTER_VERSION = "1.2.0"',
  "createPersistedJobExecutionSpec",
  "business-action",
  "software-prepare",
  "software-deploy",
  "software-verify",
  "software-rollback"
]) {
  if (!jobExecutionRouter.includes(required)) fail(`Durable execution router invariant missing: ${required}`);
}

const jobRuntime = read("lib/execution/job-runtime-contracts.ts");
for (const required of [
  "DurableJobStore",
  "claimAtomic",
  "heartbeat",
  "scheduleRetry",
  "deadLetter",
  "recoverExpired",
  "DurableJobStoreDescriptor",
  'persistence: "durable-external" | "ephemeral-reference"',
  "JobStoreTransactionReceipt",
  "expectedVersion",
  "expectedHash",
  "transactionHash",
  "No in-memory"
]) {
  if (!jobRuntime.includes(required)) fail(`Phase 19 durable runtime contract missing: ${required}`);
}

const jobExecutionBridge = read("lib/domain/services/job-execution-bridge.ts");
const jobService = read("lib/domain/services/job-service.ts");
for (const required of [
  'JOB_EXECUTION_BRIDGE_CONTRACT_VERSION = "1.0.0"',
  "JobVerifiedStartFact",
  "JobVerifiedCompletionFact",
  "JobExecutionBridgeStore",
  "createJobVerifiedStartFact",
  "assertJobVerifiedStartFact",
  "createJobVerifiedCompletionFact",
  "assertJobVerifiedCompletionFact",
  "createJobCompletionVerificationEvidence"
]) {
  if (!jobExecutionBridge.includes(required)) {
    fail(`Phase 34 -> Job execution bridge contract missing: ${required}`);
  }
}
for (const required of [
  "verifiedStartFactId: string",
  "verifiedCompletionFactId?: string",
  "transaction.stores.executionBridge",
  "assertJobVerifiedStartFact",
  "assertJobVerifiedCompletionFact",
  "job-started-from-verified-resource-start",
  "job-verification-started-from-verified-resource-completion"
]) {
  if (!jobService.includes(required)) {
    fail(`JobService verified execution bridge binding missing: ${required}`);
  }
}

const goldenPath = read("lib/composition/golden-path-harness.ts");
for (const required of [
  'GOLDEN_PATH_HARNESS_VERSION = "1.2.0"',
  "simulationOnly: true",
  "productionExecutionClaimed: false",
  "createJobVerifiedStartFact",
  "createJobVerifiedCompletionFact",
  "releaseVerifiedPlacement",
  "createOperationalMemory"
]) {
  if (!goldenPath.includes(required)) {
    fail(`Cross-phase golden-path harness invariant missing: ${required}`);
  }
}

const businessAdapter = read("lib/execution/adapters/business-action.ts");
for (const required of [
  "authorizationConsumptionHash",
  "idempotencyKey",
  "jobStateMutationApplied: false",
  "sha256Hex(request.input) !== request.inputHash",
  "assertBusinessActionStatus",
  "Production business actions require a scoped credential lease reference",
  "BusinessActionRetryClass",
  "retryClass?: BusinessActionRetryClass"
]) {
  if (!businessAdapter.includes(required)) fail(`Phase 20 adapter authority guard missing: ${required}`);
}

const softwareWorker = read("lib/execution/software-worker.ts");
for (const required of [
  'codingRole: "CODING"',
  "productionApprovalRequired: true",
  "stagingVerificationReceiptId",
  "Production promotion requires approval receipt",
  "SoftwareDeploymentExecutor",
  "SoftwareDeploymentEvidence",
  "SoftwarePostDeploymentVerificationEvidence",
  "authoritativeSuccess: false",
  "independent post-deployment verification"
]) {
  if (!softwareWorker.includes(required)) fail(`Phase 21 software worker guard missing: ${required}`);
}

const storageFabric = read("lib/resources/storage-fabric.ts");
for (const required of [
  'STORAGE_FABRIC_CONTRACT_VERSION = "1.1.0"',
  "authoritative-primary",
  "home-cannot-hold-sole-authoritative-copy",
  "Production authoritative state cannot depend only on HOME storage",
  "Authoritative replication factor must be satisfied by authoritative copies",
  "exactly one authoritative primary",
  "distinct failure domains"
]) {
  if (!storageFabric.includes(required)) fail(`Phase 36 storage authority guard missing: ${required}`);
}

const resilience = read("lib/resources/resilience.ts");
for (const required of [
  'RESILIENCE_CONTRACT_VERSION = "1.1.0"',
  "circuitBreaker",
  "beginDrain",
  "createFailoverPlan",
  "requiresIndependentVerification: true",
  "FailoverVerificationEvidence",
  "createFailoverVerificationEvidence",
  "Failover time cannot move backwards",
  "Drain remaining work cannot increase",
  "hash-bound independent verification evidence"
]) {
  if (!resilience.includes(required)) fail(`Phase 37 resilience guard missing: ${required}`);
}

const resourceAdapterSdk = read("lib/resources/adapter-sdk.ts");
for (const required of [
  'RESOURCE_ADAPTER_SDK_CONTRACT_VERSION = "1.1.0"',
  "discover(context",
  "authenticate(context",
  "capabilities(context",
  "reserve(context",
  "allocate(context",
  "dispatch(context",
  "status(context",
  "cancel(context",
  "release(context",
  "correlationId",
  "authoritative: false",
  "lifecycleExercised: true",
  "assertResourceAdapterConformance"
]) {
  if (!resourceAdapterSdk.includes(required)) fail(`Phase 38 Resource Adapter SDK guard missing: ${required}`);
}

const pools = read("lib/resources/pools.ts");
for (const required of [
  'RESOURCE_POOL_CONTRACT_VERSION = "1.1.0"',
  "credentialBindingIds",
  "failureDomainIds",
  "autoSchedulingEnabled",
  "createResourcePoolReadinessEvidence",
  "evidenceHash",
  "poolHash",
  "readinessHash",
  "evaluateResourcePoolReadiness",
  "assertResourcePoolEligible",
  "buildResourcePoolReadModel"
]) {
  if (!pools.includes(required)) fail(`Phase 39 ResourcePool guard missing: ${required}`);
}

const phase44 = read("lib/security/phase44-adversarial-harness.ts");
for (const required of [
  'PHASE44_DETERMINISTIC_HARNESS_VERSION = "1.1.0"',
  "voice-approval-bypass",
  "staging-production-scope-misuse",
  "forged-resource-capability",
  "reservation-replay",
  "scheduler-bypass",
  "provider-success-spoofing",
  "credential-scope-escalation",
  "cross-company-contamination",
  "release-registry-tampering",
  "model-provider-authority-attempt",
  "createPhase44HarnessReport",
  "assertPhase44ProbeResult",
  "PHASE44_VECTOR_MATRIX_HASH"
]) {
  if (!phase44.includes(required)) fail(`Phase 44 deterministic adversarial vector missing: ${required}`);
}

const voice = read("lib/voice/voice-intents.ts");
for (const required of [
  "usesControlApi: true",
  "usesCurrentPolicyRegistry: true",
  "canApprove: false",
  "canStepUp: false",
  "canExecuteSideEffect: false",
  "canAcceptRawCredentials: false",
  'strongApprovalHandling: "secure-phone-only"',
  'credentialHandling: "secure-provider-or-phone-only"'
]) {
  if (!voice.includes(required)) fail(`Phase 42 voice authority binding missing: ${required}`);
}

const sourceTrust = read("lib/verification/source-trust.ts");
for (const required of [
  "VerificationSourceBinding",
  "independenceDomain",
  "createVerificationTrustAttestation",
  "assertVerificationTrustAttestation"
]) {
  if (!sourceTrust.includes(required)) fail(`Verification source trust contract missing: ${required}`);
}

const agentMain = read("agent/cmd/getdone-agent/main.go");
const agentConfig = read("agent/internal/config/config.go");
const agentStateStore = read("agent/internal/localstate/store.go");
const agentVersion = read("agent/internal/version/version.go");
const agentHealth = read("agent/internal/health/manager.go");
const agentSystemd = read("agent/packaging/systemd/getdone-agent.service");
const agentBuild = read("scripts/build-node-agent.sh");
const agentWorkflow = read(".github/workflows/node-agent.yml");

for (const required of [
  "config.Load()",
  "localstate.NewStore",
  "controlplane.New",
  "health.NewManager",
  "signal.NotifyContext"
]) {
  if (!agentMain.includes(required)) fail(`Phase 28.1 agent entrypoint missing: ${required}`);
}
for (const required of [
  'ProtocolVersion   = "1.0.0"',
  "[REDACTED]",
  "GETDONE_ENROLLMENT_TOKEN",
  "GETDONE_CONTROL_PLANE_URL"
]) {
  if (!agentConfig.includes(required)) fail(`Phase 28.1 config boundary missing: ${required}`);
}
for (const required of [
  "os.CreateTemp",
  "temp.Sync()",
  "os.Rename",
  "dir.Sync()"
]) {
  if (!agentStateStore.includes(required)) fail(`Phase 28.1 atomic local-state invariant missing: ${required}`);
}
for (const required of [
  'ProtocolVersion = "1.0.0"',
  "runtime.GOARCH"
]) {
  if (!agentVersion.includes(required)) fail(`Phase 28.1 build metadata invariant missing: ${required}`);
}
if (!agentHealth.includes("<-ctx.Done()")) fail("Phase 28.1 health lifecycle is not cancellation-bound");
for (const required of [
  "User=getdone-agent",
  "Group=getdone-agent",
  "NoNewPrivileges=true",
  "ProtectSystem=strict",
  "ReadWritePaths=/var/lib/getdone-agent /var/log/getdone-agent"
]) {
  if (!agentSystemd.includes(required)) fail(`Phase 28.1 systemd hardening missing: ${required}`);
}
for (const required of [
  "GOARCH=amd64",
  "GOARCH=arm64",
  "getdone-agent-linux-amd64",
  "getdone-agent-linux-arm64"
]) {
  if (!agentBuild.includes(required)) fail(`Phase 28.1 cross-build invariant missing: ${required}`);
}
for (const required of [
  "actions/checkout@v7",
  "actions/setup-go@v6",
  "gofmt -l",
  "go vet ./...",
  "go test ./...",
  "bash scripts/build-node-agent.sh"
]) {
  if (!agentWorkflow.includes(required)) fail(`Phase 28.1 Go CI gate missing: ${required}`);
}

const agentCapabilityProfile = read("agent/internal/capabilities/profile.go");
const agentCapabilityRunner = read("agent/internal/capabilities/run.go");
const resourceDomain = read("lib/domain/resources.ts");
const agentDockerCapability = read("agent/internal/capabilities/docker.go");
const agentCudaCapability = read("agent/internal/capabilities/cuda.go");
const nodeCapabilityCatalog = read("lib/nodes/capability-catalog.ts");
const nodeCapabilityService = read("lib/nodes/capability-service.ts");
const nodeCapabilityBridge = read("lib/nodes/capability-bridge.ts");
const nodeCapabilityRuntime = read("lib/nodes/capability-runtime.server.ts");
const nodeCapabilityHttp = read("lib/nodes/capability-http.ts");
const nodeCapabilityStore = read("lib/persistence/postgres/node-capability-store.ts");
const nodeCapabilityMigration = read("migrations/2026-09-21.4_phase28_capabilities.sql");

for (const required of [
  "DefaultDetectors",
  "DockerDetector",
  "ContainerdDetector",
  "PythonDetector",
  "NodeJSDetector",
  "JavaDetector",
  "GitDetector",
  "OllamaDetector",
  "CUDADetector",
  "FFmpegDetector",
  "SHA256CanonicalWithoutField"
]) {
  if (!agentCapabilityProfile.includes(required)) fail(`Phase 28.4 capability profiler missing: ${required}`);
}
for (const required of [
  '"--pull=never"',
  '"--network=none"',
  '"--read-only"',
  '"--cap-drop=ALL"'
]) {
  if (!agentDockerCapability.includes(required)) fail(`Phase 28.4 Docker validation safety invariant missing: ${required}`);
}
if (!agentCudaCapability.includes('"nvidia-smi"')) {
  fail("Phase 28.4 CUDA validation must use the local NVIDIA driver boundary");
}
for (const required of [
  "exec.CommandContext",
  "CombinedOutput"
]) {
  if (!agentCapabilityRunner.includes(required)) fail(`Phase 28.4 Linux capability runner missing: ${required}`);
}
for (const required of [
  '"runtime.docker"',
  '"runtime.containerd"',
  '"runtime.python"',
  '"runtime.nodejs"',
  '"runtime.java"',
  '"tool.git"',
  '"runtime.ollama"',
  '"gpu.cuda"',
  '"tool.ffmpeg"'
]) {
  if (!nodeCapabilityCatalog.includes(required)) fail(`Phase 28.4 bounded capability catalog missing: ${required}`);
}
for (const required of [
  'NODE_CAPABILITY_SERVICE_VERSION = "1.0.0"',
  "hashNodeCapabilityProfile",
  "hashNodeCapability(capability)",
  "Authoritative Node inventory is required before capability profiling",
  "CUDA capability evidence is inconsistent with authoritative hardware inventory"
]) {
  if (!nodeCapabilityService.includes(required)) fail(`Phase 28.4 capability authority check missing: ${required}`);
}
for (const required of [
  'NODE_CAPABILITY_BRIDGE_VERSION = "1.0.0"',
  "getCapability",
  '"compute.cpu.light"',
  '"compute.gpu.inference"',
  'adapterBinding.startsWith("resource.")',
  "deriveNodeCapabilityReconciliationBindings",
  "ResourceRegistryNodeCapabilityBridge",
  "addCapabilityBinding"
]) {
  if (!nodeCapabilityBridge.includes(required)) fail(`Phase 28.4 Capability Registry bridge missing: ${required}`);
}
for (const required of [
  "latestCapabilities",
  "latest?.validated"
]) {
  if (!resourceDomain.includes(required)) fail(`Phase 28.4 Resource Registry capability revocation invariant missing: ${required}`);
}
for (const required of [
  "Node capability persistence service is not connected",
  "installNodeCapabilityAdapter",
  "resetNodeCapabilityAdapter"
]) {
  if (!nodeCapabilityRuntime.includes(required)) fail(`Phase 28.4 fail-closed capability runtime missing: ${required}`);
}
for (const required of [
  "Idempotency-Key header is required",
  "getNodeAgentAuthenticator().authenticate",
  "nodeCapabilityProfileSchema"
]) {
  if (!nodeCapabilityHttp.includes(required)) fail(`Phase 28.4 capability HTTP boundary missing: ${required}`);
}
for (const required of [
  "SELECT id FROM compute_nodes WHERE id=$1 FOR UPDATE",
  "absent-from-full-profile",
  "older than authoritative current state",
  "node_capability_history",
  "node_capability_state"
]) {
  if (!nodeCapabilityStore.includes(required)) fail(`Phase 28.4 capability reconciliation invariant missing: ${required}`);
}
for (const required of [
  "node_capability_profiles",
  "node_capability_state",
  "node_capability_history",
  "UNIQUE(node_id, profile_hash)",
  "PRIMARY KEY(node_id, capability_name)"
]) {
  if (!nodeCapabilityMigration.includes(required)) fail(`Phase 28.4 capability migration invariant missing: ${required}`);
}

const agentInventory = read("agent/internal/inventory/inventory.go");
const agentCPUInventory = read("agent/internal/inventory/cpu_linux.go");
const agentStorageInventory = read("agent/internal/inventory/storage_linux.go");
const agentNetworkInventory = read("agent/internal/inventory/network_linux.go");
const agentGPUInventory = read("agent/internal/inventory/gpu.go");
const agentNVIDIAInventory = read("agent/internal/inventory/gpu_nvidia.go");
const nodeInventoryService = read("lib/nodes/inventory-service.ts");
const nodeAgentRuntime = read("lib/nodes/agent-runtime.server.ts");
const nodeAgentHttp = read("lib/nodes/agent-http.ts");
const nodeInventoryStore = read("lib/persistence/postgres/node-inventory-store.ts");
const nodeInventoryMigration = read("migrations/2026-09-21.3_phase28_inventory.sql");

for (const required of [
  "NewCollector",
  "DiscoverCPU",
  "DiscoverMemory",
  "DiscoverStorage",
  "DiscoverNetwork",
  "DiscoverOS",
  "DiscoverGPUs",
  "SHA256CanonicalWithoutField"
]) {
  if (!agentInventory.includes(required)) fail(`Phase 28.3 inventory aggregator missing: ${required}`);
}
for (const required of [
  'case "amd64"',
  'return "x86_64"',
  'case "arm64"',
  'return "arm64"'
]) {
  if (!agentCPUInventory.includes(required)) fail(`Phase 28.3 equal architecture discovery missing: ${required}`);
}
for (const required of [
  "sanitizeMountPath",
  '"/mnt/"',
  '"/[redacted]"',
  "StatFS"
]) {
  if (!agentStorageInventory.includes(required)) fail(`Phase 28.3 storage privacy/discovery invariant missing: ${required}`);
}
if (agentNetworkInventory.includes("log.") || agentNetworkInventory.includes("fmt.Printf")) {
  fail("Phase 28.3 network discovery must not log interface addresses");
}
for (const required of [
  "NVIDIADetector",
  "AMDDetector"
]) {
  if (!agentGPUInventory.includes(required)) fail(`Phase 28.3 GPU aggregator missing: ${required}`);
}
if (!agentNVIDIAInventory.includes("nvidia-smi")) fail("Phase 28.3 NVIDIA detector is missing");
for (const required of [
  'NODE_INVENTORY_SERVICE_VERSION = "1.0.0"',
  "hashHardwareInventory",
  "inventory.nodeId !== principal.nodeId",
  "node.architecture !== inventory.architecture"
]) {
  if (!nodeInventoryService.includes(required)) fail(`Phase 28.3 inventory authority check missing: ${required}`);
}
for (const required of [
  "Authenticated Node Agent transport is not connected",
  "installNodeAgentAuthenticator",
  "installNodeInventoryAdapter"
]) {
  if (!nodeAgentRuntime.includes(required)) fail(`Phase 28.3 fail-closed agent runtime missing: ${required}`);
}
for (const required of [
  "Idempotency-Key header is required",
  "getNodeAgentAuthenticator().authenticate",
  "hardwareInventorySchema"
]) {
  if (!nodeAgentHttp.includes(required)) fail(`Phase 28.3 inventory HTTP boundary missing: ${required}`);
}
for (const required of [
  "ON CONFLICT (node_id,inventory_hash) DO NOTHING",
  "IDEMPOTENCY_CONFLICT",
  "ORDER BY discovered_at DESC,received_at DESC"
]) {
  if (!nodeInventoryStore.includes(required)) fail(`Phase 28.3 inventory persistence invariant missing: ${required}`);
}
for (const required of [
  "node_inventory_snapshots",
  "UNIQUE(node_id, inventory_hash)",
  "node_inventory_latest_idx"
]) {
  if (!nodeInventoryMigration.includes(required)) fail(`Phase 28.3 inventory migration invariant missing: ${required}`);
}

const nodeIdentity = read("lib/nodes/identity.ts");
const nodeApplication = read("lib/nodes/application.ts");
const nodeRuntime = read("lib/nodes/runtime.server.ts");
const nodeHttp = read("lib/nodes/http.ts");
const nodeEnrollmentStore = read("lib/persistence/postgres/node-enrollment-store.ts");
const nodeIdentityStore = read("lib/persistence/postgres/node-identity-store.ts");
const nodeMigration = read("migrations/2026-09-21.2_phase28_nodes.sql");
const agentEnrollment = read("agent/internal/enrollment/client.go");
const agentInstaller = read("agent/packaging/install/install.sh");

for (const required of [
  'NODE_IDENTITY_CONTRACT_VERSION = "1.0.0"',
  "interface NodeIdentityIssuer",
  "DevelopmentNodeIdentityIssuer",
  "timingSafeEqual"
]) {
  if (!nodeIdentity.includes(required)) fail(`Phase 28.2 identity contract missing: ${required}`);
}
for (const required of [
  'NODE_ENROLLMENT_APPLICATION_VERSION = "1.0.0"',
  "challengeSecret",
  "deriveEnrollmentToken",
  "getCompletedBootstrap",
  "coordinator.authenticate",
  "completeBootstrap"
]) {
  if (!nodeApplication.includes(required)) fail(`Phase 28.2 secure enrollment invariant missing: ${required}`);
}
for (const required of [
  "Node enrollment application adapter is not connected",
  "installNodeEnrollmentAdapter",
  "resetNodeEnrollmentAdapter"
]) {
  if (!nodeRuntime.includes(required)) fail(`Phase 28.2 fail-closed runtime invariant missing: ${required}`);
}
for (const required of [
  "getControlApiAdapter().authenticate",
  "Idempotency-Key header is required",
  "handleAgentNodeEnrollment",
  "nodeAgentBootstrapSchema"
]) {
  if (!nodeHttp.includes(required)) fail(`Phase 28.2 HTTP boundary missing: ${required}`);
}
for (const required of [
  "FOR UPDATE",
  "consumed_nonce_hash",
  "INSERT INTO compute_nodes",
  "INSERT INTO node_identity_credentials",
  "Node enrollment challenge was already consumed"
]) {
  if (!nodeEnrollmentStore.includes(required)) fail(`Phase 28.2 atomic bootstrap persistence missing: ${required}`);
}
for (const required of [
  "rotateAtomic",
  "previous_credential_id",
  "next_credential_id",
  "rotationHash"
]) {
  if (!nodeIdentityStore.includes(required)) fail(`Phase 28.2 credential rotation lineage missing: ${required}`);
}
for (const required of [
  "node_enrollment_challenges",
  "token_hash text NOT NULL UNIQUE",
  "node_identity_one_active_credential",
  "node_certificate_rotations",
  "node_agent_sessions"
]) {
  if (!nodeMigration.includes(required)) fail(`Phase 28.2 node migration invariant missing: ${required}`);
}
for (const required of [
  "ed25519.GenerateKey",
  '"/api/agent/v1/enroll"',
  "config.EraseEnrollmentToken",
  "CertificateReference",
  "PrivateKeyReference"
]) {
  if (!agentEnrollment.includes(required)) fail(`Phase 28.2 agent bootstrap invariant missing: ${required}`);
}
for (const required of [
  "--enrollment",
  "sha256sum --check",
  "useradd --system",
  "systemctl enable --now getdone-agent.service",
  'ARCH="amd64"',
  'ARCH="arm64"',
  'ARTIFACT="getdone-agent-linux-${ARCH}"'
]) {
  if (!agentInstaller.includes(required)) fail(`Phase 28.2 installer invariant missing: ${required}`);
}

const nodeContracts = read("lib/nodes/contracts.ts");
const nodeDispatchContracts = read("lib/nodes/dispatch-contracts.ts");
const nodeSchemas = read("lib/nodes/schemas.ts");
const nodeHashes = read("lib/nodes/hashes.ts");
const nodeEnrollment = read("lib/nodes/enrollment.ts");
for (const required of [
  'NODE_DOMAIN_VERSION = "1.0.0"',
  'NODE_AGENT_PROTOCOL_VERSION = "1.0.0"',
  'type NodeArchitecture = "x86_64" | "arm64"',
  'type NodePlatform = "linux"',
  "NodeAllocatableProfile",
  "NodeHeartbeat",
  "HardwareInventory"
]) {
  if (!nodeContracts.includes(required)) fail(`Phase 28.0 Node domain contract missing: ${required}`);
}
for (const required of [
  'NODE_DISPATCH_CONTRACT_VERSION = "1.0.0"',
  "authorizationConsumptionHash",
  "executionSpecHash",
  "reservationId",
  "payloadHash",
  "NodeJobResultSubmission"
]) {
  if (!nodeDispatchContracts.includes(required)) fail(`Phase 28.0 dispatch contract missing: ${required}`);
}
for (const required of [
  'z.enum(["x86_64", "arm64"])',
  'z.literal("linux")',
  ".strict()",
  "dispatch must expire after creation"
]) {
  if (!nodeSchemas.includes(required)) fail(`Phase 28.0 protocol validation missing: ${required}`);
}
for (const required of [
  "sha256Hex",
  "assertNodeDispatchIntegrity",
  "hashHardwareInventory",
  "hashNodeJobResult"
]) {
  if (!nodeHashes.includes(required)) fail(`Phase 28.0 canonical hashing missing: ${required}`);
}
for (const required of [
  "class NodeEnrollmentCoordinator",
  "ResourceEnrollmentService",
  'requestedType: "compute"',
  "resourceEnrollment.identify",
  "resourceEnrollment.authenticate",
  "resourceEnrollment.profile",
  "resourceEnrollment.markReady"
]) {
  if (!nodeEnrollment.includes(required)) fail(`Phase 28.0 enrollment authority binding missing: ${required}`);
}

const ci = read(".github/workflows/ci.yml");
for (const requiredScript of [
  "npm run verify:dependencies",
  "npm run verify:architecture",
  "npm run verify:coverage",
  "npm run test:e2e",
  "npx playwright install --with-deps chromium",
  "npm run verify:contract-versions",
  "npm run release:generate",
  "npm run verify:release",
  "actions/checkout@v7",
  "actions/setup-node@v7",
  "actions/upload-artifact@v7",
  "persist-credentials: false",
  "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24"
]) {
  if (!ci.includes(requiredScript)) fail(`CI does not preserve required architecture/release gate: ${requiredScript}`);
}

const releaseRegistry = JSON.parse(read("release/version-registry.json"));
const releaseEnvironment = JSON.parse(read("release/environment-manifest.json"));
for (const required of [
  "registrySchemaVersion",
  "registryVersion",
  "appVersion",
  "environmentManifestSchemaVersion",
  "schemaVersions",
  "database",
  "policy",
  "aiGateway",
  "controlApi",
  "nodeAgent",
  "integrations",
  "execution",
  "composition",
  "resourceFabric",
  "phase44",
  "voice",
  "adapters",
  "environmentManifestPath",
  "acceptanceEvidencePaths",
  "manualSourcePaths",
  "generatedArtifacts"
]) {
  if (!(required in releaseRegistry)) fail(`Phase 41 version registry is missing: ${required}`);
}
if (
  releaseRegistry.appVersion !== packageJson.version
  || releaseRegistry.environmentManifestPath !== "release/environment-manifest.json"
  || releaseRegistry.environmentManifestSchemaVersion !== releaseEnvironment.manifestSchemaVersion
) {
  fail("Phase 41 registry app/environment binding drifted");
}
if (
  releaseRegistry.aiGateway.status !== "runtime-wired-unconnected"
  || releaseRegistry.aiGateway.adapterVersion !== "1.2.0"
  || releaseRegistry.aiGateway.contractVersion !== "1.2.0"
  || releaseRegistry.aiGateway.routingPolicyContractVersion !== "1.0.0"
  || releaseRegistry.aiGateway.routingPolicyVersion !== "UNCONFIGURED"
  || releaseRegistry.adapters?.openRouter?.status !== "implemented-unconfigured"
  || releaseRegistry.adapters?.openRouter?.version !== "1.2.0"
  || releaseRegistry.adapters?.configuredHttpAction?.status !== "implemented-unconfigured"
) {
  fail("Phase 13 release state must expose the implemented OpenRouter adapter without claiming live routing/connectivity");
}
if (
  releaseRegistry.nodeAgent?.status !== "implemented-development-only"
  || releaseRegistry.nodeAgent?.domainVersion !== "1.0.0"
  || releaseRegistry.nodeAgent?.protocolVersion !== "1.0.0"
  || releaseRegistry.nodeAgent?.dispatchContractVersion !== "1.0.0"
  || releaseRegistry.nodeAgent?.linuxX64 !== "capability-profile-build"
  || releaseRegistry.nodeAgent?.linuxArm64 !== "capability-profile-build"
  || releaseRegistry.nodeAgent?.productionReady !== false
  || releaseRegistry.nodeAgent?.agentVersion !== "0.4.0-development"
  || releaseRegistry.nodeAgent?.enrollmentStatus !== "implemented-unconnected"
  || releaseRegistry.nodeAgent?.nodePersistenceStatus !== "implemented-unconnected"
  || releaseRegistry.nodeAgent?.identityIssuerStatus !== "development-only"
  || releaseRegistry.nodeAgent?.productionCaStatus !== "not-connected"
  || releaseRegistry.nodeAgent?.productionMtlsStatus !== "not-connected"
  || releaseRegistry.nodeAgent?.enrollmentMigrationVersion !== "2026-09-21.2"
  || releaseRegistry.nodeAgent?.bootstrapAuthentication !== "one-time-token"
  || releaseRegistry.nodeAgent?.inventoryDiscoveryStatus !== "implemented"
  || releaseRegistry.nodeAgent?.inventoryApiStatus !== "implemented-unconnected"
  || releaseRegistry.nodeAgent?.inventoryPersistenceStatus !== "implemented-unconnected"
  || releaseRegistry.nodeAgent?.authenticatedAgentTransportStatus !== "not-connected"
  || releaseRegistry.nodeAgent?.inventoryMigrationVersion !== "2026-09-21.3"
  || releaseRegistry.nodeAgent?.capabilityProfilingStatus !== "implemented"
  || releaseRegistry.nodeAgent?.capabilityValidationStatus !== "implemented"
  || releaseRegistry.nodeAgent?.capabilityApiStatus !== "implemented-unconnected"
  || releaseRegistry.nodeAgent?.capabilityPersistenceStatus !== "implemented-unconnected"
  || releaseRegistry.nodeAgent?.capabilityRegistryBridgeStatus !== "implemented"
  || releaseRegistry.nodeAgent?.resourceCapabilityBindingStatus !== "implemented-unconnected"
  || releaseRegistry.nodeAgent?.capabilityMigrationVersion !== "2026-09-21.4"
  || releaseRegistry.schemaVersions?.nodeCapability?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.nodeCapabilityBridge?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.nodeInventory?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.nodeIdentity?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.nodeDomain?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.nodeDispatch?.version !== "1.0.0"
) {
  fail("Phase 28.4 release state drifted or overclaims live Node capability/binding connectivity");
}
if (
  releaseRegistry.controlApi?.surfaceVersion !== "1.5.0"
  || releaseRegistry.controlApi?.status !== "implemented-unconnected"
  || releaseRegistry.controlApi?.applicationAdapterStatus !== "not-connected"
  || releaseRegistry.controlApi?.authStatus !== "implemented-unconnected"
  || releaseRegistry.controlApi?.persistenceStatus !== "not-connected"
  || releaseRegistry.schemaVersions?.controlApiSurface?.version !== "1.5.0"
) {
  fail("Control API release state must expose the implemented surface while preserving unconnected authority adapters");
}
if (
  releaseRegistry.schemaVersions?.aiBudgetReservation?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.aiBudgetReservation?.contractTracked !== true
  || releaseRegistry.adapters?.aiGateway?.version !== "1.2.0"
) {
  fail("Atomic AI budget reservation / AI Gateway 1.2 release binding drifted");
}

if (
  releaseRegistry.database?.status !== "implemented-unconnected"
  || releaseRegistry.database?.engine !== "postgresql"
  || releaseRegistry.database?.minimumEngineVersion !== "16"
  || releaseRegistry.database?.migrationVersion !== "2026-09-25.3"
  || releaseRegistry.database?.schemaVersion !== "2.2.0"
  || releaseRegistry.schemaVersions?.postgresPersistence?.version !== "1.1.0"
  || releaseRegistry.schemaVersions?.disasterRecovery?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.disasterRecovery?.contractTracked !== true
  || releaseRegistry.schemaVersions?.zeroDowntimeMigrationPolicy?.version !== "1.1.0"
  || releaseRegistry.schemaVersions?.zeroDowntimeMigrationPolicy?.contractTracked !== true
  || releaseRegistry.schemaVersions?.productionReleaseGate?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.productionReleaseGate?.contractTracked !== true
  || releaseRegistry.adapters?.postgresPersistence?.status !== "implemented-unconnected"
  || releaseRegistry.adapters?.postgresPersistence?.version !== "1.1.0"
  || releaseRegistry.adapters?.durableJobStore?.status !== "implemented-unconnected"
) {
  fail("PostgreSQL persistence release truth drifted or overclaims connectivity");
}

if (
  releaseRegistry.integrations.registryContractVersion !== "1.0.0"
  || releaseRegistry.integrations.liveAdaptersStatus !== "not-connected"
  || releaseRegistry.integrations.adapterImplementationStatus !== "implemented-unconfigured"
) {
  fail("Phase 4 release state drifted");
}
if (
  releaseRegistry.execution.jobRuntimeContractVersion !== "1.2.0"
  || releaseRegistry.execution.durableJobStoreStatus !== "implemented-unconnected"
  || releaseRegistry.execution.durableJobStoreVersion !== "1.0.0"
  || releaseRegistry.execution.businessActionContractVersion !== "1.6.0"
  || releaseRegistry.execution.businessActionOrchestratorStatus !== "implemented"
  || releaseRegistry.execution.businessAdaptersStatus !== "implemented-unconfigured"
  || releaseRegistry.adapters?.businessAction?.version !== "1.6.0"
  || releaseRegistry.adapters?.configuredHttpAction?.version !== "1.3.0"
  || releaseRegistry.adapters?.configuredWebhookAction?.status !== "implemented-unconfigured"
  || releaseRegistry.adapters?.gmailBusinessAction?.status !== "implemented-unconfigured"
  || releaseRegistry.adapters?.slackBusinessAction?.status !== "implemented-unconfigured"
  || releaseRegistry.adapters?.crmBusinessAction?.status !== "implemented-unconfigured"
  || releaseRegistry.adapters?.crmBusinessAction?.version !== "1.0.0"
  || releaseRegistry.adapters?.githubStandardOperation?.status !== "implemented-unconfigured"
  || releaseRegistry.adapters?.githubStandardOperation?.version !== "1.0.0"
  || releaseRegistry.adapters?.analyticsDataIngestion?.status !== "implemented-unconfigured"
  || releaseRegistry.adapters?.analyticsDataIngestion?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.analyticsIngestion?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.analyticsIngestion?.contractTracked !== true
  || releaseRegistry.schemaVersions?.environmentEvidence?.version !== "1.0.0"
  || releaseRegistry.schemaVersions?.environmentEvidence?.contractTracked !== true
  || releaseRegistry.execution.softwareWorkerContractVersion !== "1.1.0"
  || releaseRegistry.execution.softwareWorkerRuntimeStatus !== "implemented"
  || releaseRegistry.execution.softwareDeploymentStatus !== "not-connected"
  || releaseRegistry.execution.jobExecutionRouterStatus !== "implemented"
  || releaseRegistry.execution.jobExecutionRouterVersion !== "1.1.0"
  || releaseRegistry.execution.persistentWorkerServiceStatus !== "implemented-unconnected"
  || releaseRegistry.execution.persistentWorkerServiceVersion !== "1.0.0"
  || releaseRegistry.execution.jobExecutionBridgeContractVersion !== "1.0.0"
  || releaseRegistry.execution.jobExecutionBridgeStatus !== "deterministic-contract"
  || releaseRegistry.execution.jobExecutionBridgeStoreImplementationStatus !== "implemented-unconnected"
  || releaseRegistry.execution.liveJobExecutionBridgeStoreStatus !== "not-connected"
  || releaseRegistry.execution.persistenceBackend !== "postgresql"
) {
  fail("Phases 19-21 / Phase 34 Job bridge release state drifted");
}
if (
  releaseRegistry.composition?.goldenPathHarnessVersion !== "1.1.0"
  || releaseRegistry.composition?.status !== "deterministic-simulation-only"
  || releaseRegistry.composition?.productionExecutionClaimed !== false
) {
  fail("Cross-phase composition harness release state drifted or overclaims production");
}
if (
  releaseRegistry.resourceFabric?.storageFabricContractVersion !== "1.1.0"
  || releaseRegistry.resourceFabric?.storageRuntimeStatus !== "not-connected"
  || releaseRegistry.resourceFabric?.resilienceContractVersion !== "1.1.0"
  || releaseRegistry.resourceFabric?.failoverRuntimeStatus !== "not-connected"
  || releaseRegistry.resourceFabric?.resourceAdapterSdkContractVersion !== "1.1.0"
  || releaseRegistry.resourceFabric?.secondProviderStatus !== "not-connected"
  || releaseRegistry.resourceFabric?.resourcePoolContractVersion !== "1.1.0"
  || releaseRegistry.resourceFabric?.partnerPoolRuntimeStatus !== "not-connected"
  || releaseRegistry.adapters?.resourceAdapterSdk?.status !== "contract-only"
) {
  fail("Phases 36-39 release state drifted");
}
if (
  releaseRegistry.phase44?.deterministicHarnessVersion !== "1.1.0"
  || releaseRegistry.phase44?.deterministicHarnessStatus !== "contract-and-offline-tests"
  || releaseRegistry.phase44?.productionAcceptanceStatus !== "not-run"
) {
  fail("Phase 44 deterministic/live acceptance state drifted");
}
if (
  releaseRegistry.voice?.strongApprovalHandling !== "secure-phone-only"
  || releaseRegistry.voice?.credentialHandling !== "secure-provider-or-phone-only"
) {
  fail("Phase 42 voice release registry weakens authority");
}

const environmentEvidencePolicy = JSON.parse(read("config/environment-evidence-policy.json"));
if (
  releaseEnvironment.manifestSchemaVersion !== environmentEvidencePolicy.manifestSchemaVersion
  || releaseEnvironment.generation?.mode !== "acceptance-evidence-derived"
  || releaseEnvironment.generation?.policyVersion !== environmentEvidencePolicy.policyVersion
) {
  fail("Environment manifest is not bound to the current evidence policy");
}

for (const [name, state] of Object.entries(releaseEnvironment.environments ?? {})) {
  const status = (target) => state.connections?.[target] ? "connected" : "not-connected";
  for (const target of Object.keys(environmentEvidencePolicy.targets ?? {})) {
    if (target === "deployment") continue;
    if (typeof state.connections?.[target] !== "boolean") {
      fail(`Environment connection target is missing: ${name}.${target}`);
    }
  }
  if (
    state.nodeAgent?.status !== "implemented-development-only"
    || state.nodeAgent?.domainVersion !== "1.0.0"
    || state.nodeAgent?.protocolVersion !== "1.0.0"
    || state.nodeAgent?.authenticatedAgentTransportStatus !== status("resourceAgent")
    || state.nodeAgent?.productionReady !== Boolean(state.connections?.resourceAgent)
    || state.aiGateway?.contractStatus !== "deterministic-contract"
    || state.aiGateway?.adapterStatus !== status("aiGateway")
    || state.aiGateway?.adapterImplementationStatus !== "implemented-unconfigured"
    || state.controlApi?.surfaceStatus !== "implemented"
    || state.controlApi?.applicationAdapterStatus !== status("controlApiPersistence")
    || state.controlApi?.authStatus !== "implemented-unconnected"
    || state.controlApi?.persistenceStatus !== status("controlApiPersistence")
    || state.integrations?.registryStatus !== "deterministic-contract"
    || state.integrations?.adapterStatus !== status("businessIntegrationAdapters")
    || state.execution?.jobRuntimeContractStatus !== "deterministic-contract"
    || state.execution?.durableJobStoreStatus !== status("durableJobEngine")
    || state.execution?.durableJobStoreImplementationStatus !== "implemented-unconnected"
    || state.execution?.businessActionOrchestratorStatus !== "implemented"
    || state.execution?.businessActionAdapterStatus !== status("businessActionAdapters")
    || state.execution?.softwareWorkerRuntimeStatus !== "implemented"
    || state.execution?.softwareDeploymentStatus !== status("softwareDeploymentExecutor")
    || state.execution?.persistentWorkerServiceStatus !== status("durableJobEngine")
    || state.execution?.jobExecutionBridgeStatus !== "deterministic-contract"
    || state.execution?.jobExecutionBridgeStoreImplementationStatus !== "implemented-unconnected"
    || state.execution?.liveJobExecutionBridgeStoreStatus !== status("controlApiPersistence")
    || state.database?.engine !== "postgresql"
    || state.database?.adapterStatus !== (state.connections?.database ? "connected" : "implemented-unconnected")
    || state.database?.migrationVersion !== "2026-09-25.3"
    || state.database?.schemaVersion !== "2.2.0"
    || state.resourceFabric?.storageRuntimeStatus !== status("storageFabricRuntime")
    || state.resourceFabric?.failoverRuntimeStatus !== status("resilienceFailoverRuntime")
    || state.resourceFabric?.secondProviderStatus !== status("secondResourceProvider")
    || state.resourceFabric?.partnerPoolRuntimeStatus !== status("partnerPoolRuntime")
    || state.voice?.adapterStatus !== status("voiceAdapter")
    || state.voice?.strongApprovalAllowed !== false
    || state.voice?.rawCredentialInputAllowed !== false
  ) {
    fail(`Evidence-derived environment boundary drifted: ${name}`);
  }
}

if (failures.length > 0) {
  console.error("GetDone architecture integrity verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`GetDone architecture integrity verification passed with ${matrix.rules.length} dependency-boundary rules.`);
