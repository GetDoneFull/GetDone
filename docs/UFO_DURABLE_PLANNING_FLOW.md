# UFO Attention Compression — Durable Snapshot-Only Planning

## Scope

PR #74 now defines the durable context-ready -> planning -> planned path.

The planning boundary is intentionally split into two worker stages:

    context-ready
      -> freeze PlannerInput
      -> planning
      -> invoke planner against PlannerInput only
      -> persist immutable PlanProposal artifact
      -> planned

The planner is advisory. It may propose a plan, but it does not validate policy, create authorization, create Tasks, or execute Jobs.

## Snapshot-only planning rule

Once an orchestration reaches context-ready, the planner may not go back to OwnerIntent, SignalBus, CRM state, operational memory, resources, or other mutable business stores to gather more reasoning context.

The only business reasoning input is the frozen ContextSnapshot referenced by the orchestration checkpoint.

To make this practical, OwnerIntent ContextSnapshot now also freezes the original request content:

    sourceInput.type = owner-intent
    sourceInput.message
    sourceInput.channel

Therefore the planner does not need to reread owner_intents to recover the owner's request.

Live reads that exist only to operate the AI infrastructure itself, such as model routing health or AI budget admission, are not business planning context and may be handled by the eventual planner adapter. They may not alter the frozen planner payload.

## PlannerInput contract

context-ready creates one immutable PlannerInputEnvelope.

It contains:

    id
    runId
    sourceRunVersion
    correlationId
    exact trusted scope
    orchestration source + source hash
    authorized Plan source mapping
    ContextSnapshot id + hash
    frozen sourceInput
    frozen assembled context
    createdAt
    inputHash

PlannerInput ID:

    planner-input:<run-id>:v<context-ready-run-version>

PlannerInput idempotency key:

    orchestration:<run-id>:v<context-ready-run-version>:planner-input

The inputHash is the canonical hash of the complete PlannerInput body.

From planning state onward, orchestration checkpoints require plannerInput id + hash.

## context-ready -> planning

The worker stage performs:

    1. Verify run.state == context-ready.
    2. Check for an existing PlannerInput for run/version.
    3. If one exists, verify it and reuse it.
    4. Otherwise load the exact ContextSnapshot by checkpoint ID.
    5. Verify snapshot ID/hash, run, correlation, source, portfolio, and company lineage.
    6. Build PlannerInput entirely from run metadata + the frozen snapshot.
    7. Persist PlannerInput append-only and idempotently.
    8. Return one orchestration transition: context-ready -> planning.
    9. Durable worker commits the transition using normal version/hash CAS.

PlannerInput persistence and orchestration CAS are separate SERIALIZABLE transactions. ContextSnapshot and PlannerInput are immutable artifacts, so this split is restart-safe without holding a long database transaction.

## Durable planner contract

A planner implementation must declare:

    snapshotOnlyInput = true
    deterministicRequestIdentity = true
    structuredPlanOutput = true

The orchestration flow refuses a planner that does not satisfy all three.

The planner receives only:

    requestId
    idempotencyKey
    PlannerInputEnvelope

Deterministic planner request ID:

    planner-request:<run-id>:v<planning-run-version>

Planner invocation idempotency key:

    orchestration:<run-id>:v<planning-run-version>:planner

A provider may still physically recompute an inference after a process crash if that external provider does not support replay by request ID. GetDone does not claim exactly-once model billing. What is guaranteed is deterministic request identity and exactly one durable plan artifact for the run/version.

## Planner output rebinding

Raw model output is never trusted as a plan directly.

The result goes through the existing constructPlanProposal boundary and PlanProposal schema.

GetDone rebinds the proposal to:

    exact portfolio
    exact company
    exact environment
    exact authorized source

For an OwnerIntent source:

    Plan source must be:
      type = owner-request
      requestId = OwnerIntent id

Cross-company, cross-environment, or source-swapping model output is rejected before persistence.

Direct Signal source planning remains unsupported. A Signal must become an Investigation before it may become a Plan source.

## Plan artifact

A successfully constructed proposal is persisted as an immutable PersistedPlanProposal.

It contains:

    artifact id
    run id
    planning run version
    correlation id
    portfolio/company
    PlannerInput id + hash
    deterministic planner request id
    validated-schema PlanProposal
    planHash
    artifactHash
    createdAt

Artifact ID:

    plan-artifact:<run-id>:v<planning-run-version>

Artifact idempotency key:

    orchestration:<run-id>:v<planning-run-version>:plan-artifact

The orchestration planned checkpoint stores:

    plan.id = immutable plan artifact id
    plan.hash = PlanProposal planHash

## planning -> planned

