# GetDone — UFO v2

GetDone is an iPhone-first owner control surface for a governed autonomous execution system. The permanent owner navigation remains intentionally small: **Home · Decisions · Resources**. Home is the Objective Inbox: owners describe desired outcomes while Tasks, Jobs, provider execution, and verification stay behind the control-plane boundary.

The repository is now substantially beyond the original Phase 1 visual scaffold. It contains the mobile owner surface plus a deterministic control-plane foundation for scope, capability, planning, policy, authorization, verification, operational memory, resource registry, and resource enrollment.

## Authority rule

**AI thinks. GetDone authorizes. Workers execute. Resources supply capacity. Verification establishes truth.**

The frontend, AI providers, workers, resource agents, callbacks, and infrastructure providers are never execution authority by themselves.

## Implemented deterministic foundation

Current code includes:

- iPhone-first Home / Decisions / Resources owner surface, with Home as the Objective Inbox and Decisions as the owner-attention queue
- Control API 1.5 HTTP/application-adapter surface for Objective intake/reads, owner intents, Decisions, Resources/discovery, governed Resource Enrollment, Jobs/results, Verification, and health; default runtime fails closed until authoritative auth/persistence adapters are installed
- trusted execution scope and tenant tampering guards
- authentication/session/step-up contracts
- capability registry with runtime input/output schemas
- Phase 4 deterministic Company Integration Registry with explicit read/write scopes, environment binding, credential-reference-only records, lifecycle transitions, tenant enforcement, and DEVELOPMENT-only mock adapters
- Phase 13 deterministic AI Gateway with provider-neutral role/requirement/profile contracts, hard eligibility filtering, configuration-driven routing/fallback, budgets/concurrency, atomic budget-reservation contracts, kill switches, response-schema validation, typed terminal failure taxonomy, audit records, DEVELOPMENT-only mock adapter, and an implemented-but-unconfigured OpenRouter adapter with timeout/retry/identity/canary handling
- Phases 19–21 durable Job Store/lease/recovery contracts, business action adapter SDK/conformance boundary, and software-worker/deployment authorization/evidence contracts
- architecture dependency-boundary matrix, Resource Fabric internal-module split behind stable public exports, real Vitest V8 statement/branch/function/line coverage thresholds, a separate control-plane module/test-map gate, Playwright desktop/mobile E2E coverage, production/full-graph dependency audits, committed-secret scanning, Node-24 Actions, hashed quality/security release evidence, contract-version drift verification, and deterministic adversarial vectors
- objectives, guardrails, budgets, kill switches, and protected capacity
- authoritative Goal / Plan / Decision / Approval / Task / Job / Outcome / Event transitions
- atomic control-plane transaction and idempotency contracts
- Plan/step hashes, validation receipts, policy snapshots, authorization grants, approval proofs, and authorization-consumption records
- deterministic signals, sensing, investigations, research, and bounded context assembly
- deterministic Plan validation, policy classification, Task generation, and DAG compilation
- Phase 22 verification requests, evidence, strategy results, hash-bound receipts, freshness/expiry, authoritative verifier-source bindings/trust attestations, independence rules, and authoritative verification transitions
- Task / Job / Outcome truth transitions bound to verification receipts
- Phase 23 advisory operational memory with Fact, Lesson, Experiment, Observation, OutcomeReference, confidence, sample size, confounders, expiry, supersession, relevance selection, and strict company isolation
- Phase 24 attributed portfolio executive summaries plus automated adversarial security boundaries for auth, tenancy, callbacks, credentials, context contamination, external authority claims, kill switches, production promotion, and future Resource Fabric spoof/replay cases
- Phase 25 PWA/mobile foundation with standalone manifest, offline-only service-worker shell caching, redacted push presentation, safe deep links, explicit update/reconnect signaling, deterministic notification routing, and WebAuthn origin/RP/user-verification checks
- Phase 26 authoritative Resource Registry vocabulary, evidence records, readiness evaluation, lifecycle service, and concise read models
- Phase 27 deterministic Resource Enrollment workflow with hashed one-time challenges, expiry/replay protection, scope preservation, restart/cancel semantics, evidence, and lifecycle audit
- Phase 29 deterministic secret references, credential bindings, minimum-scope credential leases, expiry/revocation, secure-delivery references, and credential usage audit contracts
- Phase 30 deterministic resource profiling, independently validated privileged capabilities, authenticated telemetry health summarization, and a zero-side-effect resource telemetry simulator
- Phase 31 deterministic resource/data placement policy with HOME/customer-data/critical-copy defaults, encryption, region, reliability, fallback, interruption, and workload hard constraints
- Phase 32 control-plane-only placement requests, active idempotency reuse, snapshot-bound candidate evaluation, full rejection reasons, and explainable eligibility without reservation or dispatch
- Phase 33 deterministic resource/pool capacity ledgers, CAS-bound atomic reservation commit envelopes, scoped idempotency, leases/renewal/expiry, requested-vs-granted capacity, protected headroom, cancellation/release, pending allocation records, and exactly-once deterministic capacity restoration
- Phase 34 deterministic scheduler/dispatch foundation with Phase-35-governed eligible-only ranking, hash-bound placement decisions, retry/fallback lineage, live Phase-33 reservation gating, Phase-29 credential binding, short-lived final dispatch-admission receipts, trusted independent start/completion verification, explainable audit records, and release through Phase 33
- authoritative Phase 34 → JobService execution bridge: claimed Jobs can enter running only from persisted hash-bound verified-start facts; completion can enter Job verification only from the matching verified-completion lineage; provider acceptance never establishes Job truth
- deterministic 19-stage cross-phase golden-path harness spanning Objective → Plan → Validation → Policy → Decision → Approval → Task → Job → Placement → Governor → Reservation → Credential → Dispatch → verified start → Job running → verified completion → Outcome → advisory memory → release, explicitly simulation-only
- Phase 35 deterministic cost/capacity governor with owned/committed/reserved/spot/on-demand economics, protected headroom, quotas, budget caps/approval thresholds, eligible-only economic ranking, and estimate-vs-actual reconciliation
- Phase 36 deterministic Storage Fabric with authoritative/non-authoritative copy roles, HOME authority guardrails, replication/failure-domain constraints, residency/encryption/RPO/RTO checks, and explainable storage placement
- Phase 37 deterministic failure-domain/circuit-breaker admission, drain state machine, correlated-domain failover planning, temporary-cost recording, and evidence-gated verified recovery
- Phase 38 provider-neutral Resource Adapter SDK with discover/auth/capability/health/capacity/cost/reserve/allocate/dispatch/status/cancel/release operations, conformance checks, non-authoritative evidence, and DEVELOPMENT-only mock adapter
- Phase 39 governed aggregate ResourcePool contracts with tenant/environment/data/capability rules, failure-domain/credential/policy bindings, aggregate capacity/quota/headroom invariants, readiness evidence, and concise owner-facing read models
- Phase 40 full zero-side-effect resource policy simulator with historical-vs-projection labeling, policy/economic/scheduler/guardrail simulation, uncertainty, AI Gateway model-evidence recording, and explicit no-mutation/no-reservation/no-dispatch/no-secret-lookup guarantees
- Phase 41 machine-readable version registry and environment manifest plus per-release Git-SHA-bound machine manifest, generated operating manual, CI evidence hashing/validation, and archived release artifacts
- Phase 42 deterministic voice intent/secure-handoff contracts with typed canonical intents, transcript-hash-only evidence, current-policy/Control-API binding, no approval/step-up/execution authority, credential rejection, scoped audit records, and Phase-41 release-registry integration
- Phase 44 deterministic offline adversarial harness covering voice approval bypass, staging→production credential misuse, forged resource capability, reservation replay, scheduler bypass, provider-success spoofing, credential escalation, cross-company contamination, release-registry tampering, and model/provider authority attempts

