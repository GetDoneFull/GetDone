import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const failures = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}
function fail(message) {
  failures.push(message);
}
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function fileHash(relativePath) {
  return sha256(fs.readFileSync(path.join(root, relativePath)));
}
function gitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
}
function extractStringConst(relativePath, name) {
  const match = read(relativePath).match(
    new RegExp(`export const ${name} = ["']([^"']+)["']`)
  );
  return match?.[1];
}
function looksSecretBearing(content) {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/,
    /(?:api[_-]?key|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i
  ];
  return patterns.some((pattern) => pattern.test(content));
}

const registry = readJson("release/version-registry.json");
const environment = readJson(registry.environmentManifestPath);
const packageJson = readJson("package.json");
const manifestPath = registry.generatedArtifacts.machineManifest;
const manualPath = registry.generatedArtifacts.operatingManual;

for (const requiredPath of [manifestPath, manualPath]) {
  if (!fs.existsSync(path.join(root, requiredPath))) {
    fail(`Missing generated release artifact: ${requiredPath}`);
  }
}

if (failures.length === 0) {
  const manifest = readJson(manifestPath);
  const manual = read(manualPath);
  const { manifestHash, ...manifestBase } = manifest;

  if (sha256(canonicalJson(manifestBase)) !== manifestHash) {
    fail("Release manifest integrity hash does not match its contents");
  }
  if (manifest.gitSha !== gitSha()) {
    fail("Release manifest Git SHA does not match the checked-out commit");
  }
  if (
    manifest.manifestSchemaVersion !== registry.schemaVersions.releaseManifest.version
    || manifest.registrySchemaVersion !== registry.registrySchemaVersion
    || registry.environmentManifestSchemaVersion !== environment.manifestSchemaVersion
    || manifest.environmentManifestSchemaVersion !== environment.manifestSchemaVersion
  ) {
    fail("Release/environment registry schema version drift detected");
  }
  if (manifest.appVersion !== packageJson.version || registry.appVersion !== packageJson.version) {
    fail("App version drift exists between package.json, registry, and release manifest");
  }
  if (manifest.registrySha256 !== sha256(canonicalJson(registry))) {
    fail("Release manifest version-registry hash is stale");
  }
  if (manifest.environment.sourceSha256 !== sha256(canonicalJson(environment))) {
    fail("Release manifest environment-manifest hash is stale");
  }
  if (manifest.packageLockSha256 !== fileHash("package-lock.json")) {
    fail("Release manifest package-lock hash is stale");
  }
  if (manifest.ciEvidence?.workflowSha256 !== fileHash(".github/workflows/ci.yml")) {
    fail("Release manifest CI workflow hash is stale");
  }

  for (const [name, entry] of Object.entries(registry.schemaVersions)) {
    const manifested = manifest.schemaVersions[name];
    if (
      !manifested
      || manifested.version !== entry.version
      || manifested.sourcePath !== entry.sourcePath
      || manifested.sourceSha256 !== fileHash(entry.sourcePath)
    ) {
      fail(`Schema version/source drift: ${name}`);
    }
  }

  for (const [name, entry] of Object.entries(registry.adapters)) {
    const manifested = manifest.adapterVersions[name];
    if (
      !manifested
      || manifested.version !== entry.version
      || manifested.status !== entry.status
      || manifested.sourcePath !== entry.sourcePath
      || manifested.sourceSha256 !== fileHash(entry.sourcePath)
    ) {
      fail(`Adapter version/source drift: ${name}`);
    }
  }

  const aiGatewayContractVersion = extractStringConst(
    registry.aiGateway.sourcePath,
    "AI_GATEWAY_CONTRACT_VERSION"
  );
  const aiRoutingPolicyContractVersion = extractStringConst(
    registry.aiGateway.sourcePath,
    "AI_ROUTING_POLICY_CONTRACT_VERSION"
  );
  const controlApiSurfaceVersion = extractStringConst(
    registry.controlApi.sourcePath,
    "CONTROL_API_SURFACE_VERSION"
  );
  const nodeDomainVersion = extractStringConst(
    "lib/nodes/contracts.ts",
    "NODE_DOMAIN_VERSION"
  );
  const nodeAgentProtocolVersion = extractStringConst(
    "lib/nodes/contracts.ts",
    "NODE_AGENT_PROTOCOL_VERSION"
  );
  const nodeDispatchContractVersion = extractStringConst(
    "lib/nodes/dispatch-contracts.ts",
    "NODE_DISPATCH_CONTRACT_VERSION"
  );
  const nodeIdentityContractVersion = extractStringConst(
    "lib/nodes/identity.ts",
    "NODE_IDENTITY_CONTRACT_VERSION"
  );
  const openRouterAdapterVersion = extractStringConst(
    registry.adapters.openRouter.sourcePath,
    "OPENROUTER_ADAPTER_VERSION"
  );
  const integrationRegistryContractVersion = extractStringConst(
    registry.integrations.sourcePath,
    "INTEGRATION_REGISTRY_CONTRACT_VERSION"
  );
  const jobRuntimeContractVersion = extractStringConst(
    "lib/execution/job-runtime-contracts.ts",
    "JOB_RUNTIME_CONTRACT_VERSION"
  );
  const businessActionContractVersion = extractStringConst(
    "lib/execution/adapters/business-action.ts",
    "BUSINESS_ACTION_ADAPTER_CONTRACT_VERSION"
  );
  const softwareWorkerContractVersion = extractStringConst(
    "lib/execution/software-worker.ts",
    "SOFTWARE_WORKER_CONTRACT_VERSION"
  );
  const jobExecutionBridgeContractVersion = extractStringConst(
    "lib/domain/services/job-execution-bridge.ts",
    "JOB_EXECUTION_BRIDGE_CONTRACT_VERSION"
  );
  const goldenPathHarnessVersion = extractStringConst(
    registry.composition.sourcePath,
    "GOLDEN_PATH_HARNESS_VERSION"
  );
  const storageFabricContractVersion = extractStringConst(
    "lib/resources/storage-fabric.ts",
    "STORAGE_FABRIC_CONTRACT_VERSION"
  );
  const resilienceContractVersion = extractStringConst(
    "lib/resources/resilience.ts",
    "RESILIENCE_CONTRACT_VERSION"
  );
  const resourceAdapterSdkContractVersion = extractStringConst(
    "lib/resources/adapter-sdk.ts",
    "RESOURCE_ADAPTER_SDK_CONTRACT_VERSION"
  );
  const resourcePoolContractVersion = extractStringConst(
    "lib/resources/pools.ts",
    "RESOURCE_POOL_CONTRACT_VERSION"
  );
  const phase44HarnessVersion = extractStringConst(
    registry.phase44.sourcePath,
    "PHASE44_DETERMINISTIC_HARNESS_VERSION"
  );
  if (
    manifest.nodeAgent?.status !== "implemented-development-only"
    || manifest.nodeAgent?.domainVersion !== nodeDomainVersion
    || manifest.nodeAgent?.protocolVersion !== nodeAgentProtocolVersion
    || manifest.nodeAgent?.dispatchContractVersion !== nodeDispatchContractVersion
    || manifest.nodeAgent?.linuxX64 !== "capability-profile-build"
    || manifest.nodeAgent?.linuxArm64 !== "capability-profile-build"
    || manifest.nodeAgent?.productionReady !== false
    || manifest.nodeAgent?.agentVersion !== "0.4.0-development"
    || manifest.nodeAgent?.enrollmentStatus !== "implemented-unconnected"
    || manifest.nodeAgent?.nodePersistenceStatus !== "implemented-unconnected"
    || manifest.nodeAgent?.identityIssuerStatus !== "development-only"
    || manifest.nodeAgent?.productionCaStatus !== "not-connected"
    || manifest.nodeAgent?.productionMtlsStatus !== "not-connected"
    || manifest.nodeAgent?.enrollmentMigrationVersion !== "2026-09-21.2"
    || manifest.nodeAgent?.bootstrapAuthentication !== "one-time-token"
    || manifest.nodeAgent?.inventoryDiscoveryStatus !== "implemented"
    || manifest.nodeAgent?.inventoryApiStatus !== "implemented-unconnected"
    || manifest.nodeAgent?.inventoryPersistenceStatus !== "implemented-unconnected"
    || manifest.nodeAgent?.authenticatedAgentTransportStatus !== "not-connected"
    || manifest.nodeAgent?.inventoryMigrationVersion !== "2026-09-21.3"
    || manifest.nodeAgent?.capabilityProfilingStatus !== "implemented"
    || manifest.nodeAgent?.capabilityValidationStatus !== "implemented"
    || manifest.nodeAgent?.capabilityApiStatus !== "implemented-unconnected"
    || manifest.nodeAgent?.capabilityPersistenceStatus !== "implemented-unconnected"
    || manifest.nodeAgent?.capabilityRegistryBridgeStatus !== "implemented"
    || manifest.nodeAgent?.resourceCapabilityBindingStatus !== "implemented-unconnected"
    || manifest.nodeAgent?.capabilityMigrationVersion !== "2026-09-21.4"
    || registry.nodeAgent?.status !== "implemented-development-only"
    || registry.schemaVersions.nodeCapability?.version !== "1.0.0"
    || registry.schemaVersions.nodeCapabilityBridge?.version !== "1.0.0"
    || registry.schemaVersions.nodeInventory?.version !== "1.0.0"
    || registry.schemaVersions.nodeIdentity?.version !== nodeIdentityContractVersion
  ) {
    fail("Phase 28.4 Node Agent release artifact truth drifted or overclaims live capability/binding connectivity");
  }
  for (const evidence of manifest.nodeAgent?.sourceEvidence ?? []) {
    if (
      !registry.nodeAgent.sourcePaths.includes(evidence.sourcePath)
      || evidence.sourceSha256 !== fileHash(evidence.sourcePath)
    ) {
      fail(`Phase 28.4 node source evidence drift: ${evidence.sourcePath}`);
    }
  }
  if (
    registry.aiGateway.contractVersion !== aiGatewayContractVersion
    || registry.aiGateway.routingPolicyContractVersion !== aiRoutingPolicyContractVersion
    || manifest.aiGateway.contractVersion !== aiGatewayContractVersion
    || manifest.aiGateway.routingPolicyContractVersion !== aiRoutingPolicyContractVersion
    || registry.controlApi.surfaceVersion !== controlApiSurfaceVersion
    || registry.schemaVersions.controlApiSurface?.version !== controlApiSurfaceVersion
    || manifest.controlApi?.surfaceVersion !== controlApiSurfaceVersion
    || manifest.controlApi?.sourceSha256 !== fileHash(registry.controlApi.sourcePath)
    || registry.adapters.openRouter?.version !== openRouterAdapterVersion
    || manifest.adapterVersions.openRouter?.version !== openRouterAdapterVersion
    || registry.aiGateway.adapterVersion !== openRouterAdapterVersion
    || manifest.aiGateway.adapterVersion !== openRouterAdapterVersion
    || registry.integrations.registryContractVersion !== integrationRegistryContractVersion
    || manifest.integrations.registryContractVersion !== integrationRegistryContractVersion
    || manifest.integrations.sourceSha256 !== fileHash(registry.integrations.sourcePath)
    || registry.execution.jobRuntimeContractVersion !== jobRuntimeContractVersion
    || registry.execution.businessActionContractVersion !== businessActionContractVersion
    || registry.execution.softwareWorkerContractVersion !== softwareWorkerContractVersion
    || registry.execution.jobExecutionBridgeContractVersion !== jobExecutionBridgeContractVersion
    || manifest.execution.jobExecutionBridgeContractVersion !== jobExecutionBridgeContractVersion
    || registry.composition.goldenPathHarnessVersion !== goldenPathHarnessVersion
    || manifest.composition.goldenPathHarnessVersion !== goldenPathHarnessVersion
    || manifest.composition.sourceSha256 !== fileHash(registry.composition.sourcePath)
    || registry.resourceFabric.storageFabricContractVersion !== storageFabricContractVersion
    || registry.resourceFabric.resilienceContractVersion !== resilienceContractVersion
    || registry.resourceFabric.resourceAdapterSdkContractVersion !== resourceAdapterSdkContractVersion
    || registry.resourceFabric.resourcePoolContractVersion !== resourcePoolContractVersion
    || registry.phase44.deterministicHarnessVersion !== phase44HarnessVersion
    || manifest.resourceFabric.storageFabricContractVersion !== storageFabricContractVersion
    || manifest.resourceFabric.resilienceContractVersion !== resilienceContractVersion
    || manifest.resourceFabric.resourceAdapterSdkContractVersion !== resourceAdapterSdkContractVersion
    || manifest.resourceFabric.resourcePoolContractVersion !== resourcePoolContractVersion
    || manifest.phase44.deterministicHarnessVersion !== phase44HarnessVersion
    || manifest.phase44.sourceSha256 !== fileHash(registry.phase44.sourcePath)
  ) {
    fail("Deterministic Phase 4/13/19-21/34-bridge/36-39/44/composition contract/version registry drift detected");
  }
  for (const evidence of manifest.execution.sourceEvidence ?? []) {
    if (evidence.sourceSha256 !== fileHash(evidence.sourcePath)) {
      fail(`Execution contract source drift: ${evidence.sourcePath}`);
    }
  }
  for (const evidence of manifest.resourceFabric.sourceEvidence ?? []) {
    if (evidence.sourceSha256 !== fileHash(evidence.sourcePath)) {
      fail(`Resource Fabric contract source drift: ${evidence.sourcePath}`);
    }
  }

  const voiceIntentContractVersion = extractStringConst(
    registry.voice.sourcePath,
    "VOICE_INTENT_CONTRACT_VERSION"
  );
  const voiceAdapterContractVersion = extractStringConst(
    registry.voice.sourcePath,
    "VOICE_ADAPTER_CONTRACT_VERSION"
  );
  if (
    voiceIntentContractVersion !== registry.voice.contractVersion
    || voiceAdapterContractVersion !== registry.voice.adapterContractVersion
    || registry.schemaVersions.voiceIntent?.version !== voiceIntentContractVersion
    || registry.adapters.voiceIntent?.version !== voiceAdapterContractVersion
    || manifest.voice.contractVersion !== voiceIntentContractVersion
    || manifest.voice.adapterContractVersion !== voiceAdapterContractVersion
    || manifest.voice.sourceSha256 !== fileHash(registry.voice.sourcePath)
  ) {
    fail("Voice contract/version registry drift detected");
  }
  if (
    registry.voice.adapterStatus === "not-connected"
    && (
      registry.voice.adapterVersion !== "UNIMPLEMENTED"
      || registry.voice.speechProvider !== "UNCONFIGURED"
      || registry.adapters.voiceIntent?.status !== "contract-only"
    )
  ) {
    fail("Disconnected voice runtime must remain explicitly UNIMPLEMENTED/UNCONFIGURED with a contract-only adapter");
  }
  if (
    registry.voice.strongApprovalHandling !== "secure-phone-only"
    || registry.voice.credentialHandling !== "secure-provider-or-phone-only"
  ) {
    fail("Voice release state cannot weaken strong approval or credential handoff");
  }

  const policyVersion = extractStringConst(
    registry.policy.registrySourcePath,
    "CURRENT_POLICY_VERSION"
  );
  const policyEngineVersion = extractStringConst(
    registry.policy.engineSourcePath,
    "POLICY_ENGINE_VERSION"
  );
  if (
    policyVersion !== registry.policy.registryVersion
    || policyEngineVersion !== registry.policy.engineVersion
    || manifest.policy.registryVersion !== policyVersion
    || manifest.policy.engineVersion !== policyEngineVersion
  ) {
    fail("Policy version registry drift detected");
  }

  if (
    registry.database.status !== "implemented-unconnected"
    || registry.database.engine !== "postgresql"
    || registry.database.minimumEngineVersion !== "16"
    || registry.database.migrationVersion !== "2026-09-28.7"
    || registry.database.schemaVersion !== "2.3.0"
    || registry.schemaVersions.postgresPersistence?.version !== "1.1.0"
    || registry.schemaVersions.disasterRecovery?.version !== "1.0.0"
    || registry.schemaVersions.disasterRecovery?.sourcePath !== "lib/execution/disaster-recovery.ts"
    || registry.schemaVersions.zeroDowntimeMigrationPolicy?.version !== "1.0.0"
    || registry.schemaVersions.zeroDowntimeMigrationPolicy?.contractTracked !== true
    || registry.schemaVersions.productionReleaseGate?.version !== "1.0.0"
    || registry.schemaVersions.productionReleaseGate?.contractTracked !== true
    || registry.adapters.postgresPersistence?.version !== "1.1.0"
    || manifest.database.status !== registry.database.status
    || manifest.database.engine !== registry.database.engine
    || manifest.database.migrationVersion !== registry.database.migrationVersion
    || manifest.database.schemaVersion !== registry.database.schemaVersion
    || manifest.database.sourceSha256 !== fileHash(registry.database.sourcePath)
    || registry.adapters.postgresPersistence?.status !== "implemented-unconnected"
  ) {
    fail("PostgreSQL persistence implementation/version release truth drifted");
  }

  if (registry.aiGateway.status === "runtime-wired-unconnected") {
    if (
      registry.aiGateway.routingPolicyVersion !== "UNCONFIGURED"
      || registry.adapters.aiGateway?.status !== "contract-only"
      || registry.adapters.openRouter?.status !== "implemented-unconfigured"
      || registry.aiGateway.adapterVersion !== registry.adapters.openRouter.version
    ) {
      fail("Disconnected AI Gateway must expose the implemented OpenRouter adapter while keeping credentials/routing unconfigured");
    }
  } else if (
    registry.aiGateway.routingPolicyVersion === "UNCONFIGURED"
  ) {
    fail("Connected AI Gateway cannot retain an unconfigured routing policy");
  }

  if (
    registry.controlApi.status !== "implemented-unconnected"
    || registry.controlApi.applicationAdapterStatus !== "not-connected"
    || registry.controlApi.authStatus !== "implemented-unconnected"
    || registry.controlApi.persistenceStatus !== "not-connected"
  ) {
    fail("Control API release truth must distinguish implemented surface from unconnected authority adapters");
  }

  if (
    registry.integrations.liveAdaptersStatus !== "not-connected"
    || registry.execution.durableJobStoreStatus !== "implemented-unconnected"
    || registry.execution.durableJobStoreVersion !== "1.0.0"
    || registry.execution.businessActionOrchestratorStatus !== "implemented"
    || registry.execution.businessAdaptersStatus !== "implemented-unconfigured"
    || registry.adapters.configuredHttpAction?.status !== "implemented-unconfigured"
    || registry.adapters.githubStandardOperation?.status !== "implemented-unconfigured"
    || registry.adapters.githubStandardOperation?.version !== "1.0.0"
    || registry.adapters.analyticsDataIngestion?.status !== "implemented-unconfigured"
    || registry.adapters.analyticsDataIngestion?.version !== "1.0.0"
    || registry.schemaVersions.analyticsIngestion?.version !== "1.0.0"
    || registry.schemaVersions.analyticsIngestion?.contractTracked !== true
    || registry.composition.mvpBusinessWorkflowStatus !== "implemented-unconfigured"
    || registry.execution.softwareWorkerRuntimeStatus !== "implemented"
    || registry.execution.softwareDeploymentStatus !== "not-connected"
    || registry.execution.jobExecutionRouterStatus !== "implemented"
    || registry.execution.jobExecutionRouterVersion !== "1.1.0"
    || registry.execution.persistentWorkerServiceStatus !== "implemented-unconnected"
    || registry.execution.persistentWorkerServiceVersion !== "1.0.0"
    || registry.execution.jobExecutionBridgeStatus !== "deterministic-contract"
    || registry.execution.jobExecutionBridgeStoreImplementationStatus !== "implemented-unconnected"
    || registry.execution.liveJobExecutionBridgeStoreStatus !== "not-connected"
    || registry.execution.persistenceBackend !== "postgresql"
    || registry.composition.status !== "deterministic-simulation-only"
    || registry.composition.productionExecutionClaimed !== false
    || registry.resourceFabric.storageRuntimeStatus !== "not-connected"
    || registry.resourceFabric.failoverRuntimeStatus !== "not-connected"
    || registry.resourceFabric.secondProviderStatus !== "not-connected"
    || registry.resourceFabric.partnerPoolRuntimeStatus !== "not-connected"
    || registry.adapters.resourceAdapterSdk?.status !== "contract-only"
    || registry.phase44.productionAcceptanceStatus !== "not-run"
  ) {
    fail("Release registry must not claim live Job bridge/composition or unconnected Phase 4/19-21/36-39/44 runtime acceptance");
  }

  for (const evidence of manifest.acceptanceEvidence) {
    if (evidence.sourceSha256 !== fileHash(evidence.sourcePath)) {
      fail(`Acceptance evidence drift: ${evidence.sourcePath}`);
    }
  }
  for (const source of manifest.manuals.sources) {
    if (source.sourceSha256 !== fileHash(source.sourcePath)) {
      fail(`Manual source drift: ${source.sourcePath}`);
    }
  }
  for (const evidence of manifest.qualityEvidence ?? []) {
    if (evidence.sourceSha256 !== fileHash(evidence.sourcePath)) {
      fail(`Quality evidence drift: ${evidence.sourcePath}`);
    }
  }
  for (const evidence of manifest.securityEvidence ?? []) {
    if (evidence.sourceSha256 !== fileHash(evidence.sourcePath)) {
      fail(`Security evidence drift: ${evidence.sourcePath}`);
    }
  }
  if (manifest.manuals.generatedOperatingManualSha256 !== sha256(manual)) {
    fail("Generated operating manual hash does not match the release manifest");
  }

  const evidencePolicy = readJson("config/environment-evidence-policy.json");
  const connectionTargets = Object.keys(evidencePolicy.targets).filter((target) => target !== "deployment");
  if (
    environment.manifestSchemaVersion !== evidencePolicy.manifestSchemaVersion
    || environment.generation?.mode !== "acceptance-evidence-derived"
    || environment.generation?.policyVersion !== evidencePolicy.policyVersion
  ) {
    fail("Environment manifest is not generated from the current acceptance-evidence policy");
  }

  for (const [name, environmentState] of Object.entries(environment.environments)) {
    const connectedStatus = (target) => environmentState.connections?.[target]
      ? "connected"
      : "not-connected";

    for (const target of connectionTargets) {
      if (typeof environmentState.connections?.[target] !== "boolean") {
        fail(`Environment connection target is missing or non-boolean: ${name}.${target}`);
        continue;
      }
      const evidence = environmentState.connectionEvidence?.[target];
      if (environmentState.connections[target]) {
        if (
          !evidence
          || !evidencePolicy.targets[target]?.acceptanceIds?.includes(evidence.acceptanceId)
          || !/^[a-f0-9]{40}$/.test(evidence.candidateSha ?? "")
          || !/^[a-f0-9]{64}$/.test(evidence.sourceArtifactSha256 ?? "")
          || !/^[a-f0-9]{64}$/.test(evidence.evidenceHash ?? "")
        ) {
          fail(`Connected environment target lacks valid acceptance evidence: ${name}.${target}`);
        }
      } else if (evidence) {
        fail(`Disconnected environment target must not retain connection evidence: ${name}.${target}`);
      }
    }

    if (
      !environmentState.aiGateway
      || environmentState.aiGateway.contractStatus !== "deterministic-contract"
      || environmentState.aiGateway.adapterStatus !== connectedStatus("aiGateway")
      || !environmentState.controlApi
      || environmentState.controlApi.surfaceStatus !== "implemented"
      || environmentState.controlApi.authStatus !== "implemented-unconnected"
      || environmentState.controlApi.applicationAdapterStatus !== connectedStatus("controlApiPersistence")
      || environmentState.controlApi.persistenceStatus !== connectedStatus("controlApiPersistence")
      || !environmentState.integrations
      || environmentState.integrations.registryStatus !== "deterministic-contract"
      || environmentState.integrations.adapterStatus !== connectedStatus("businessIntegrationAdapters")
      || !environmentState.execution
      || environmentState.execution.jobRuntimeContractStatus !== "deterministic-contract"
      || environmentState.execution.durableJobStoreStatus !== connectedStatus("durableJobEngine")
      || environmentState.execution.businessActionAdapterStatus !== connectedStatus("businessActionAdapters")
      || environmentState.execution.softwareDeploymentStatus !== connectedStatus("softwareDeploymentExecutor")
      || environmentState.execution.liveJobExecutionBridgeStoreStatus !== connectedStatus("controlApiPersistence")
      || environmentState.execution.persistentWorkerServiceStatus !== connectedStatus("durableJobEngine")
      || environmentState.database?.engine !== "postgresql"
      || environmentState.database?.adapterStatus !== (
        environmentState.connections?.database ? "connected" : "implemented-unconnected"
      )
      || !environmentState.resourceFabric
      || environmentState.resourceFabric.storageRuntimeStatus !== connectedStatus("storageFabricRuntime")
      || environmentState.resourceFabric.failoverRuntimeStatus !== connectedStatus("resilienceFailoverRuntime")
      || environmentState.resourceFabric.secondProviderStatus !== connectedStatus("secondResourceProvider")
      || environmentState.resourceFabric.partnerPoolRuntimeStatus !== connectedStatus("partnerPoolRuntime")
      || !environmentState.voice
      || environmentState.voice.adapterStatus !== connectedStatus("voiceAdapter")
      || environmentState.nodeAgent?.authenticatedAgentTransportStatus !== connectedStatus("resourceAgent")
      || environmentState.nodeAgent?.productionReady !== Boolean(environmentState.connections?.resourceAgent)
    ) {
      fail(`Environment evidence-derived connection/status drift: ${name}`);
    }
  }

  const production = environment.environments.production;
  if (
    production.productionReady
    && (
      Object.values(production.connections).some((connected) => connected !== true)
      || (registry.voice.requiredForProduction && production.connections.voiceAdapter !== true)
      || production.deployment?.status !== "connected"
      || !production.deployment?.deploymentId
    )
  ) {
    fail("Production cannot be declared ready without a connected deployment and all required connections");
  }
  if (
    !["development", "staging", "production"].every(
      (name) => environment.environments[name]
    )
  ) {
    fail("Environment manifest must define development, staging, and production");
  }

  if (process.env.GITHUB_ACTIONS === "true") {
    const requiredQualityEvidence = [
      "coverage/control-plane-module-coverage.json",
      "coverage/vitest/coverage-summary.json",
      "test-results/playwright-results.json"
    ];
    const requiredSecurityEvidence = [
      "coverage/security/npm-audit-production.json",
      "coverage/security/npm-audit-full-critical.json"
    ];
    for (const requiredPath of requiredQualityEvidence) {
      const evidence = (manifest.qualityEvidence ?? []).find((entry) => entry.sourcePath === requiredPath);
      if (!evidence || evidence.sourceSha256 !== fileHash(requiredPath)) {
        fail(`GitHub Actions release evidence is missing verified quality output: ${requiredPath}`);
      }
    }
    for (const requiredPath of requiredSecurityEvidence) {
      const evidence = (manifest.securityEvidence ?? []).find((entry) => entry.sourcePath === requiredPath);
      if (!evidence || evidence.sourceSha256 !== fileHash(requiredPath)) {
        fail(`GitHub Actions release evidence is missing verified security output: ${requiredPath}`);
      }
    }
    const expectedChecks = [
      "dependency-audit",
      "runtime-verification",
      "secret-scan",
      "architecture-integrity",
      "contract-version-drift",
      "typecheck",
      "lint",
      "vitest-v8-coverage",
      "control-plane-module-coverage",
      "production-build",
      "playwright-desktop-mobile-e2e"
    ];
    if (JSON.stringify(manifest.ciEvidence.checksCompletedBeforeGeneration) !== JSON.stringify(expectedChecks)) {
      fail("Release CI prerequisite ledger is incomplete or reordered");
    }
    if (
      manifest.ciEvidence.provider !== "github-actions"
      || manifest.ciEvidence.runId !== process.env.GITHUB_RUN_ID
      || manifest.ciEvidence.runNumber !== process.env.GITHUB_RUN_NUMBER
      || manifest.ciEvidence.checkedOutGitSha !== gitSha()
      || manifest.ciEvidence.githubSha !== process.env.GITHUB_SHA
    ) {
      fail("GitHub Actions CI evidence does not match the current workflow execution");
    }
  }

  if (!manual.includes(`Git SHA: ${manifest.gitSha}`)) {
    fail("Operating manual does not bind the current Git SHA");
  }
  if (!manual.includes(`App version: ${manifest.appVersion}`)) {
    fail("Operating manual does not bind the current app version");
  }

  for (const [relativePath, content] of [
    ["release/version-registry.json", read("release/version-registry.json")],
    [registry.environmentManifestPath, read(registry.environmentManifestPath)],
    [manifestPath, read(manifestPath)],
    [manualPath, manual]
  ]) {
    if (looksSecretBearing(content)) {
      fail(`Release artifact appears to contain raw secret material: ${relativePath}`);
    }
  }
}

if (failures.length > 0) {
  console.error("GetDone Phase 41 release verification failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log("GetDone Phase 41 release verification passed.");
