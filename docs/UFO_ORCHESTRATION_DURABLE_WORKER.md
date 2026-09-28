# UFO Attention Compression — Restart-Safe Durable Worker Loop

## Purpose

PR #74 advances the Nervous System Coordinator one durable checkpoint at a time. This worker is coordination-only; it is not a second business Job Engine.

It may claim one orchestration run, execute one orchestration stage, persist one next checkpoint, defer while waiting on another subsystem, retry transient coordination failures, and recover expired coordination leases. It may not execute provider/business actions directly, mint authorization, bypass Decisions, or replace existing Job Engine leases/retries/dead letters.

## Worker state

Migration 2026-09-28.2 adds orchestration_worker_state. One row exists per orchestration run and stores stage_run_version, stage_attempt, consecutive_failures, ready_at, lease identity/worker/timestamps/version, claimed run version/hash, last error, and updated_at.

Claiming a coordination lease does not advance the orchestration run version. Worker scheduling state is deliberately separate from orchestration authority.

## Claim and lease behavior

A candidate is ready only when ready_at <= now, there is no active coordination lease, and the orchestration state is worker-resumable. awaiting-decision and terminal states are excluded.

Claims are bound to runId + expectedRunVersion + expectedRecordHash. The deterministic claim key is:

    orchestration-worker:claim:<run-id>:v<run-version>:<worker-id>

Within a SERIALIZABLE transaction the store verifies exact run version/hash, worker resumability, readiness, and no active lease; then it increments the stage attempt and writes a hash-bound lease. Only one worker can hold a run.

Defaults are a 60-second lease and 20-second heartbeat. A heartbeat succeeds only if lease identity, worker identity, lease version, and claimed orchestration version/hash still match. If an external authoritative event advances the run, heartbeat fails and the stale worker must not commit.

## One-stage execution rule

One worker claim performs at most one orchestration stage. Examples include accepted -> context-ready, planning -> planned, validated -> policy-evaluated, policy-evaluated -> awaiting-decision or authorized, authorized -> tasks-created, and tasks-created -> jobs-enqueued.

A handler returns one of four outcomes: advance, defer, retry, or failed.

advance returns exactly one next OrchestrationRunRecord. It must advance current version by exactly one and is committed through the existing orchestration CAS store before the lease is released.

defer leaves orchestration state unchanged, clears the lease, and moves ready_at into the future without increasing failure count.

retry leaves orchestration state unchanged, clears the lease, increments consecutive_failures, and schedules ready_at using retry/backoff.

failed CAS-transitions the orchestration itself to terminal failed with failure evidence, then releases the lease.

## Stage idempotency

Every downstream write in a stage must use a deterministic operation key derived from run ID and run version, for example:

    orchestration:<run-id>:v<version>:context-snapshot
    orchestration:<run-id>:v<version>:planner
    orchestration:<run-id>:v<version>:policy
    orchestration:<run-id>:v<version>:decision-create
    orchestration:<run-id>:v<version>:task-generation
    orchestration:<run-id>:v<version>:job-enqueue

This protects the crash window where a downstream artifact is persisted but the orchestration CAS has not yet committed. Retry must reuse/retrieve the existing artifact, not create a duplicate.

## Retry and backoff

Transient classes include UNAVAILABLE, RATE_LIMITED, PostgreSQL serialization/deadlock conflicts 40001/40P01, and unhandled non-control-plane exceptions. Non-retryable authority/validation failures are terminal unless a stage handler deliberately converts them into a governed state transition.

Backoff is capped exponential with deterministic jitter. Defaults: base 1 second, max 120 seconds, max 8 consecutive failures. The jitter is deterministically derived from run ID + failure count, so restarts do not alter the schedule unpredictably. Explicit retryAfterMs may be honored but is clamped to the configured maximum.

Failure budget is scoped to one orchestration run version. After a successful stage advance, attempt/failure counters reset for the next stage. Deferrals do not consume failure budget.

