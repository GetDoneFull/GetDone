# UFO Attention Compression — Durable OwnerIntent Admission

## Purpose

PR #74 now defines the durable boundary from an authenticated owner request to the first runnable nervous-system checkpoint.

The invariant is simple:

    HTTP 202 / accepted must mean both:
      1. the OwnerIntent is durably accepted; and
      2. an accepted orchestration run is durably ready for the coordinator worker.

GetDone must never acknowledge an accepted OwnerIntent that can disappear between the Control API and orchestration.

## Boundary A — Control API admission transaction

The Control API still derives tenant/user/environment scope from the authenticated server-side principal. Request JSON does not provide trusted scope.

ServiceBackedControlApiAdapter builds the OwnerIntentRecord with:

    id
    correlationId
    portfolioId
    companyId
    environment
    userId
    message
    channel
    status = accepted
    receivedAt

PostgresOwnerIntentStore.create then runs one SERIALIZABLE transaction.

Within that single transaction:

    1. Claim the tenant-scoped API idempotency record.
    2. Insert or replay the OwnerIntent row.
    3. Build the orchestration run from the persisted OwnerIntent.
    4. Insert or replay orchestration_runs version 1 / state accepted.
    5. Insert orchestration_checkpoints version 1.
    6. Insert orchestration_worker_state with ready_at = receivedAt.
    7. Append owner-intent.accepted audit lineage.
    8. Complete the API idempotency record with the persisted OwnerIntent.
    9. COMMIT.

If any orchestration admission step fails, the OwnerIntent insert, audit event, idempotency completion, initial checkpoint, and worker-state creation roll back together.

The Control API returns accepted only after this transaction commits.

## OwnerIntent idempotency

The client-provided idempotency key is preserved on owner_intents for tenant-local replay semantics.

The shared idempotency_records key is internally namespaced by a canonical hash of:

    portfolioId
    companyId
    client idempotency key

This prevents the same client key used by two companies from colliding in the global idempotency table.

The OwnerIntent fingerprint includes tenant, user, message, and channel. It intentionally does not depend on a newly generated request ID or correlation ID, so an HTTP retry with the same semantic request replays the original persisted OwnerIntent.

On COMPLETED idempotency replay, PostgresOwnerIntentStore also ensures that the original OwnerIntent has its deterministic orchestration run. This gives older accepted intents a safe admission backfill path after the UFO orchestration rollout.

## Orchestration identity

The orchestration run is derived only from the persisted OwnerIntent:

    run id:
      orchestration:owner-intent:<owner-intent-id>

    start idempotency:
      orchestration:start:owner-intent:<owner-intent-id>

    correlation id:
      persisted OwnerIntent correlationId

    source:
      type = owner-intent
      id = persisted OwnerIntent id
      sourceHash = canonical hash of the persisted OwnerIntent

    trusted scope:
      exact user / portfolio / company / environment from the OwnerIntent

The orchestration admission API is exposed as createInTransaction so the OwnerIntent store can create the run on the same PostgreSQL transaction client without nesting a second transaction.

## Tenant scoping

OwnerIntent submission is wrapped in runWithPostgresTenantScope using the authenticated principal.

PostgreSQL applies that scope through getdone.portfolio_id and getdone.company_id. owner_intents, orchestration_runs, orchestration_checkpoints, orchestration_worker_state, and ContextSnapshots are protected by forced RLS.

The orchestration source/scope is additionally hash-bound in application code. A later worker must reject an OwnerIntent whose user, portfolio, company, environment, correlation, source ID, or source hash no longer matches the accepted run.

RLS is the database boundary. Hash/scope lineage is the application integrity boundary. Both are required.

## Boundary B — accepted to context-ready

The accepted orchestration is immediately discoverable by the durable orchestration worker because orchestration_worker_state is created with ready_at equal to the intent admission timestamp.

The worker claims exact accepted run version/hash under the coordination lease contract, then invokes the OwnerIntent accepted-stage handler.

