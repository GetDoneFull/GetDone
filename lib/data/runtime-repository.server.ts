import "server-only";

import { headers } from "next/headers";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { ApiEnvelope } from "@/lib/control-plane/schemas";
import { developmentSeedAllowed } from "@/lib/control-plane/runtime-environment";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { Resource as AuthoritativeResource } from "@/lib/domain/resources";
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import {
  developmentOwnerRepository,
  type OwnerReadRepository,
  type OwnerResourceSummary
} from "@/lib/data/repository";
import type {
  Decision,
  DecisionPriority,
  ObjectiveView,
  Resource
} from "@/lib/types";

type DecisionPresentation = Partial<Pick<
  Decision,
  "title" | "subtitle" | "priority" | "category" | "rationale" | "impact"
  | "objectiveId" | "actionLabel" | "evidence" | "blastRadius"
>>;

type ResourcePresentation = Partial<Pick<
  Resource,
  "name" | "role" | "provider" | "location" | "customerDataPolicy" | "reliabilityTier"
>>;

function isEnvelope<T>(value: unknown): value is ApiEnvelope<T> {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.ok === "boolean"
    && typeof record.correlationId === "string"
    && (
      record.environment === "development"
      || record.environment === "staging"
      || record.environment === "production"
    );
}

function titleFromId(id: string) {
  return id
    .replace(/[._:-]+/g, " ")
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function ageFrom(timestamp: string) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "Recently";
  const deltaMinutes = Math.max(0, Math.round((Date.now() - parsed) / 60_000));
  if (deltaMinutes < 60) return `${Math.max(1, deltaMinutes)}m ago`;
  const hours = Math.round(deltaMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function decisionPriority(value: unknown, requiresStepUp: boolean): DecisionPriority {
  return value === "high" || value === "normal" || value === "fyi"
    ? value
    : requiresStepUp ? "high" : "normal";
}

function decisionCategory(value: unknown): Decision["category"] {
  return value === "resource"
    || value === "growth"
    || value === "incident"
    || value === "budget"
    || value === "outreach"
    ? value
    : "growth";
}

function toDecision(value: AuthoritativeDecision): Decision {
  const presentation = value as AuthoritativeDecision & DecisionPresentation;
  return {
    id: value.id,
    title: presentation.title ?? titleFromId(value.id),
    subtitle: presentation.subtitle ?? (
      value.requiresStepUp ? "Owner review · strong approval required" : "Owner review"
    ),
    priority: decisionPriority(presentation.priority, value.requiresStepUp),
    age: ageFrom(value.updatedAt),
    category: decisionCategory(presentation.category),
    status: value.status,
    rationale: presentation.rationale
      ?? "Authoritative GetDone decision loaded from the scoped Control API.",
    impact: presentation.impact?.length
      ? [...presentation.impact]
      : ["Mutation is scope-bound, idempotent, audited, and persisted."],
    objectiveId: presentation.objectiveId,
    actionLabel: presentation.actionLabel,
    evidence: presentation.evidence?.length ? [...presentation.evidence] : undefined,
    blastRadius: presentation.blastRadius
  };
}

function toObjective(value: ObjectiveRecord): ObjectiveView {
  return {
    id: value.id,
    title: value.normalizedGoal,
    desiredOutcome: value.desiredOutcome,
    status: value.status,
    priority: value.priority,
    riskLevel: value.riskLevel,
    constraints: [...value.constraints],
    successCriteria: [...value.successCriteria],
    relationship: value.relationship,
    parentObjectiveId: value.parentObjectiveId,
    dependsOnObjectiveIds: [...value.dependsOnObjectiveIds],
    progress: value.progress.map((item) => ({ ...item })),
    createdAt: value.createdAt,
    completedAt: value.completedAt
  };
}

function resourceHealth(state: AuthoritativeResource["state"]): Resource["health"] {
  if (state === "ready") return "healthy";
  if (state === "degraded" || state === "saturated" || state === "draining") return "degraded";
  if (
    state === "unreachable"
    || state === "failed"
    || state === "quarantined"
    || state === "disabled"
  ) return "offline";
  return "online";
}

function resourceIcon(type: AuthoritativeResource["type"]): Resource["icon"] {
  if (type === "gpu") return "gpu";
  if (type === "storage") return "storage";
  if (type === "network") return "network";
  if (type === "cloud") return "cloud";
  return "server";
}

function resourceKind(type: AuthoritativeResource["type"]): Resource["kind"] {
  if (type === "gpu") return "compute";
  return type;
}

function toResource(value: AuthoritativeResource): Resource {
  const presentation = value as AuthoritativeResource & ResourcePresentation;
  const capabilities = value.capabilityNames.length;
  return {
    id: value.id,
    name: presentation.name ?? titleFromId(value.id),
    role: presentation.role ?? `${value.type} · ${value.state}`,
    kind: resourceKind(value.type),
    health: resourceHealth(value.state),
    provider: presentation.provider ?? value.providerId ?? "GetDone",
    location: presentation.location ?? value.region ?? "Unspecified",
    environments: value.environmentPermissions.map(
      (environment) => environment.charAt(0).toUpperCase() + environment.slice(1)
    ),
    customerDataPolicy: presentation.customerDataPolicy
      ?? (value.dataClassesAllowed.length
        ? value.dataClassesAllowed.join(" · ")
        : "No data classes authorized"),
    reliabilityTier: presentation.reliabilityTier ?? value.trustClass,
    autoScheduling: value.state === "ready",
    metrics: [
      { label: "Capabilities", value: String(capabilities) },
      { label: "Trust", value: value.trustClass },
      { label: "Version", value: String(value.version) }
    ],
    workloads: { running: 0, queued: 0, utilization: 0 },
    icon: resourceIcon(value.type)
  };
}

async function requestContextHeaders() {
  const incoming = await headers();
  const outgoing = new Headers({ accept: "application/json" });
  for (const name of ["cookie", "authorization", "x-getdone-portfolio-id"]) {
    const value = incoming.get(name);
    if (value) outgoing.set(name, value);
  }
  return { incoming, outgoing };
}

function controlApiBaseUrl(incoming: Headers) {
  const configured = process.env.GETDONE_CONTROL_API_URL?.trim();
  if (configured) return configured.endsWith("/") ? configured : configured + "/";

  const host = incoming.get("x-forwarded-host")?.split(",")[0]?.trim()
    ?? incoming.get("host")?.trim();
  if (!host) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "GETDONE_CONTROL_API_URL or an authoritative request host is required"
    );
  }
  const proto = incoming.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "https";
  return `${proto}://${host}/`;
}

