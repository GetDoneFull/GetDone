# UFO Attention Compression — PostgreSQL Orchestration Persistence Contract

## Scope

This document defines the durable PostgreSQL contract for PR #74. The Nervous System Coordinator owns workflow checkpoint persistence only; it is not a second business Job Engine and remains authority = coordination-only.

The existing authority path stays intact: AI thinks → GetDone validates/policy-checks → owner approves when required → exact authorization grants permit Tasks → the durable Job runtime executes → verification establishes truth → Outcomes become learning evidence.

## Relations

PR #74 adds a tenant-scoped orchestration persistence family: canonical run/checkpoint relations plus durable worker state, frozen context/planner artifacts, validation artifacts, per-step policy snapshots, and aggregate policy-evaluation artifacts.

### orchestration_runs

One mutable row is the canonical restart pointer for one orchestration run. It stores run identity, correlation ID, trusted tenant/user/environment scope, source identity/hash, current state, version, attempt, start idempotency key, full record hash, current checkpoint JSON, full payload JSON, and timestamps.

Invariants:
- correlation_id is unique within portfolio/company.
- start_idempotency_key is unique within portfolio/company.
- authority must equal coordination-only.
- version starts at 1 and advances exactly once per committed transition.
- record_hash is the canonical hash of the full record.
- correlation/source/trusted-scope identity cannot change during CAS transitions.

### orchestration_transition_receipts

This is an immutable transition journal. Each successful CAS writes one receipt atomically with the run update.

Stored fields include run identity, tenant, idempotency key, from/to state, expected/next version, expected/next record hash, checkpoint hash, timestamp, and the resulting run payload.

Constraints:
- next_version = expected_version + 1.
- UNIQUE(run_id, idempotency_key).
- UNIQUE(run_id, next_version).

A retry with the same key and same hashes returns the persisted result. Reuse of the key with different content fails with IDEMPOTENCY_CONFLICT.

### orchestration_checkpoints

This is immutable checkpoint history. One snapshot is stored for every committed run version, including version 1.

Constraint:
- UNIQUE(run_id, run_version).

The current orchestration_runs.checkpoints value is the restart source of truth. Historical checkpoint rows exist for reconstruction and integrity evidence, not as a second authority source.

## Checkpoint payload

Checkpoint JSON stores references/hashes to existing authoritative artifacts rather than duplicating their authority:

~~~text
contextSnapshot
plannerInput
plan
validationReceipt
policySnapshot
decisionIds[]
authorizationGrants[]
tasks[]
jobIds[]
verificationRequestIds[]
verifiedOutcomes[]
~~~

Authorization grants retain id/hash/disposition. Task references retain id/hash/authorizationConsumptionHash. Verified Outcome references retain id plus verification receipt identity/hash.

## Start idempotency

Recommended start key:

~~~text
orchestration:start:<source-type>:<source-id>
~~~

Example:

~~~text
orchestration:start:owner-intent:<owner-intent-id>
~~~

A start retry is accepted only when tenant, idempotency key, correlation ID, and canonical run hash still match. Otherwise it is an idempotency conflict. One company correlation ID maps to only one orchestration run.

## Transition idempotency

Each transition uses a deterministic key:

~~~text
orchestration:<run-id>:v<expected-version>:<from-state>-><to-state>
~~~

Example:

~~~text
orchestration:run-42:v5:validated->policy-evaluated
~~~

Worker retries MUST reuse the same key instead of creating a new UUID.

## CAS transition

Each state transition is one SERIALIZABLE PostgreSQL transaction:

~~~text
1. Check receipt by run_id + idempotency_key.
2. If it exists and hashes match, return receipt.result.
3. If it exists but hashes differ, fail IDEMPOTENCY_CONFLICT.
4. SELECT orchestration run FOR UPDATE.
5. Verify current.version == expectedVersion.
6. Verify current.recordHash == expectedRecordHash.
7. Verify next-record integrity and immutable identity.
8. UPDATE orchestration_runs using id + expected version + expected hash.
9. INSERT immutable checkpoint snapshot.
10. INSERT immutable transition receipt.
11. COMMIT.
~~~

The run update, checkpoint, and receipt either all commit or all roll back.

## Stale worker behavior

Two workers may read the same version. Only one may advance it. The loser receives CONFLICT, reloads current state, and must not overwrite the newer version.

This is expected concurrency behavior, not corruption.

## Restart-safe worker behavior

A coordinator worker performs one bounded stage at a time:

~~~text
LOAD CURRENT RUN
→ VERIFY HASH
→ EXECUTE ONE STAGE
→ PERSIST DOWNSTREAM ARTIFACT
→ BUILD NEXT RUN RECORD
→ CAS COMMIT CHECKPOINT
→ SCHEDULE OR DISCOVER NEXT RESUME
→ RETURN
~~~

Examples of one stage include freezing ContextSnapshot, planning, validation, policy evaluation, Decision creation, authorization continuation, Task creation, Job enqueue, or binding verified Outcome.

The worker does not hold an entire orchestration lifecycle in memory.

