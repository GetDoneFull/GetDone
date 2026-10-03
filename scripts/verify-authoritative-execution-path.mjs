import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function walk(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist-worker") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(absolute));
    else result.push(absolute);
  }
  return result;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function productionTsFiles(directory) {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];
  return walk(absolute)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => !/\.(test|integration|acceptance)\./.test(file));
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

const libFiles = productionTsFiles("lib");
const appFiles = productionTsFiles("app");

// The orchestration coordinator is coordination-only. It may enqueue work through
// the governed Job runtime port, but it must never reach provider invocation
// code or concrete provider adapters.
for (const file of libFiles.filter((file) => relative(file).startsWith("lib/orchestration/"))) {
  const name = relative(file);
  const content = fs.readFileSync(file, "utf8");
  const forbidden = [
    "@/lib/execution/business-action-orchestrator",
    "@/lib/execution/adapters/configured-http-action",
    "@/lib/execution/adapters/configured-webhook-action",
    "@/lib/execution/adapters/gmail-action",
    "@/lib/execution/adapters/slack-action",
    "@/lib/execution/adapters/crm-action",
    "@/lib/execution/adapters/github-standard-operation"
  ];
  for (const boundary of forbidden) {
    if (content.includes(boundary)) {
      fail(`Orchestration escaped into provider execution boundary: ${name} -> ${boundary}`);
    }
  }
  if (/\b(fetch|axios)\s*\(/.test(content)) {
    fail(`Orchestration contains a direct network/provider call: ${name}`);
  }
}

// Provider calls may be made only by the Job execution router -> business action
// orchestrator chain. Construction/wiring may import the orchestrator but may not
// execute it directly.
for (const file of libFiles) {
  const name = relative(file);
  const content = fs.readFileSync(file, "utf8");
  if (
    content.includes("this.business.execute(")
    && name !== "lib/execution/job-execution-router.ts"
  ) {
    fail(`BusinessActionExecutionOrchestrator execution escaped Job router: ${name}`);
  }
  if (
    content.includes("BusinessActionAdapter")
    && /\badapter\.(execute|status|cancel)\s*\(/.test(content)
    && ![
      "lib/execution/business-action-orchestrator.ts",
      "lib/execution/adapters/business-action-conformance.ts"
    ].includes(name)
  ) {
    fail(`Operational BusinessAction adapter invocation escaped the governed Job router/orchestrator chain: ${name}`);
  }
  if (
    content.includes("enqueueAuthorizedBusinessAction(")
    && ![
      "lib/execution/mvp-job-runtime.server.ts",
      "lib/orchestration/post-authorization-runtime.server.ts"
    ].includes(name)
  ) {
    fail(`Durable Job enqueue escaped authoritative orchestration path: ${name}`);
  }
}

// Provider adapters are mechanisms, not authority. They may validate their own
// IO contract but cannot import planning, policy, Decisions, grants, or the
// orchestration coordinator.
for (const file of libFiles.filter((file) =>
  relative(file).startsWith("lib/execution/adapters/")
)) {
  const name = relative(file);
  const content = fs.readFileSync(file, "utf8");
  const forbidden = [
    "@/lib/orchestration/",
    "@/lib/planning/policy",
    "@/lib/authorization/grants",
    "@/lib/domain/decision-service"
  ];
  for (const boundary of forbidden) {
    if (content.includes(boundary)) {
      fail(`Provider adapter attempted to decide authority/policy: ${name} -> ${boundary}`);
    }
  }
}

// Model code can propose; it cannot mint authority, consume grants, create Jobs,
// or reach providers.
for (const file of libFiles.filter((file) => relative(file).startsWith("lib/ai-gateway/"))) {
  const name = relative(file);
  const content = fs.readFileSync(file, "utf8");
  const forbidden = [
    "@/lib/authorization/grants",
    "@/lib/domain/decision-service",
    "@/lib/domain/services/task-service",
    "@/lib/domain/services/job-service",
    "@/lib/execution/adapters/",
    "@/lib/execution/business-action-orchestrator",
    "@/lib/persistence/postgres/"
  ];
  for (const boundary of forbidden) {
    if (content.includes(boundary)) {
      fail(`AI gateway crossed proposal-only authority boundary: ${name} -> ${boundary}`);
    }
  }
}

// Client/UI code is a projection only. API/server routes may call authoritative
// services, but ordinary UI modules cannot import Postgres or execution runtime.
for (const file of appFiles.filter((file) => !relative(file).startsWith("app/api/"))) {
  const name = relative(file);
  const content = fs.readFileSync(file, "utf8");
  const forbidden = [
    "@/lib/persistence/postgres/",
    "@/lib/execution/mvp-job-runtime.server",
    "@/lib/execution/business-action-orchestrator",
    "@/lib/execution/adapters/"
  ];
  for (const boundary of forbidden) {
    if (content.includes(boundary)) {
      fail(`UI state attempted to become authoritative: ${name} -> ${boundary}`);
    }
  }
}

const workflow = read("lib/composition/mvp-business-workflow.ts");
if (workflow.includes("enqueueAuthorizedBusinessAction(")) {
  fail("Legacy MVP business workflow still exposes a parallel execution path");
}

const router = read("lib/execution/job-execution-router.ts");
for (const invariant of [
  "validateBusinessAuthority",
  "authoritativeJobVersion",
  "authoritativeJobHash",
  "authorizationConsumptionHash",
  "this.business.execute(spec.request)"
]) {
  if (!router.includes(invariant)) {
    fail(`Governed Job router authority invariant missing: ${invariant}`);
  }
}

const adapterContract = read("lib/execution/adapters/business-action.ts");
for (const invariant of [
  "jobStateMutationApplied: false",
  "assertAuthorizedBusinessActionRequest",
  "authorizationConsumptionHash"
]) {
  if (!adapterContract.includes(invariant)) {
    fail(`Provider adapter non-authority invariant missing: ${invariant}`);
  }
}

const postAuthorization = read("lib/orchestration/post-authorization-flow.ts");
for (const invariant of [
  'providerCalls: "job-worker-only"',
  'authoritativeState: "postgresql"',
  "advanceAuthorizedToTasksCreated",
  "advanceTasksCreatedToJobsEnqueued",
  "advanceExecutingToVerifying",
  "advanceVerifyingToCompleted",
  "requiresVerifiedJobEvidence",
  "appendsAudit"
]) {
  if (!postAuthorization.includes(invariant)) {
    fail(`Authoritative post-authorization chain invariant missing: ${invariant}`);
  }
}

const postAuthorizationRuntime = read("lib/orchestration/post-authorization-runtime.server.ts");
for (const invariant of [
  'terminal.kind !== "provider-completed"',
  "this.jobLifecycle.beginVerification(",
  "this.jobLifecycle.verify(",
  "this.jobLifecycle.failVerification(",
  'prior.state === "verified"'
]) {
  if (!postAuthorizationRuntime.includes(invariant)) {
    fail(`Provider-completion verification handoff invariant missing: ${invariant}`);
  }
}
if (
  /state:\s*state\s*===\s*["']verified["']\s*\?\s*["']succeeded["']/.test(
    postAuthorizationRuntime
  )
) {
  fail("Authoritative orchestration must not emit legacy Job state succeeded after verification");
}
if (!postAuthorization.includes('"provider-completed"')) {
  fail("Orchestration Job graph contract must use provider-completed vocabulary");
}

const contract = read("docs/AUTHORITATIVE_EXECUTION_PATH.md");
for (const invariant of [
  "OwnerIntent / Objective",
  "Context Snapshot",
  "AuthorizationGrant",
  "Task DAG",
  "Capability Adapter",
  "Provider Result",
  "Objective Evaluation",
  "PostgreSQL-backed records remain authoritative"
]) {
  if (!contract.includes(invariant)) {
    fail(`Authoritative execution path documentation drifted: ${invariant}`);
  }
}

if (failures.length > 0) {
  console.error("Authoritative execution path verification failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log("Authoritative execution path verification passed.");
