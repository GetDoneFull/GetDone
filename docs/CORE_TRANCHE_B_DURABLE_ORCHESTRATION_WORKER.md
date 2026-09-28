# Core Tranche B — Durable Orchestration Worker

## Contract

GetDone has one execution chain:

```text
Control API
  -> PostgreSQL orchestration dispatch queue
  -> dedicated orchestration worker
  -> authoritative Task / Job state
  -> existing business Job queue
  -> existing Job workers
```

The orchestration worker owns lifecycle checkpoint transitions. It never calls a provider and never becomes business execution authority.

Business provider execution remains owned only by the existing Job Engine.

## Lifecycle

The worker-resumable lifecycle is:

```text
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
```

`awaiting-decision` is deliberately not generic-worker resumable. It can advance only from authoritative Decision resolution evidence.

Terminal states are:

```text
completed
blocked
failed
cancelled
```

Every transition is a PostgreSQL compare-and-swap bound to exact run version and record hash.

## Dispatch and tenant isolation

`orchestration_worker_state` is non-authoritative routing/lease metadata. It is intentionally globally discoverable by server-side worker processes so one worker fleet can find ready work across companies without a PostgreSQL `BYPASSRLS` role.

The queue exposes only bounded routing/lease metadata: run ID, portfolio/company IDs, projected run state, readiness, attempt/failure counters, lease lineage, and bounded error text.

After discovery, the worker re-enters the exact `portfolio_id/company_id` scope before it reads or mutates:

- `orchestration_runs`
- Context/Plan/Validation/Policy artifacts
- Decisions / AuthorizationGrants
- Tasks / Jobs
- verification / Outcome state
- orchestration dead letters

Authoritative tenant relations remain forced-RLS protected and the production runtime role remains non-superuser/non-`BYPASSRLS`.

Queue `run_state` is only a dispatch projection. `orchestration_runs.payload` remains authoritative. The projection is updated in the same serializable transaction as orchestration CAS. A projection mismatch fails closed.

## Persistent process

The dedicated process is composed from:

- `DurableOrchestrationWorker`
- `PersistentOrchestrationWorkerService`
- `DedicatedOrchestrationWorkerProcess`
- `PostgresOrchestrationWorkerStore`
- `PostgresOrchestrationWorkerRegistry`
- `PostgresOrchestrationRunStore`

Process role:

```text
GETDONE_PROCESS_ROLE=orchestration-worker
```

Required worker identity:

```text
GETDONE_ORCHESTRATION_WORKER_ID=<stable pod/process identity>
```

Health defaults:

```text
GETDONE_ORCHESTRATION_WORKER_HEALTH_HOST=0.0.0.0
GETDONE_ORCHESTRATION_WORKER_HEALTH_PORT=3002
GET /livez
GET /readyz
```

The worker records persistent process identity, start/heartbeat/readiness/drain/stop state, cycle count, and only hashes of unexpected error text in process metadata.

SIGTERM/SIGINT hooks drain new claims, wait for the current bounded cycle, stop the worker registry record, close PostgreSQL, and then stop the health server.

## Lease and retry behavior

Defaults:

```text
lease                    60s
heartbeat                20s
batch size               10
concurrency              2
retry base delay         1s
retry maximum delay      120s
max consecutive failures 8
poll interval            1s
loop error backoff       5s
```

Claims are exact-hash/version bound.

A heartbeat is accepted only while worker identity, lease identity/version, claimed run version, and claimed record hash still match.

Retries use deterministic capped exponential backoff. Deferrals do not consume failure budget.

Expired leases are recovered before new work is claimed.

## Dead letters

Terminal orchestration failures persist immutable evidence in `orchestration_worker_dead_letters`.

A dead letter binds:

- run and tenant scope
- worker and lease identity
- claimed run version/hash
- terminal failed run version/hash
- attempt
- failure code
- hash of failure text
- recovery mode
- dead-letter evidence hash

If a process crashes after the failed-state CAS but before the dead letter/lease cleanup, stale-lease recovery reconstructs the same deterministic dead letter exactly once.

## Crash matrix

PostgreSQL acceptance covers both sides of every worker-resumable boundary:

1. crash immediately before checkpoint CAS -> authoritative run version is unchanged -> retry the same state;
2. crash immediately after checkpoint CAS -> authoritative run version advanced -> clear the stale lease and resume from the next state.

The matrix covers:

- orchestration claim
- context-ready checkpoint
- planning checkpoint
- plan checkpoint
- validation checkpoint
- policy checkpoint
- authorization checkpoint
- Task checkpoint
- Job enqueue checkpoint
- execution checkpoint
- verification checkpoint
- completion checkpoint

Decision resolution is tested separately: `awaiting-decision` is invisible to the generic worker and exact Decision resolution to `authorized` wakes the queue.

Existing stage-specific tests prove Context, Plan, Validation, Policy, Decision, and Authorization artifacts are replay-safe under deterministic idempotency keys.

Existing Job worker crash/restart acceptance remains responsible for proving provider side effects are not duplicated.

## Complete stage router

Production composition must provide a handler for every worker-resumable lifecycle state.

`CompleteOrchestrationStageRouter` refuses incomplete composition. This prevents a deployment from starting a coordinator that handles planning but silently omits Task/Job/verification transitions.

## Gate B status on this branch

Implemented and testable in this tranche:

- PostgreSQL dispatch/state
- global worker discovery without database RLS bypass
- exact tenant re-entry before authoritative access
- worker claim
- lease / heartbeat / renewal
- stale claim recovery
- bounded retry
- deterministic exponential backoff
- dead-letter handling
- graceful shutdown hooks
- persistent worker identity
- liveness / readiness
- structured JSON process logging
- exact CAS/state-version transitions
- lifecycle crash/restart matrix
- Decision wait/wakeup isolation

Gate B cannot truthfully be marked end-to-end complete until the branch containing Core Tranche A supplies the real production handlers for:

```text
authorized -> tasks-created
tasks-created -> jobs-enqueued
jobs-enqueued -> executing
executing -> verifying
verifying -> completed
```

The Tranche B runtime factory intentionally requires that complete handler composition to be injected. It does not create placeholder Tasks, placeholder Jobs, provider calls, or fake verification evidence.

Once Tranche A is stacked into this branch, the final Gate B acceptance is:

1. create one Objective;
2. stop web, orchestration worker, and Job worker;
3. restart all three;
4. wait for the same Objective to resume;
5. assert exactly one deterministic Task set;
6. assert exactly one deterministic Job set;
7. assert provider side-effect idempotency keys remain unique;
8. assert lifecycle lineage/hashes remain valid;
9. require verified Outcome truth before `completed`.
