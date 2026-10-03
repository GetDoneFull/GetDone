# UFO Attention Compression — Durable Policy Authorization

## Scope

PR #74 now extends the nervous-system path from deterministic policy evidence into exact execution authority:

    policy-evaluated
      -> BLOCKED
      -> awaiting-decision
      -> authorized

This tranche does not create Tasks or Jobs. authorized means that every Plan step has an active, hash-bound AuthorizationGrant whose authority can later be consumed exactly once by Task generation.

The coordinator remains coordination-only. It references authority created by the policy/Decision/authorization services; it does not bypass them.

## Authority routes

The aggregate durable policy artifact is the only input to this stage.

    policy-evaluated
       |
       +-- BLOCKED ---------------------> blocked
       |
       +-- APPROVAL_REQUIRED ----------> Decision -> awaiting-decision
       |
       +-- STRONG_APPROVAL ------------> Decision + fresh step-up -> awaiting-decision
       |
       +-- AUTO ------------------------> exact AuthorizationGrant
                                             |
                                             v
                                         authorized

For a multi-step Plan, each step keeps its own disposition. The Plan reaches authorized only when every step has an active exact grant.

## Immutable authorization lineage

The stage loads only the artifacts referenced by orchestration checkpoints:

- PersistedPlanProposal from checkpoints.plan
- DurableValidationArtifact from checkpoints.validationReceipt
- DurablePolicyEvaluationArtifact from checkpoints.policySnapshot

Before any Decision or grant is created, GetDone verifies orchestration run/correlation identity, portfolio/company tenant, environment, Plan artifact ID/hash, Plan hash, validation receipt ID/hash, policy artifact ID/hash, and every step/PolicySnapshot lineage.

A model response, mutable owner message, or live reconstruction cannot replace these artifacts.

## Approval Decisions

Every step whose frozen policy disposition is APPROVAL_REQUIRED or STRONG_APPROVAL receives one deterministic authoritative Decision.

Decision ID:

    decision:<run-id>:policy-v<validated-run-version>:<step-id>

The Decision contains an immutable OrchestrationApprovalBinding with the orchestration run ID, policy evaluation artifact ID/hash, Plan artifact ID/hash, Plan hash, step ID/hash, PolicySnapshot ID/hash, validation receipt ID/hash, required approval level, and latest permitted approval-proof expiry.

requiresStepUp is derived from policy. The Decision cannot choose its own requirement.

### Decision creation idempotency

Decision creation uses the deterministic ID plus immutable approval binding.

A retry may encounter an evolved Decision because the owner resolved it after Decision creation committed but before orchestration CAS. That replay is accepted only when the immutable authorization binding is identical.

A different tenant, correlation, Plan hash, step hash, PolicySnapshot hash, receipt hash, or approval requirement is an idempotency conflict.

This closes the crash race where a Decision is inserted, the process dies before orchestration CAS, and the owner resolves the already-visible Decision before the policy stage retries.

## Owner approval proof

The owner Decision mutation remains the authoritative control-plane transaction.

For an orchestration approval, resolveDecision() creates an exact ApprovalProof inside that transaction. The proof binds Decision ID, deterministic approval ID, approving actor, trusted scope, approval level, Plan hash, step hash, validity window, and strong step-up proof ID when required.

Normal approval does not inherit an unrelated active step-up session. Strong approval requires and cryptographically binds a fresh StepUpProof.

The Decision stores the resulting proof. Strong approvals also retain the exact StepUpProof needed for later policy/grant revalidation.

## Atomic Decision resume outbox

The same authoritative PostgreSQL transaction that resolves an orchestration Decision also writes a DecisionResumeRequest.

    BEGIN SERIALIZABLE
      idempotency claim
      Decision CAS
      exact ApprovalProof when approved
      audit append
      DecisionResumeRequest INSERT
      idempotency complete
    COMMIT

Production Decision resolution therefore cannot commit successfully while silently losing the evidence needed to resume its orchestration.

Resume request ID:

    decision-resume:<decision-id>:v<resolved-decision-version>

The request is hash-bound and records orchestration run ID, Decision ID/version, correlation ID, portfolio/company, approved/modified/rejected result, and creation time.

Migration 2026-09-28.6_ufo_authorization.sql persists these requests in orchestration_decision_resume_requests.

## Decision resume dispatcher

awaiting-decision remains excluded from the generic orchestration worker.

An explicit DecisionResumeDispatcher processes durable Decision-resolution evidence. The Control API invokes it immediately after the Decision transaction commits for low latency. That invocation is only a wakeup optimization: failure does not change the committed owner Decision because the outbox row remains durable.

The dispatcher can also drain pending requests inside a trusted tenant scope for restart recovery.

For each request it verifies run ID, correlation ID, portfolio/company, and that the Decision is one of the run checkpoint Decision IDs.

## Approval outcomes

Pending: the run remains awaiting-decision. Each later Decision resolution emits its own durable request.

Rejected: awaiting-decision -> blocked. No grant is minted.

Modified: awaiting-decision -> blocked with replanning required. A modification cannot mutate an already validated Plan in place.

Approved: every required Decision must be approved and possess an exact ApprovalProof. Strong policy requirements additionally require the matching fresh StepUpProof.

## Re-evaluate policy with proof

Approval is not treated as a generic yes. For each approved step GetDone re-runs the existing deterministic policy engine against the frozen PolicySnapshot with the exact ApprovalProof and StepUpProof when required.

The resulting disposition must equal the originally persisted disposition and readyForTaskGeneration must become true.

