# UFO Attention Compression — Nervous System Coordinator Contract

## Purpose

This tranche introduces the contract for the thin GetDone nervous-system coordinator.

The coordinator is **not** a second Job Engine and it is **not** an authority source. Its job is to persist and resume workflow checkpoints while composing the authority, planning, execution, verification, and memory primitives that already exist in GetDone.

## Locked authority rule

```text
AI thinks.
GetDone policy/authorization decides what is permitted.
Owner approval is required when policy says so.
Tasks consume exact authorization grants.
The durable Job runtime executes.
Verification establishes truth.
Outcomes become eligible learning evidence.
The coordinator only connects these boundaries.
```

The coordinator record is permanently marked:

```text
authority = coordination-only
```

It cannot mint an approval, authorization grant, Task authority, Job truth, verification truth, or Outcome truth.

## Supported sources

A run may originate from:

- `owner-intent`
- `signal`
- `investigation`
- `objective`

Each source is captured as an immutable reference plus a canonical source hash.

This lets OwnerIntent and SignalBus/Investigation enter the **same** orchestration path without giving provider payloads authority.

## State path

```text
accepted
  -> context-ready
  -> planning
  -> planned
  -> validated
  -> policy-evaluated
       -> awaiting-decision -> authorized
       -> authorized
       -> blocked
  -> tasks-created
  -> jobs-enqueued
  -> executing
  -> verifying
  -> completed
```

At any non-terminal stage, the run may fail or be cancelled where allowed.

`blocked`, `failed`, `cancelled`, and `completed` are terminal in contract v1.

## Checkpoint invariants

The coordinator cannot advance merely because a previous function returned success. Later states require persisted lineage:

| State | Required persisted lineage |
| --- | --- |
| context-ready | frozen ContextSnapshot |
| planned | Plan hash |
| validated | validation receipt |
| policy-evaluated | policy snapshot |
| awaiting-decision | authoritative Decision ID |
| authorized | authorization grant hash |
| tasks-created | Task hash + authorization-consumption hash |
| jobs-enqueued | durable Job ID |
| verifying | Verification request ID |
| completed | verified Outcome + verification receipt |

A worker restart resumes from the persisted state. It must not blindly replay already completed stages or external side effects.

## Persistence requirement

Production orchestration storage must provide:

- external durability
- compare-and-swap updates
- unique correlation IDs
- restart safety
- multi-process safety
- production eligibility

The orchestration store persists coordinator checkpoints only. Durable business execution remains owned by the existing Job runtime.

## Waiting for owner input

`awaiting-decision` is intentionally not worker-resumable.

A Decision resolution event must explicitly resume the run. Resume input includes the expected version and record hash so a stale or duplicate continuation fails closed.

## Completion rule

The coordinator cannot claim `completed` from provider acceptance, HTTP success, worker completion, or an unverified result.

Contract v1 requires independently verified Outcome lineage before completion.

## Next implementation slice

Implement the first concrete coordinator using this contract:

1. Postgres-backed orchestration run store.
2. Idempotent OwnerIntent -> orchestration start.
3. Frozen ContextSnapshot creation.
4. Existing durable runtime scheduling for coordinator advancement.
5. Resume after authoritative Decision resolution.
6. Restart/replay tests at every checkpoint.

Do not add decision learning or learned-policy promotion in this slice. First prove the closed-loop coordinator safely composes the existing system.