When the next retry would reach the configured failure ceiling, the worker does not schedule another retry. It fails the orchestration with ORCHESTRATION_MAX_RETRIES and retryable=false.

## Crash recovery

runOnce recovers expired leases before normal ready-work discovery.

Crash before checkpoint CAS: current run version still equals the lease's claimed version. Recovery clears the expired lease, increments failure count, and schedules the same stage with deterministic backoff.

Crash after checkpoint CAS but before lease release: current run version is greater than the lease's claimed version. Recovery concludes the stage already committed, clears the lease, resets stage attempt/failure counters, and makes the new run version ready immediately. The completed stage is not replayed.

If heartbeat is lost during execution, the worker marks itself stale. Even if the handler later returns a result, the stale worker must not commit it. Any downstream artifact already written is reconciled through deterministic stage idempotency.

## Owner Decision wait

awaiting-decision is never claimed by the generic worker. A process restart therefore cannot bypass owner approval.

An orchestration Decision carries an exact immutable Plan/step/policy/validation binding. Resolving that Decision writes a durable DecisionResumeRequest in the same authoritative transaction as the Decision CAS, audit event, and exact ApprovalProof.

The explicit DecisionResumeDispatcher—not the generic worker—consumes that durable resolution evidence and may advance awaiting-decision to authorized. The Control API performs an immediate post-commit wakeup for latency, while pending resume requests remain durable for scoped recovery.

If a Decision was resolved after its initial creation but before policy-evaluated -> awaiting-decision CAS, the policy stage replay recognizes the evolved Decision only when its immutable authorization binding is identical and can safely converge to authorized or blocked.

Authorization grant sets use a separate atomic SERIALIZABLE batch with deterministic idempotency. A crash after grant commit but before orchestration CAS reuses the exact grant hashes instead of minting fresh authority.

## Handoff to the existing Job Engine

The orchestration worker stops at business execution authority:

    authorized
      -> generate Tasks using exact authorization grant
      -> tasks-created
      -> materialize/enqueue Jobs in EXISTING Job Engine
      -> jobs-enqueued

The Job Engine then owns Job claim leases, provider execution, business retries/dead letters, execution evidence, verification, and Outcome truth. The orchestration worker stores Job IDs and observes authoritative Job/verification/Outcome state; it does not execute the business action itself.

When Jobs or verification are still in flight, the stage handler should return defer rather than retry. A defer supplies a fallback polling deadline (for example 30 seconds) while later event-driven wakeups can move ready_at earlier. Waiting is not failure.

## No second Job Engine

Orchestration lease = protects one control-plane checkpoint computation.
Job Engine lease = protects one business Job execution.
Orchestration retry = retries planning/policy/checkpoint coordination.
Job retry = retries authorized provider/business execution.

These concepts remain separate.

## Production contract

Migration 2026-09-28.2_ufo_orchestration_worker.sql adds orchestration_worker_state with forced tenant RLS and indexes orchestration_worker_ready_idx, orchestration_worker_lease_expiry_idx, and orchestration_worker_scope_idx.

The worker reuses the existing durable idempotency_records primitive for claim, heartbeat, release, retry, and defer replay instead of creating another transaction journal.

## Acceptance requirements

1. Only one worker can claim a run at a time.
2. Claim is bound to exact run version/hash.
3. Heartbeat cannot survive changed orchestration lineage.
4. One claim executes no more than one stage.
5. Stage CAS advances exactly one version.
6. Transient failures receive deterministic exponential backoff.
7. Defer does not consume failure budget.
8. Failure budget resets after stage advance.
9. Max failures end in terminal orchestration failure.
10. Crash before CAS retries the same stage.
11. Crash after CAS resumes the next stage.
12. Expired leases are recovered before normal discovery.
13. awaiting-decision is never generic-worker resumable.
14. Stale workers cannot commit.
15. Business Job execution is handed to the existing Job Engine.
16. Orchestration leases never become business execution authority.