async function controlGet<T>(path: string): Promise<T> {
  const { incoming, outgoing } = await requestContextHeaders();
  const response = await fetch(new URL(path, controlApiBaseUrl(incoming)), {
    method: "GET",
    cache: "no-store",
    headers: outgoing
  });
  const value: unknown = await response.json().catch(() => null);
  if (!isEnvelope<T>(value)) {
    throw new ControlPlaneError("UNAVAILABLE", "Control API returned an invalid owner-read response");
  }
  if (!value.ok) {
    throw new ControlPlaneError(value.error.code, value.error.message, {
      correlationId: value.correlationId
    });
  }
  if (!response.ok) {
    throw new ControlPlaneError("UNAVAILABLE", "Control API returned an inconsistent owner-read response");
  }
  return value.data;
}

const controlApiOwnerRepository: OwnerReadRepository = {
  async listObjectives() {
    return (await controlGet<ObjectiveRecord[]>("/api/control/objectives")).map(toObjective);
  },
  async getObjective(id) {
    try {
      return toObjective(
        await controlGet<ObjectiveRecord>(`/api/control/objectives/${encodeURIComponent(id)}`)
      );
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  },
  async listDecisions() {
    return (await controlGet<AuthoritativeDecision[]>("/api/control/decisions")).map(toDecision);
  },
  async getDecision(id) {
    try {
      return toDecision(
        await controlGet<AuthoritativeDecision>(`/api/control/decisions/${encodeURIComponent(id)}`)
      );
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  },
  async listResources() {
    return (await controlGet<AuthoritativeResource[]>("/api/control/resources")).map(toResource);
  },
  async getResource(id) {
    try {
      return toResource(
        await controlGet<AuthoritativeResource>(`/api/control/resources/${encodeURIComponent(id)}`)
      );
    } catch (error) {
      if (error instanceof ControlPlaneError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  },
  async getResourceSummary(): Promise<OwnerResourceSummary> {
    const resources = (await controlGet<AuthoritativeResource[]>("/api/control/resources"))
      .map(toResource);
    const degraded = resources.some(
      (resource) => resource.health === "degraded" || resource.health === "offline"
    );
    return {
      health: degraded ? "Needs attention" : "Healthy",
      resourceCount: resources.length,
      capacity: 0,
      monthlySpend: "Not connected",
      monthlyChange: "Authoritative registry",
      ownedSavings: "Not measured"
    };
  }
};

export async function getOwnerReadRepository(): Promise<OwnerReadRepository> {
  if (developmentSeedAllowed({
    runtimeEnvironment: process.env.GETDONE_RUNTIME_ENV,
    dataMode: process.env.GETDONE_DATA_MODE
  })) {
    return developmentOwnerRepository;
  }
  return controlApiOwnerRepository;
}
