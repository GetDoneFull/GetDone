# UFO Attention Compression — Durable Validation and Policy Evaluation

## Scope

PR #74 now defines and implements the durable path:

    planned
      -> deterministic validation
      -> validated
      -> frozen per-step policy inputs
      -> deterministic policy evaluation
      -> policy-evaluated

The entire slice consumes the immutable Plan artifact already referenced by the orchestration. It never reconstructs a Plan from model output, live context, or mutable owner input.

## Authority boundary

Validation and policy evaluation are deterministic governance stages.

They may:
- prove whether the persisted Plan is structurally valid;
- freeze the exact policy/evidence inputs used for governance;
- classify each Plan step as AUTO, APPROVAL_REQUIRED, STRONG_APPROVAL, or BLOCKED;
- persist immutable evidence and resume after crashes.

They may not:
- create an approval proof;
- mint an AuthorizationGrant;
- create Tasks or Jobs;
- turn advisory/model output into authority;
- silently weaken policy because a prior decision was approved.

`policy-evaluated` means the exact policy disposition is durably known. It does not mean the work is authorized.

## Immutable Plan reads

Both stages load the Plan only through the orchestration's `checkpoints.plan` reference.

The loaded PersistedPlanProposal must match:
- Plan artifact ID;
- Plan hash;
- orchestration run ID;
- correlation ID;
- portfolio;
- company;
- environment.

The Plan artifact's own integrity hash is verified before validation or policy evaluation proceeds.

No stage asks the planner/model to reconstruct or refresh the Plan.

## planned -> validated

The validation stage first checks whether a validation artifact already exists for the exact planned run version.

If it exists, it is verified and reused. The validation resolver is not called again.

If it does not exist:

    immutable Plan artifact
        +
    deterministic validation policy
        +
    validation evidence snapshot
        ↓
    PlanValidator attestation
        ↓
    PlanValidationReceipt
        ↓
    DurableValidationArtifact

The validation resolver receives a deterministic idempotency key:

    orchestration:<run-id>:v<planned-version>:validation

Any validation-side evidence acquisition that performs a durable write must use that identity or an identity derived from it.

GetDone, not the resolver, supplies the authoritative:
- policy registry version;
- Plan environment;
- run/tenant identity;
- validation artifact IDs.

Therefore a resolver cannot move a staging Plan into production or swap policy-registry versions.

## Validation artifact

The durable validation artifact stores:
- run/version/correlation;
- portfolio/company;
- Plan artifact ID + artifact hash;
- Plan hash;
- exact PlanValidationPolicy + hash;
- ValidationSnapshot;
- PlanValidatorAttestation;
- PlanValidationReceipt;
- artifact hash.

IDs are deterministic:

    validation-snapshot:<run-id>:v<planned-version>
    validation-receipt:<run-id>:v<planned-version>

The orchestration checkpoint stores the actual receipt identity:

    validationReceipt.id   = receipt.id
    validationReceipt.hash = receipt.receiptHash

## Validation outcomes

A clean deterministic receipt advances:

    planned -> validated

A receipt with deterministic errors or owner-decision-required validation does not masquerade as clean validation. The orchestration transitions to `blocked` with the receipt retained as evidence.

This preserves the existing invariant that downstream policy and authorization consume only a clean validation receipt.

## Validation crash recovery

Boundary A:

    resolve validation inputs
    create/replay validation artifact
    COMMIT

Boundary B:

    CAS planned -> validated
    COMMIT

If the process dies after the validation artifact commits but before orchestration CAS, restart finds the existing artifact and performs only Boundary B. It does not recollect evidence or rerun validation against changed inputs.

The artifact is checked against the policy/validator versions that created it. If code/policy definitions no longer match, integrity/staleness checks fail closed.

## validated -> policy-evaluated

Policy evaluation starts from:
- the same immutable Plan artifact;
- the exact clean validation receipt referenced by the validated run.

Before new policy inputs are collected, GetDone checks whether a complete aggregate policy evaluation already exists for the validated run version. If it exists, that completed stage is reused without any live policy reads.

If no aggregate exists, each Plan step is processed in validator topological order.

## Per-step policy input contract

The policy resolver may supply current governance facts such as:
- region allowlists;
- budget policy/current spend/reservation evidence;
- guardrails + metrics;
- kill switches;
- credential availability snapshots;
- protected-capacity snapshots;
- fallback availability;
- integration/resource/provider/failure-domain/workload identifiers.

It may not supply or override:
- tenant scope;
- environment;
- Plan hash;
- step hash;
- capability names;
- data classification;
- resource requirements;
- policy-registry version;
- the per-step idempotency identity.

Those values are rebound from the immutable Plan and validated orchestration.

Each resolver invocation receives:

    orchestration:<run-id>:v<validated-version>:policy:<step-id>

Any side-effectful policy preparation, especially budget reservations, must use that deterministic key or a deterministic child key.

## Per-step policy snapshot checkpoint

Each step gets an immutable PolicySnapshot and a durable DurablePolicyStepSnapshotArtifact before the aggregate policy result is created.

This is important for multi-step Plans.

Without the per-step checkpoint, a crash after reserving budget for step 1 but before evaluating step 5 could cause step 1's policy-input side effects to repeat.

