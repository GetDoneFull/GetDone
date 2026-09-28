import { ControlPlaneError } from "@/lib/control-plane/errors";

export type StateMachineEntity =
  | "goal"
  | "plan"
  | "decision"
  | "approval"
  | "task"
  | "job"
  | "outcome"
  | "event"
  | "verification"
  | "resource-enrollment"
  | "resource"
  | "reservation";

const transitions: Record<StateMachineEntity, Record<string, readonly string[]>> = {
  goal: {
    draft: ["active", "cancelled"],
    active: ["paused", "completed", "cancelled"],
    paused: ["active", "cancelled"],
    completed: [],
    cancelled: []
  },
  plan: {
    proposed: ["validating", "cancelled"],
    validating: ["validated", "rejected", "cancelled"],
    validated: ["awaiting-authorization", "cancelled"],
    "awaiting-authorization": ["authorized", "rejected", "cancelled"],
    authorized: ["compiled", "cancelled"],
    compiled: [],
    rejected: [],
    cancelled: []
  },
  decision: {
    pending: ["approved", "modified", "rejected"],
    approved: [],
    modified: [],
    rejected: []
  },
  approval: {
    pending: ["granted", "denied", "expired"],
    granted: [],
    denied: [],
    expired: []
  },
  task: {
    proposed: ["authorized", "cancelled"],
    authorized: ["queued", "cancelled"],
    queued: ["running", "cancelled", "failed"],
    running: ["verifying", "failed", "cancelled", "queued"],
    verifying: ["succeeded", "failed", "uncertain"],
    succeeded: [],
    failed: ["queued"],
    uncertain: [],
    cancelled: []
  },
  job: {
    created: ["queued", "cancelled"],
    queued: ["claimed", "cancelled", "failed", "blocked"],
    claimed: ["executing", "queued", "failed", "blocked", "cancelled"],
    executing: ["provider_completed", "queued", "failed", "blocked", "cancelled"],
    provider_completed: ["verifying", "failed", "blocked", "cancelled"],
    verifying: ["verified", "failed", "blocked"],
    verified: [],
    failed: ["queued"],
    blocked: ["queued", "cancelled"],
    cancelled: [],

    // Read/transition compatibility for records created before Tranche C.
    // New code never emits these legacy states.
    running: ["provider_completed", "queued", "failed", "blocked", "cancelled"],
    succeeded: [],
    uncertain: ["verifying", "blocked", "cancelled"]
  },
  outcome: {
    recorded: ["verified", "uncertain", "rejected"],
    uncertain: ["verified", "rejected"],
    verified: [],
    rejected: []
  },
  event: {
    recorded: ["accepted", "rejected", "ignored"],
    accepted: ["processing", "ignored"],
    processing: ["processed", "failed", "ignored"],
    failed: ["processing", "rejected"],
    processed: [],
    ignored: [],
    rejected: []
  },
  verification: {
    requested: ["collecting", "cancelled"],
    collecting: ["verified", "failed", "uncertain", "cancelled"],
    uncertain: ["collecting", "cancelled"],
    failed: ["collecting", "cancelled"],
    verified: [],
    cancelled: []
  },
  "resource-enrollment": {
    identify: ["create-enrollment", "cancelled", "expired"],
    "create-enrollment": ["owner-action", "authenticate", "cancelled", "expired"],
    "owner-action": ["authenticate", "cancelled", "expired"],
    authenticate: ["discover", "failed", "cancelled", "expired"],
    discover: ["profile", "failed", "cancelled", "expired"],
    profile: ["validate", "failed", "cancelled", "expired"],
    validate: ["test", "failed", "cancelled", "expired"],
    test: ["register", "failed", "cancelled", "expired"],
    register: ["ready", "failed", "cancelled", "expired"],
    ready: [],
    cancelled: ["identify"],
    expired: ["identify"],
    failed: ["identify"]
  },
  resource: {
    discovered: ["enrolling", "disabled"],
    enrolling: ["profiling", "failed", "disabled"],
    profiling: ["validating", "failed", "disabled"],
    validating: ["ready", "quarantined", "failed", "disabled"],
    ready: ["degraded", "saturated", "draining", "unreachable", "maintenance", "disabled"],
    degraded: ["ready", "draining", "unreachable", "failed", "maintenance", "disabled"],
    saturated: ["ready", "degraded", "draining", "unreachable", "disabled"],
    draining: ["ready", "maintenance", "disabled"],
    unreachable: ["ready", "degraded", "failed", "quarantined", "disabled"],
    failed: ["enrolling", "maintenance", "disabled"],
    quarantined: ["validating", "maintenance", "disabled"],
    maintenance: ["validating", "disabled"],
    disabled: ["enrolling"]
  },
  reservation: {
    requested: ["active", "rejected", "expired", "cancelled"],
    active: ["released", "expired", "cancelled"],
    rejected: [],
    released: [],
    expired: [],
    cancelled: []
  }
};

export interface StateTransitionRecord {
  entityType: StateMachineEntity;
  entityId: string;
  from: string;
  to: string;
  actorId: string;
  scopeId: string;
  triggeringEvent: string;
  occurredAt: string;
}

export function canTransition(entityType: StateMachineEntity, from: string, to: string) {
  return transitions[entityType][from]?.includes(to) ?? false;
}

export function assertTransition(entityType: StateMachineEntity, from: string, to: string) {
  if (!canTransition(entityType, from, to)) {
    throw new ControlPlaneError("CONFLICT", `Invalid ${entityType} transition: ${from} -> ${to}`);
  }
}

export function createTransitionRecord(input: Omit<StateTransitionRecord, "occurredAt">): StateTransitionRecord {
  assertTransition(input.entityType, input.from, input.to);
  return { ...input, occurredAt: new Date().toISOString() };
}