## Existing Job runtime remains execution authority

The coordinator does not duplicate Job leases, retries, provider execution, dead-letter behavior, authorization consumption, or execution truth. It stores Job IDs and waits for existing verification/outcome truth.

Provider success or HTTP success cannot directly move an orchestration to completed.

## Recovery scan

PostgresOrchestrationRunStore.listResumable() defaults to:

~~~text
accepted
context-ready
planning
planned
validated
policy-evaluated
authorized
tasks-created
jobs-enqueued
executing
verifying
~~~

It excludes awaiting-decision, completed, blocked, failed, and cancelled.

awaiting-decision is resumed only by an authoritative Decision resolution event. Generic restart recovery cannot bypass owner attention.

Recovery scans are tenant-scoped through forced PostgreSQL RLS.

## Crash semantics

Crash before CAS: the run remains at the prior version and the same stage is retried.

Crash after CAS but before acknowledgement: retrying the same transition key returns the persisted result; no second receipt/checkpoint is created.

Crash while awaiting Decision: generic recovery ignores the run until the Decision path explicitly resumes it.

Crash after Job enqueue: the run retains its Job IDs and the existing durable Job runtime owns execution recovery.

## Downstream idempotency

CAS protects orchestration state but does not replace downstream idempotency. Every stage should derive stable keys from run ID and version:

~~~text
orchestration:<run-id>:v<version>:context-snapshot
orchestration:<run-id>:v<version>:planner
orchestration:<run-id>:v<version>:policy
orchestration:<run-id>:v<version>:decision-create
orchestration:<run-id>:v<version>:task-generation
orchestration:<run-id>:v<version>:job-enqueue
~~~

If a worker dies after a downstream write but before orchestration CAS, retry must reuse/retrieve that downstream artifact rather than create a duplicate.

## Tenant isolation and permissions

All tenant-scoped orchestration relations enable and FORCE RLS through getdone_tenant_scope_matches(portfolio_id, company_id).

Tenant runtime permissions are asymmetric:

- orchestration_runs: SELECT, INSERT, UPDATE; no DELETE.
- orchestration_transition_receipts: SELECT, INSERT; no UPDATE/DELETE.
- orchestration_checkpoints: SELECT, INSERT; no UPDATE/DELETE.

Historical coordination evidence cannot be rewritten through the runtime role.

## Production readiness gate

Required migration becomes 2026-09-28.6.

Required relations:
- orchestration_runs
- orchestration_transition_receipts
- orchestration_checkpoints
- orchestration_worker_state
- orchestration_context_snapshots
- orchestration_planner_inputs
- orchestration_plan_proposals
- orchestration_validation_artifacts
- orchestration_policy_step_snapshots
- orchestration_policy_evaluations
- orchestration_decision_resume_requests

Required indexes:
- orchestration_runs_scope_idx
- orchestration_runs_source_idx
- orchestration_runs_resumable_idx
- orchestration_transition_receipts_scope_idx
- orchestration_checkpoints_scope_idx
- orchestration_worker_ready_idx
- orchestration_worker_lease_expiry_idx
- orchestration_worker_scope_idx
- orchestration_context_snapshots_scope_idx
- orchestration_context_snapshots_source_idx
- orchestration_planner_inputs_scope_idx
- orchestration_planner_inputs_snapshot_idx
- orchestration_plan_proposals_scope_idx
- orchestration_plan_proposals_input_idx
- orchestration_validation_artifacts_scope_idx
- orchestration_validation_artifacts_plan_idx
- orchestration_policy_step_snapshots_scope_idx
- orchestration_policy_step_snapshots_run_idx
- orchestration_policy_evaluations_scope_idx
- orchestration_policy_evaluations_plan_idx
- orchestration_policy_evaluations_validation_idx
- orchestration_decision_resume_scope_idx
- orchestration_decision_resume_pending_idx

The verifier also checks correlation uniqueness, start-idempotency uniqueness, transition-idempotency uniqueness, transition-version uniqueness, and checkpoint-version uniqueness.

## PR #74 acceptance criteria

The persistence slice is green only when:
1. fresh migration applies;
2. upgrade migration applies;
3. production verifier recognizes schema/index/RLS requirements;
4. same start key + same content replays the original run;
5. same start key + different content fails;
6. valid CAS advances version exactly once;
7. run update + checkpoint + receipt are atomic;
8. committed transition retry returns the same result;
9. stale expected version/hash cannot overwrite current state;
10. another company cannot read the run;
11. recovery excludes awaiting-decision;
12. restart does not duplicate receipts/checkpoints;
13. orchestration persistence never grants execution authority.

## Current durable frontier

PR #74 now carries the persisted nervous-system lineage through:

~~~text
OwnerIntent
→ accepted
→ context-ready
→ planning
→ planned
→ validated
→ policy-evaluated
→ awaiting-decision when required
→ authorized
~~~

Decision resolution emits a durable resume outbox record, and authorization grant sets are persisted atomically before the orchestration CAS. The next execution slice begins at authorized -> tasks-created.