The durable sequence is:

    resolve step 1 inputs
    persist step 1 snapshot
    resolve step 2 inputs
    persist step 2 snapshot
    ...
    evaluate all frozen snapshots
    persist aggregate policy evaluation

On restart, already-persisted step snapshots are reused and only missing steps may call the resolver.

Per-step snapshot identity:

    policy-snapshot:<run-id>:v<validated-version>:<step-id>

with unique persistence on:

    run_id + validated_run_version + step_id

## Deterministic policy evaluation

Each frozen PolicySnapshot is evaluated by the existing `evaluateStepPolicy()` engine.

No approval proof or step-up proof is supplied in this stage.

Therefore:
- AUTO may be ready for later authorization;
- APPROVAL_REQUIRED records that approval is still missing;
- STRONG_APPROVAL records that fresh strong approval/step-up is still missing;
- BLOCKED remains blocked.

The stage aggregates step dispositions using the existing precedence:

    BLOCKED
      > STRONG_APPROVAL
      > APPROVAL_REQUIRED
      > AUTO

The aggregate artifact retains every per-step PolicySnapshot and StepPolicyEvaluation so the next stage can create Decisions or AUTO authorization from exact evidence.

## Policy artifact integrity

The aggregate DurablePolicyEvaluationArtifact binds:
- run/version/correlation;
- tenant;
- immutable Plan artifact/hash;
- validation receipt ID/hash;
- every Plan step exactly once;
- every step hash;
- every frozen PolicySnapshot;
- every deterministic StepPolicyEvaluation;
- aggregate disposition;
- policy engine version/rules hash;
- artifact hash.

Artifact verification deterministically re-evaluates each stored PolicySnapshot at the original artifact creation time and compares the result with the stored evaluation.

This catches a stored evaluation that no longer matches its frozen inputs.

## Transaction boundaries

Validation:

    TX 1: persist/replay DurableValidationArtifact
    TX 2: CAS planned -> validated

Policy:

    TX N: persist/replay each DurablePolicyStepSnapshotArtifact
    TX N+1: persist/replay DurablePolicyEvaluationArtifact
    TX N+2: CAS validated -> policy-evaluated

No transaction is held open while collecting external evidence or reserving provider/budget resources.

External/side-effectful policy preparation must itself use the supplied deterministic step idempotency key.

## Policy crash recovery

Crash before a step snapshot commits:
- retry may call that step resolver again;
- resolver side effects must replay under the same deterministic idempotency key.

Crash after a step snapshot commits:
- restart reuses it;
- that step's resolver is not called again.

Crash after some but not all step snapshots:
- completed steps are reused;
- only missing step inputs are resolved.

Crash after aggregate policy artifact commits but before CAS:
- restart reuses the complete artifact;
- no step resolver is called;
- CAS resumes `validated -> policy-evaluated`.

Crash after CAS:
- durable worker recovery sees the orchestration version advanced;
- policy evaluation is not replayed.

## Tenant scoping

Migration 2026-09-28.5 adds three append-only, forced-RLS relations:

    orchestration_validation_artifacts
    orchestration_policy_step_snapshots
    orchestration_policy_evaluations

All carry portfolio_id + company_id and are isolated by `getdone_tenant_scope_matches()`.

Runtime permissions are SELECT + INSERT only; UPDATE/DELETE are revoked.

Application lineage checks additionally bind all three artifacts to the exact orchestration, Plan artifact, validation receipt, and Plan step.

## PostgreSQL uniqueness

Validation artifact:
- UNIQUE(run_id, planned_run_version)
- UNIQUE(portfolio_id, company_id, idempotency_key)
- unique receipt/artifact hashes

Policy step snapshot:
- UNIQUE(run_id, validated_run_version, step_id)
- UNIQUE(portfolio_id, company_id, idempotency_key)
- unique snapshot/artifact hashes

Aggregate policy evaluation:
- UNIQUE(run_id, validated_run_version)
- UNIQUE(portfolio_id, company_id, idempotency_key)
- unique artifact hash

These constraints make duplicate worker attempts converge on one durable governance history.

## Acceptance requirements

1. Validation reads only the immutable Plan artifact referenced by orchestration.
2. Validation policy tenant scope must exactly match the orchestration tenant.
3. Validation environment/policy version are GetDone-owned, not resolver-controlled.
4. Clean validation is required to enter `validated`.
5. Invalid/owner-decision validation never masquerades as executable validation.
6. Validation artifact commit survives a pre-CAS crash without recollecting inputs.
7. Policy evaluation consumes the exact Plan + validation receipt lineage.
8. Policy resolver cannot override scope/environment/Plan/step/capabilities/data class/resource requirements.
9. Every step gets a deterministic policy idempotency key.
10. Every step snapshot is durably checkpointed before aggregate evaluation.
11. A restart reuses completed step snapshots and resolves only missing steps.
12. Every Plan step appears exactly once in the aggregate policy artifact.
13. Stored policy evaluations reproduce from frozen policy snapshots.
14. Aggregate disposition uses deterministic policy precedence.
15. `policy-evaluated` still creates no approval or execution authority.
16. All validation/policy artifacts are forced-RLS tenant isolated.