An approval for Plan A / Step 3 therefore cannot authorize Plan A / Step 4, Plan B / Step 3, another company, or another environment.

## Exact-hash AuthorizationGrant

Grant IDs are deterministic:

    authorization-grant:<run-id>:pv<validated-run-version>:<step-id>

The grant retains the existing full authorization envelope: trusted scope, Plan ID/version/hash, step ID/hash, capability set, validation receipt ID/hash, PolicySnapshot ID/hash, policy registry/engine/rules versions, disposition, Decision/ApprovalProof/StepUpProof lineage when required, actor, issuedAt, expiresAt, and grantHash.

issueAuthorizationGrant() remains the authority constructor. The orchestration layer does not manually construct a weaker grant.

## Grant validity window

The grant expiry is the earliest of configured authorization TTL, validation receipt expiry, credential snapshot expiry, protected-capacity snapshot expiry, budget reservation expiry, ApprovalProof expiry, and StepUpProof expiry.

If any required evidence is already stale, authorization fails closed.

AUTO grants use the durable policy artifact creation time as deterministic issue time. Approval grants use the authoritative ApprovalProof grant time. Grant content therefore remains deterministic across crash replay.

## Atomic grant batch

A multi-step Plan must not leave a valid subset of execution authority if a later grant fails to persist.

All step grants are constructed and validated first, then persisted as one PostgreSQL transaction.

Batch idempotency key:

    orchestration:<run-id>:policy-v<validated-run-version>:authorization-batch

The batch fingerprint is the sorted set of grant ID + grant hash.

    BEGIN SERIALIZABLE
      idempotency claim
      grant 1 INSERT/replay
      grant 2 INSERT/replay
      ...
      grant N INSERT/replay
      idempotency complete
    COMMIT

If any insert conflicts, the whole new batch transaction rolls back. Existing authorization_grants tenant RLS and exact ID/hash replay semantics remain in force.

## Transaction boundaries

AUTO route:

    TX A: atomic grant batch
    COMMIT
    TX B: orchestration CAS policy-evaluated -> authorized
    COMMIT

Approval route:

    TX A..N: deterministic Decision creates/replays
    COMMIT
    TX N+1: orchestration CAS policy-evaluated -> awaiting-decision
    COMMIT

Owner mutation:

    TX A: Decision CAS + ApprovalProof + audit + resume outbox + idempotency completion
    COMMIT

Explicit resume:

    TX B: atomic exact grant batch
    COMMIT
    TX C: orchestration CAS awaiting-decision -> authorized
    COMMIT
    TX D: mark resume outbox processed
    COMMIT

No transaction is held open across owner interaction.

## Crash recovery

Crash after Decision create, before awaiting-decision CAS: retry reuses the same deterministic Decision. If the owner already resolved it, GetDone accepts the evolved Decision only when its immutable approval binding is identical. Approved Decisions may authorize directly; rejected/modified Decisions block.

Crash after owner approval, before resume dispatch: Decision, ApprovalProof, audit event, and resume outbox committed atomically. The pending outbox survives.

Crash during grant construction: no execution authority has been persisted yet. Retry reconstructs the same candidates.

Crash during grant batch transaction: PostgreSQL rolls the batch back. No partial new grant set remains active.

Crash after grant batch commit, before orchestration CAS: retry uses the same batch idempotency key/fingerprint. Exact grant IDs/hashes replay and only CAS remains.

Crash after authorized CAS, before outbox processed: replay sees the run already advanced, marks the outbox processed, and does not mint new authority.

Stale evidence after a crash: the persisted grant is checked for current scope/time validity before the authorized checkpoint is committed. GetDone fails closed rather than reviving stale authority.

## Tenant scoping

All reads and writes run under the orchestration trusted portfolio/company context.

Existing forced RLS protects control_plane_entities Decisions and authorization_grants. Migration 2026-09-28.6 adds forced RLS for orchestration_decision_resume_requests.

Application lineage checks additionally reject cross-tenant Decision bindings even if a storage adapter is misused.

## What authorized means

authorized requires immutable Plan lineage, clean validation, frozen deterministic policy evaluation, all required owner Decisions approved, exact ApprovalProof/StepUpProof where required, one active AuthorizationGrant per Plan step, and orchestration checkpoint refs containing exact grant IDs/hashes.

It still means no Tasks, no Jobs, and no provider execution.

The next stage must consume these exact grants through the existing Task generator and authorization-consumption rules.

## Acceptance requirements

1. BLOCKED policy can never produce a grant.
2. AUTO may authorize without a Decision only through the existing exact grant constructor.
3. APPROVAL_REQUIRED creates a deterministic Decision and pauses.
4. STRONG_APPROVAL requires fresh step-up.
5. Decision approval creates an exact Plan/step ApprovalProof.
6. Reject creates no approval authority.
7. Modify requires replanning rather than mutating validated work.
8. Decision resolution and resume outbox commit atomically.
9. Decision create replay tolerates legitimate later owner resolution only when immutable binding is identical.
10. Every approved step is re-evaluated against its frozen PolicySnapshot.
11. Every grant exactly matches Plan, step, receipt, policy, proof, actor, tenant, and time window.
12. Multi-step grant persistence is atomic.
13. Grant batch replay uses one deterministic idempotency key/fingerprint.
14. Crash after grant commit but before orchestration CAS reuses exact grants.
15. Crash after authorized CAS but before outbox completion is replay-safe.
16. awaiting-decision remains excluded from generic worker claims.
17. Decisions, resume requests, and grants remain tenant isolated.
18. authorized creates no Task, Job, or provider effect.
