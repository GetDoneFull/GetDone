# GetDone architecture baseline

## Current repository shape

GetDone remains a single Next.js TypeScript repository while the deterministic control-plane contracts are built ahead of production infrastructure. That is an implementation packaging choice, not an authority shortcut.

### Owner experience

The permanent owner navigation is intentionally fixed at:

**Home · Decisions · Resources**

Backend/resource complexity must not turn the product into an infrastructure admin console.

### Implemented deterministic boundaries

- screenshot-aligned iPhone-first owner shell;
- typed Control API envelopes and trusted execution scope;
- auth/session and step-up contracts;
- policy, authorization grants, approval proofs, Tasks/Jobs/Outcomes/Events;
- Phase 22 verification receipts plus authoritative verifier-source trust attestations;
- Phase 23 advisory memory;
- Phase 25 PWA/service worker, safe deep links, notifications, and WebAuthn ceremony boundary;
- Phase 26/27 Resource Registry and enrollment contracts;
- Phase 29 minimum-scope credential leases;
- Phase 30 profiling/telemetry contracts;
- Phase 31 hard resource/data policy;
- Phase 32 placement eligibility;
- Phase 33 reservation/capacity-ledger CAS contracts;
- Phase 34 scheduler/dispatch contracts plus the verified-start/completion bridge into JobService;
- Phase 35 cost/capacity governor;
- Phase 36 storage placement/replication/authoritative-copy contracts;
- Phase 37 failure-domain admission, drain, and failover contracts;
- Phase 38 Resource Adapter SDK/conformance boundary;
- Phase 39 governed aggregate ResourcePool contracts;
- Phase 40 zero-side-effect simulator;
- Phase 41 release/version registry, explicit environment/deployment state, generated Git-SHA-bound machine manifests, operating manuals, and CI evidence archive;
- Phase 42 typed voice intents and secure phone handoff, bound to trusted scope, current policy, Control API, audit, and the Phase 41 release registry;
- Phase 4 deterministic Company Integration Registry;
- Phase 13 provider-neutral AI Gateway contract/router/budget/audit foundation;
- Phases 19–21 durable Job runtime, business action adapter, and software worker/deployment contracts;
- architecture dependency-boundary matrix, contract-version drift verification, module/test coverage thresholds, and adversarial contract vectors;
- Phase 44 deterministic offline adversarial harness over real exported authority boundaries.

### Quality and contract-integrity gates

The Resource Fabric public imports remain `@/lib/resources/scheduler` and `@/lib/resources/reservations`; implementation/types are split behind `lib/resources/internal/`.

`architecture/dependency-boundaries.json` prevents internal/execution authority from leaking into UI, voice, integrations, AI cognition, or business adapters.

`npm run verify:contract-versions` fails if a tracked contract changes without a semantic-version bump. `npm run verify:coverage` produces module/test-contract coverage evidence for critical control-plane boundaries and applies CI thresholds.

### Architecture-integrity composition

The authoritative resource-execution path is now constrained to:

```text
authorized Job
  -> Phase 32 hard placement eligibility
  -> Phase 35 cost/capacity governor admission
  -> Phase 34 bounded preference ranking
  -> Phase 34 placement decision
  -> Phase 33 reservation + pending allocation
  -> Phase 29 scoped credential lease
  -> final dispatch-admission receipt
       - current policy registry
       - current kill switches
       - READY/environment permission
       - governor freshness/admission
       - reservation freshness
       - credential freshness/scope
  -> resource adapter dispatch
  -> trusted independent verifier-source attestation
  -> verified running placement
  -> persisted JobVerifiedStartFact
  -> JobService claimed -> running
  -> monitoring
  -> trusted completion verification
  -> persisted JobVerifiedCompletionFact
  -> JobService running -> verifying
  -> authoritative Job verification receipt
  -> JobService verifying -> succeeded
  -> Phase 33 exact-once release
```

Provider `accepted`, HTTP success, resource-agent claims, model output, and frontend state are evidence only. They do not establish Job running/success, placement truth, verification truth, approval, policy mutation, or production authority. Job running requires an authoritative persisted verified-start bridge fact derived from Phase 34 independent verification; final Job success still requires an authoritative Job verification receipt.

### AI boundary

The deterministic Phase 13 GetDone-owned AI Gateway now exists under `lib/ai-gateway`. It defines roles, requirement envelopes, validated model profiles, hard eligibility, configuration-driven routes/fallbacks, budget/concurrency admission, kill-switch filtering, schema validation, and audit records.

No live OpenRouter/provider adapter, key, canary, or active routing configuration is connected yet. Provider/model SDK imports and provider HTTP endpoints remain forbidden outside this boundary by `npm run verify:architecture`. DETERMINISTIC work is explicitly prohibited from invoking a model adapter.

### Integration boundary

`lib/integrations` owns the deterministic Company Integration Registry. Integration records are company/environment scoped, separate read/write scopes, and store credential-binding references rather than raw credentials. The in-repo adapter is DEVELOPMENT-only. Real OAuth/API adapters remain unconnected.

### Durable execution boundary