The worker stage performs:

    1. Verify run.state == planning.
    2. Load exact PlannerInput by checkpoint id.
    3. Verify PlannerInput hash and all orchestration/snapshot lineage.
    4. Look for an existing Plan artifact for run + planning version.
    5. If one exists, verify and reuse it without invoking the planner.
    6. Otherwise invoke the planner using deterministic request identity.
    7. Parse/rebind output through constructPlanProposal.
    8. Persist the immutable Plan artifact idempotently.
    9. Return exactly planning -> planned.
    10. Durable worker commits the normal orchestration CAS.

Planner unavailability maps to the existing worker outcomes:

    retryable unavailable -> retry + durable backoff
    non-retryable unavailable -> terminal orchestration failure

## PostgreSQL persistence

Migration 2026-09-28.4 adds:

    orchestration_planner_inputs
    orchestration_plan_proposals

Both are tenant-scoped with forced RLS and are append-only for the tenant runtime role.

PlannerInput uniqueness:

    UNIQUE(run_id, source_run_version)
    UNIQUE(portfolio_id, company_id, idempotency_key)
    UNIQUE(input_hash)

Plan artifact uniqueness:

    UNIQUE(run_id, planning_run_version)
    UNIQUE(portfolio_id, company_id, idempotency_key)
    UNIQUE(portfolio_id, company_id, planner_request_id)
    UNIQUE(artifact_hash)

These constraints make duplicate worker retries converge on one durable artifact.

## Transaction boundaries

Planning intentionally uses short durable boundaries rather than one transaction spanning model work.

Boundary A:

    read frozen ContextSnapshot
    create/replay PlannerInput
    COMMIT

Boundary B:

    CAS context-ready -> planning
    COMMIT

Boundary C:

    invoke planner outside a database transaction
    construct/rebind proposal
    create/replay Plan artifact
    COMMIT

Boundary D:

    CAS planning -> planned
    COMMIT

This avoids holding database locks while a model call is in flight.

## Crash recovery

Crash before PlannerInput commit:

    no PlannerInput exists
    -> worker retries from context-ready
    -> reloads the same ContextSnapshot

Crash after PlannerInput commit but before context-ready -> planning CAS:

    PlannerInput exists
    -> retry finds it by run/version
    -> ContextSnapshot is not reread
    -> same PlannerInput id/hash is used
    -> CAS to planning

Crash after context-ready -> planning CAS:

    durable worker sees version advanced
    -> resumes planning stage

Crash during planner call before Plan artifact commit:

    no Plan artifact exists
    -> retry uses the same deterministic planner request ID and idempotency key
    -> external inference may be recomputed if provider replay is unavailable
    -> only one exact durable Plan artifact may win persistence

Crash after Plan artifact commit but before planning -> planned CAS:

    retry finds existing Plan artifact by run/version
    -> planner is not reinvoked
    -> same plan id/hash is checkpointed

Crash after planned CAS:

    worker recovery observes run version advance
    -> planning stage is not replayed

## Tenant scoping

Every PlannerInput and Plan artifact stores portfolio_id + company_id and is protected by forced PostgreSQL RLS.

The application layer additionally verifies:

    ContextSnapshot scope == orchestration scope
    PlannerInput scope == orchestration scope
    Plan output portfolio/company/environment == authoritative request
    Plan source == authorized source

Tenant RLS prevents cross-company reads. Hash lineage prevents same-tenant artifact substitution.

## Authority boundary

planned means:

    GetDone has a durable, schema-valid, scope-bound proposal.

It does not mean:

    the plan is valid under deterministic PlanValidator rules
    policy permits execution
    owner approval exists
    authorization exists
    Tasks may be created

Those remain later stages:

    planned -> validated -> policy-evaluated -> authorized -> tasks-created

## Acceptance requirements

1. planning cannot begin without ContextSnapshot and PlannerInput checkpoints.
2. PlannerInput contains the frozen owner request and frozen context.
3. planner business reasoning cannot reread mutable OwnerIntent/live business context.
4. PlannerInput persistence is idempotent by run/version and tenant key.
5. context-ready -> planning advances one version only.
6. planner request ID is deterministic for the planning run version.
7. raw planner output is schema parsed and rebound to exact tenant/environment/source.
8. cross-company and cross-environment planner output fails closed.
9. Plan artifact is immutable and hash-bound to PlannerInput.
10. only one Plan artifact can exist per planning run version.
11. crash after PlannerInput persistence reuses PlannerInput.
12. crash after Plan persistence does not reinvoke planner.
13. retryable planner outage uses durable worker backoff.
14. non-retryable planner failure fails orchestration closed.
15. planned still carries no execution authority.
