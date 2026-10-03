# One Authoritative Execution Path

GetDone has exactly one operational execution chain:

```text
USER
  ↓
OwnerIntent / Objective
  ↓
Context Snapshot
  ↓
Planner
  ↓
Plan Validation
  ↓
Policy Evaluation
  ↓
Decision if required
  ↓
AuthorizationGrant
  ↓
Task DAG
  ↓
Jobs
  ↓
Capability Adapter
  ↓
External System
  ↓
Provider Result
  ↓
Verification
  ↓
Objective Evaluation
  ↓
Outcome
  ↓
Audit
```

## Non-negotiable authority rules

Nothing executes outside this chain.

The orchestration coordinator is coordination-only. It can freeze authoritative inputs, advance durable checkpoints, materialize Tasks, enqueue Jobs through the governed Job runtime port, reconcile durable Job outcomes, and initiate Verification. It never calls a provider, a concrete provider adapter, or a network API directly.

The AI is proposal-only. Model output can propose a Plan, assumptions, or work, but it cannot issue an AuthorizationGrant, consume authority, create an executable Job, or establish Outcome truth.

Provider adapters are mechanism-only. They execute an already-authorized Job request and return typed provider evidence. They never evaluate policy, approve work, mutate authoritative Job state, or declare an Objective complete. Provider result contracts retain `jobStateMutationApplied: false`.

The UI is projection-only. Client state, optimistic state, component state, URL state, and browser storage never become control-plane truth. UI code cannot import PostgreSQL persistence or provider execution runtimes.

PostgreSQL-backed records remain authoritative. Orchestration runs/checkpoints, frozen context, Plan artifacts, validation receipts, policy snapshots, Decisions, AuthorizationGrants, grant consumptions, Task materializations, Task DAGs, Job graphs, durable Job runtime state, Verification receipts, Objective evaluations, Outcomes, and Audit events are persisted before downstream authority is recognized.

## Execution boundary

The only provider-facing runtime chain is:

```text
PostgreSQL Job + exact Task authorization consumption
  ↓
Durable Job queue / lease
  ↓
RoutedJobExecutionHandler
  ↓
BusinessActionExecutionOrchestrator
  ↓
Capability Adapter
  ↓
External System
```

The orchestration process does not run provider code. It hands a persisted Job to the durable Job worker and later reads persisted Job outcomes and Verification evidence.

A provider success response is not completion. The Job worker persists provider/verification evidence; orchestration resolves an authoritative Verification receipt; Objective Evaluation consumes verified evidence; only then may a verified Outcome be recorded and audited.

## Fail-closed completion

If any required lineage is missing, stale, cross-company, hash-mismatched, expired, unverified, or unobservable, the chain does not advance.

If an Objective metric cannot be observed from verified execution evidence or an authoritative business metric, GetDone does not infer that the Objective succeeded. It remains pending/uncertain until evidence exists.

The source gate `scripts/verify-authoritative-execution-path.mjs` enforces these boundaries in CI and rejects new parallel execution paths.