`lib/execution` now defines the provider-neutral contracts for durable Job leases/recovery, business action adapters, and the software-worker/deployment pipeline. There is deliberately no production in-memory queue/store, live business adapter, or production deployment executor.

Provider acceptance remains evidence only; JobService and verification remain authoritative. The Phase 34 → JobService bridge persists hash-bound verified-start/completion facts and strips provider acceptance out of Job authority. Production software promotion requires explicit approval + staging-verification lineage.

### Cross-phase composition boundary

`lib/composition/golden-path-harness.ts` is deterministic composition evidence, not runtime infrastructure. It executes the 19-stage Objective-to-release path using fixed clocks and deterministic stores/adapters, returns `simulationOnly: true` and `productionExecutionClaimed: false`, and is blocked by the dependency matrix from production UI/feature imports. Its purpose is to catch incorrect phase-to-phase wiring without turning simulation success into production acceptance.

### Resource Fabric storage/resilience/provider boundary

Storage placement is separate from compute authority. HOME may host approved secondary/cache/artifact/rebuildable workloads but cannot silently become sole production authority. Authoritative replication plans must satisfy policy, freshness, encryption, RPO/RTO, and failure-domain constraints.

Failure-domain degradation/circuit breakers stop unsafe new placement while allowing existing healthy work to remain when policy permits. Failover cannot claim recovery from dispatch/provider success; verified recovery requires independent verification evidence plus healthy post-failover state.

The Resource Adapter SDK returns provider evidence with `authoritative: false`. Provider-specific code cannot set Job truth, trust, policy, or verification truth. Aggregate ResourcePools remain subject to the same tenant, environment, policy, credential, failure-domain, and scheduling boundaries.

### Voice boundary

Voice is an evidence/query/initiation surface, not an authority system.

The deterministic Phase 42 path is:

```text
speech/NLU adapter evidence
  -> typed VoiceAdapterCandidate
  -> server-injected TrustedExecutionScope
  -> current PolicyRegistryReference
  -> VoiceIntentRecord
       - canApprove=false
       - canStepUp=false
       - canExecuteSideEffect=false
       - canAcceptRawCredentials=false
  -> existing Control API query OR proposed workflow
  -> secure iPhone handoff for sensitive/mutating work
  -> existing policy/approval/step-up/worker/verification paths
```

The authoritative record stores only a transcript SHA-256, not raw voice text/audio. Raw credentials are rejected at voice ingress. The live speech/native-iPhone adapter remains unconnected and is explicitly versioned as such.

### Browser boundary

The browser cannot approve production actions, set Job/resource truth, enroll infrastructure authoritatively, store production secrets, choose its own trusted scope, or execute model/provider work.

Development seed data is confined to the development read-repository seam and fails closed outside allowed runtime modes.

### CI architecture gate

`npm run verify:architecture` protects high-value invariants, including:

- permanent Home / Decisions / Resources navigation, with Home serving as the Objective Inbox;
- the authority rule in README;
- provider/model SDK isolation behind `lib/ai-gateway`;
- no secret-like `NEXT_PUBLIC_*` variables;
- DEVELOPMENT seed-data import isolation;
- zero-side-effect simulator isolation from reservation/dispatch/credential modules;
- Phase 34 governor, credential, admission, trusted-verifier, verified-start/completion Job bridge, and Job-truth bindings;
- golden-path harness simulation-only/non-production invariants and production import isolation;
- no stale architecture documentation claiming the Phase 25 service worker is still deferred;
- Phase 42 voice cannot import approval/credential/dispatch authority, weaken secure approval/credential handoff, or drift from the release-registry environment state;
- Phase 36 HOME/authoritative-storage guardrails;
- Phase 37 failover evidence requirement;
- Phase 38 provider-adapter non-authority and DEVELOPMENT mock boundary;
- Phase 39 pool governance and tenant isolation;
- Phase 44 exact blocking-vector completeness.

The drift gate is additive to secret scan, TypeScript, lint, unit tests, and production build.

### Release truth

Phase 41 makes repository/release anatomy machine-reconstructable without overstating production status.

Committed inputs:
- `release/version-registry.json`;
- `release/environment-manifest.json`.

After the normal CI build gate, `npm run release:generate` creates a machine manifest and operating manual for the exact checked-out Git SHA. `npm run verify:release` re-hashes package lock, declared schema/adapter sources, policy sources, environment declarations, evidence/manual sources, and the generated manual. GitHub Actions archives the verified `release/out/` artifacts.

Disconnected infrastructure is versioned explicitly as `UNIMPLEMENTED`/`UNCONFIGURED` rather than guessed. Phase 42 voice contract/adapter/environment state is included in the same generated manifest/manual and is production-required while its live adapter remains explicitly unconnected. Production readiness remains false until real acceptance evidence exists.

## Production status

Deterministic code is not production autonomy. Production acceptance still requires real authentication/persistence/RLS, durable jobs, live AI Gateway, live resource agents/telemetry, transactional Phase 33 persistence, real adapters/probes, billing feeds, storage/failover, a live Phase 42 speech/native-iPhone adapter, and end-to-end acceptance evidence.