## Not yet production-complete

The repository does **not** claim production autonomy yet. Canonical acceptance still requires real infrastructure for:

- production authentication/session persistence
- authoritative database transactions, migrations, and RLS
- a real OpenRouter credential plus active AI Gateway routing configuration and a passing live canary
- durable distributed queue, worker leases, schedules, and crash recovery
- real provider-specific business adapters and a production software deployment executor; business-action orchestration, durable execution routing, and the resumable software-worker runtime are implemented
- real Resource Fabric agent/hardware enrollment
- production secret backend/token exchange and secure credential delivery transport
- live authenticated hardware profiling/telemetry and Resource Fabric signal emission
- durable transactional persistence for Phase 33 reservation/CAS commits plus live resource-adapter dispatch, production start/completion probes, authoritative production Job-execution-bridge persistence/recovery, scheduler persistence/recovery, failover, and measured economic execution
- real Home NAS/storage runtime, live failure-domain orchestration, a real second resource provider, and partner/data-center pool execution
- production historical placement/cost/AI-route analytics stores and simulation evidence persistence
- production push subscription/delivery provider and notification persistence
- cryptographic WebAuthn/passkey verification through a real auth provider
- live speech/voice transport or native iPhone voice adapter plus production persistence for Phase 42
- end-to-end production acceptance evidence