The handler:

    1. Loads the persisted OwnerIntent by run.source.id.
    2. Recomputes and validates exact OwnerIntent source/scope/correlation lineage.
    3. Checks whether ContextSnapshot(run, version) already exists.
    4. If it exists, reuse it without rebuilding context.
    5. Otherwise obtain scoped context candidates and a context policy.
    6. Refuse any context policy that broadens portfolio/company scope.
    7. Assemble bounded context with the existing context assembler.
    8. Freeze and hash one durable ContextSnapshot.
    9. Persist it idempotently.
    10. Return exactly one transition: accepted -> context-ready.

The DurableOrchestrationWorker then commits that transition through the normal orchestration CAS store.

## ContextSnapshot persistence

Migration 2026-09-28.3 adds orchestration_context_snapshots.

Each snapshot contains:

    snapshot id
    run id / run version
    correlation id
    portfolio / company
    source type / source id / source hash
    assembled bounded context
    createdAt
    snapshotHash

Uniqueness is enforced on:

    run_id + run_version
    portfolio_id + company_id + idempotency_key
    snapshot_hash

Snapshots are append-only to the tenant runtime role: SELECT + INSERT, no UPDATE or DELETE.

Snapshot id:

    context-snapshot:<run-id>:v<run-version>

Snapshot idempotency key:

    orchestration:<run-id>:v<run-version>:context-snapshot

## Why ContextSnapshot persistence and orchestration CAS are separate transactions

Context collection may involve multiple stores and should not hold a long PostgreSQL transaction open.

Therefore the stage intentionally uses two durable boundaries:

    transaction 1:
      create/replay immutable ContextSnapshot

    transaction 2:
      CAS accepted -> context-ready
      checkpoint stores snapshot id + snapshot hash

This creates a safe crash window instead of trying to hide one.

Crash before snapshot commit:
    no snapshot exists; retry rebuilds it.

Crash after snapshot commit but before orchestration CAS:
    retry first finds the existing snapshot by run/version and reuses it; context is not reassembled and the frozen snapshot does not drift.

Crash after orchestration CAS:
    the durable worker's lease recovery sees the run version advanced and resumes the next stage.

## Context policy boundary

The accepted-stage handler does not assume that an owner may automatically load every sensitivity class or every resource.

A ContextPolicyResolver must return the exact ContextScope and assembly limits for the request.

The flow enforces that the resolver cannot broaden portfolio/company scope. Existing ContextScope rules continue to enforce sensitivity, resource allowlists, freshness, per-section limits, item limits, and character limits.

ContextSnapshot is evidence available to planning. It is not authorization.

## Response semantics

The API remains fast.

OwnerIntent submission does not wait for context gathering or planning.

The durable response boundary is:

    request
      -> SERIALIZABLE OwnerIntent + accepted orchestration admission
      -> COMMIT
      -> return accepted

Then asynchronously:

    worker claims accepted
      -> freeze ContextSnapshot
      -> CAS context-ready
      -> next orchestration stage

This preserves 202-style behavior without creating a gap where accepted work has no durable nervous-system continuation.

## Acceptance requirements

1. accepted is never returned unless OwnerIntent + accepted orchestration + v1 checkpoint + worker state commit together.
2. orchestration conflict rolls the OwnerIntent transaction back.
3. HTTP replay returns the original OwnerIntent and original orchestration identity.
4. the same client idempotency key may be independently used in another company.
5. orchestration source hash is derived from the persisted OwnerIntent, not the retry request object.
6. tenant scope is exact and forced by RLS.
7. accepted worker claim is bound to exact run version/hash.
8. ContextSnapshot is immutable and hash-bound.
9. Context policy may narrow scope but cannot broaden company/portfolio scope.
10. crash after snapshot persistence but before CAS reuses the existing snapshot.
11. accepted -> context-ready advances exactly one orchestration version.
12. the context-ready checkpoint contains only ContextSnapshot id + hash, not mutable live context.
13. planning does not begin in the OwnerIntent HTTP transaction.
14. ContextSnapshot remains advisory input and creates no execution authority.