Deterministic contracts and unit tests are intentionally built ahead of those integrations so later agents consume the existing authority model rather than replacing it.

## Run locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Verify

```bash
npm run verify:dependencies
npm run verify:runtime
npm run verify:secrets
npm run verify:architecture
npm run verify:contract-versions
npm run typecheck
npm run lint
npm test
npm run verify:coverage
npm run build
npm run test:e2e
npm run release:generate
npm run verify:release
```

## Current owner routes

- `/` — Home / Objective Inbox
- `/objectives/[id]` — outcome-first Objective detail without Task/Job machinery
- `/decisions` — owner-level Decision Center / human-attention queue
- `/decisions/[id]` — development decision detail
- `/resources` — resource overview
- `/resources/add` — add-resource visual flow
- `/resources/[id]` — resource detail
- `/sign-in` — sign-in visual shell
- `/offline` — explicit offline state
- `/api/health` — service capability/connection health
- `/api/control/health` — Control API runtime/connection truth
- `/api/control/chat` and `/api/control/intents` — owner intent ingestion
- `/api/control/decisions[/id]` — scoped Decision reads/mutations
- `/api/control/resources[/id]` — scoped Resource reads plus POST discovery
- `/api/control/resources/enroll` and `/api/control/resource-enrollments[/id][/actions]` — governed Resource Enrollment
- `/api/control/jobs[/id][/result]` — scoped Jobs and result truth
- `/api/control/verifications[/id]` — scoped Verification reads
- `/api/dev/resources` and `/api/dev/decisions` — development-only seed reads, hard-disabled in production

## Read before continuing

Use these as the implementation source of truth:

- `docs/GetDone_UFO_v2_MASTER_BUILD_PLAN.md`
- `docs/SOL_IMPLEMENTATION_STATUS.md`
- `docs/SOL_20_AUTHORITY_HARDENING_REPORT.md`
- `docs/SOL_PHASE_22_23_26_27_REPORT.md`
- `docs/SOL_PHASE_24_25_REPORT.md`
- `docs/SOL_PHASE_29_32_REPORT.md`
- `docs/SOL_PHASE_33_REPORT.md`
- `docs/SOL_PHASE_34_REPORT.md`
- `docs/SOL_PHASE_35_40_REPORT.md`
- `docs/SOL_ARCHITECTURE_INTEGRITY_REPORT.md`
- `docs/SOL_PHASE_41_REPORT.md`
- `docs/SOL_PHASE_42_REPORT.md`
- `docs/SOL_QUALITY_PHASE_4_13_19_21_REPORT.md`
- `docs/SOL_QUALITY_V8_PLAYWRIGHT_AI_BUDGET_REPORT.md`
- `docs/SOL_CONTROL_API_OPENROUTER_SECURITY_REPORT.md`
- `docs/SOL_POSTGRES_JOB_EXECUTION_RUNTIME_REPORT.md`
- `docs/SOL_PHASE_36_39_44_REPORT.md`
- `docs/SOL_GOLDEN_PATH_JOB_BRIDGE_REPORT.md`
- `release/version-registry.json`
- `release/environment-manifest.json`
- `docs/ASTRA_HANDOFF.md`

No phase is complete merely because code exists. Canonical PASS still requires the acceptance evidence specified by the master build plan.
