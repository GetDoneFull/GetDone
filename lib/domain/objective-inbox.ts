import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export const OBJECTIVE_INBOX_CONTRACT_VERSION = "1.0.0";

export type ObjectiveSource =
  | "free_text"
  | "multiline_list"
  | "checklist"
  | "pasted_document"
  | "uploaded_text"
  | "structured_json";

export type ObjectivePriority = "low" | "normal" | "high" | "urgent";
export type ObjectiveRiskLevel = "low" | "medium" | "high" | "critical";
export type ObjectiveRelationship = "independent" | "dependent" | "step";

export type ObjectiveStatus =
  | "queued"
  | "planning"
  | "executing"
  | "completed"
  | "partially_completed"
  | "new_work_required"
  | "blocked"
  | "needs_owner_input"
  | "failed"
  | "cancelled";

export type ObjectiveProgressStatus = "done" | "running" | "waiting" | "failed";

export interface ObjectiveProgressItem {
  label: string;
  status: ObjectiveProgressStatus;
  verified?: boolean;
  occurredAt?: string;
}

export interface ObjectiveRecord {
  id: string;
  objectiveId: string;
  correlationId?: string;
  portfolioId: string;
  companyId: string;
  environment: TrustedExecutionScope["environment"];
  createdByUserId: string;
  source: ObjectiveSource;
  rawText: string;
  normalizedGoal: string;
  desiredOutcome: string;
  constraints: readonly string[];
  priority: ObjectivePriority;
  deadline?: string;
  successCriteria: readonly string[];
  riskLevel: ObjectiveRiskLevel;
  status: ObjectiveStatus;
  relationship: ObjectiveRelationship;
  parentObjectiveId?: string;
  dependsOnObjectiveIds: readonly string[];
  progress: readonly ObjectiveProgressItem[];
  createdAt: string;
  completedAt?: string;
  updatedAt: string;
  version: number;
}

export interface ObjectiveIntakeInput {
  rawText: string;
  source?: ObjectiveSource;
  fileName?: string;
}

export interface ObjectiveIntakeStore {
  createBatch(
    records: readonly ObjectiveRecord[],
    idempotencyKey: string
  ): Promise<readonly ObjectiveRecord[]>;
}

export interface ObjectiveIntakeContext {
  scope: TrustedExecutionScope;
  correlationId: string;
  now: string;
  nextId?: () => string;
}

interface ObjectiveDraft {
  rawText: string;
  normalizedGoal: string;
  desiredOutcome: string;
  constraints: string[];
  priority: ObjectivePriority;
  deadline?: string;
  successCriteria: string[];
  riskLevel: ObjectiveRiskLevel;
  status: ObjectiveStatus;
  relationship: ObjectiveRelationship;
  parentIndex?: number;
  dependsOnIndexes: number[];
}

const LIST_MARKER = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/;
const CHECKBOX_MARKER = /^\s*[-*+]\s*\[[ xX]\]\s+/;
const STEP_PREFIX = /^\s*(?:step\s*:?|subtask\s*:?|do\s*:?)\s*/i;
const DEPENDENT_PREFIX = /^\s*(?:then\s*:?|after(?:wards)?\s*:?|depends?\s+on\s*:?|dependent\s*:?|next\s*:)\s*/i;
const CONTROL_LANGUAGE = /\b(?:ask me|approval|approve|before production|automatically|safe fixes?|do not|don't|without|only|must|never|avoid|limit|maximum|minimum|budget|rollback)\b/i;
const HIGH_RISK = /\b(?:production|prod\b|deploy|release|payment|refund|delete|drop|credential|secret|customer data|schema migration)\b/i;
const MEDIUM_RISK = /\b(?:staging|modify|write|publish|email|campaign|database|migration)\b/i;

function cleanGoal(value: string) {
  return value
    .replace(CHECKBOX_MARKER, "")
    .replace(LIST_MARKER, "")
    .replace(STEP_PREFIX, "")
    .replace(DEPENDENT_PREFIX, "")
    .replace(/^objective\s*:\s*/i, "")
    .trim()
    .replace(/[.:;]+$/, "")
    .trim();
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function asPriority(value: unknown): ObjectivePriority {
  return value === "low" || value === "high" || value === "urgent" ? value : "normal";
}

function asRisk(value: unknown, text: string): ObjectiveRiskLevel {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  if (/\b(?:delete production|drop production|rotate production secret|wire funds)\b/i.test(text)) {
    return "critical";
  }
  if (HIGH_RISK.test(text)) return "high";
  if (MEDIUM_RISK.test(text)) return "medium";
  return "low";
}

function asStatus(value: unknown): ObjectiveStatus {
  switch (value) {
    case "queued":
    case "planning":
    case "executing":
    case "completed":
    case "partially_completed":
    case "new_work_required":
    case "blocked":
    case "needs_owner_input":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "queued";
  }
}

function sentenceParts(text: string) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function draftFromText(
  text: string,
  relationship: ObjectiveRelationship = "independent"
): ObjectiveDraft {
  const parts = sentenceParts(text);
  const first = cleanGoal(parts[0] || text);
  const constraints = parts.slice(1)
    .map((part) => part.replace(/[.!?]+$/, "").trim())
    .filter((part) => CONTROL_LANGUAGE.test(part));

  return {
    rawText: text.trim(),
    normalizedGoal: first || "Untitled objective",
    desiredOutcome: first || "Complete the requested objective",
    constraints,
    priority: "normal",
    successCriteria: [],
    riskLevel: asRisk(undefined, text),
    status: "queued",
    relationship,
    dependsOnIndexes: []
  };
}

function inferSource(rawText: string, requested?: ObjectiveSource): ObjectiveSource {
  if (requested) return requested;
  const trimmed = rawText.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return "structured_json";
    } catch {
      // Invalid JSON falls through to plain-text intake unless JSON was explicitly selected.
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.some((line) => CHECKBOX_MARKER.test(line))) return "checklist";
  if (lines.length > 1 && lines.filter((line) => LIST_MARKER.test(line)).length >= 2) {
    return "multiline_list";
  }
  if (
    lines.length >= 2
    && lines.length <= 50
    && lines.every((line) => line.trim().length <= 240)
    && !trimmed.includes("\n\n")
  ) {
    return "multiline_list";
  }
  if (trimmed.includes("\n\n") || lines.length > 4 || trimmed.length > 800) {
    return "pasted_document";
  }
  return "free_text";
}

function structuredDrafts(rawText: string): ObjectiveDraft[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Structured objective input must be valid JSON");
  }

  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).objectives)
      ? (parsed as Record<string, unknown>).objectives as unknown[]
      : [parsed];

  if (records.length === 0 || records.length > 100) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Structured objective input must contain 1 to 100 objectives");
  }

  return records.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `Structured objective at index ${index} must be an object`
      );
    }
    const row = value as Record<string, unknown>;
    const raw = [
      row.raw_text,
      row.rawText,
      row.normalized_goal,
      row.normalizedGoal,
      row.goal,
      row.objective,
      row.text
    ].find((candidate) => typeof candidate === "string" && candidate.trim()) as string | undefined;

    if (!raw) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        `Structured objective at index ${index} is missing goal/text`
      );
    }

    const normalizedGoal = cleanGoal(
      String(row.normalized_goal ?? row.normalizedGoal ?? row.goal ?? row.objective ?? raw)
    );
    const desiredOutcome = cleanGoal(
      String(row.desired_outcome ?? row.desiredOutcome ?? normalizedGoal)
    );
    const relationshipValue = row.relationship;
    const relationship: ObjectiveRelationship =
      relationshipValue === "step" || relationshipValue === "dependent"
        ? relationshipValue
        : "independent";
    const parentIndexValue = row.parent_index ?? row.parentIndex ?? row.parent_objective_index;
    const dependsValue = row.depends_on_indexes ?? row.dependsOnIndexes ?? row.depends_on;

    return {
      rawText: raw.trim(),
      normalizedGoal,
      desiredOutcome,
      constraints: asStringArray(row.constraints),
      priority: asPriority(row.priority),
      deadline: typeof row.deadline === "string" && row.deadline.trim() ? row.deadline.trim() : undefined,
      successCriteria: asStringArray(row.success_criteria ?? row.successCriteria),
      riskLevel: asRisk(row.risk_level ?? row.riskLevel, raw),
      status: asStatus(row.status),
      relationship,
      parentIndex:
        typeof parentIndexValue === "number" && Number.isInteger(parentIndexValue)
          ? parentIndexValue
          : undefined,
      dependsOnIndexes: Array.isArray(dependsValue)
        ? dependsValue.filter((item): item is number => Number.isInteger(item))
        : []
    };
  });
}

function textDrafts(rawText: string, source: ObjectiveSource): ObjectiveDraft[] {
  const rawLines = rawText.split(/\r?\n/);
  const nonEmpty = rawLines
    .map((line, index) => ({ line, index, trimmed: line.trim() }))
    .filter((entry) => entry.trimmed);

  const markedEntries = nonEmpty.filter((entry) =>
    CHECKBOX_MARKER.test(entry.line) || LIST_MARKER.test(entry.line)
  );
  const explicitObjectives = nonEmpty.filter((entry) => /^objective\s*:/i.test(entry.trimmed));

  if (explicitObjectives.length > 1) {
    return explicitObjectives.map((entry) => draftFromText(entry.trimmed));
  }

  if (source === "free_text" || source === "pasted_document") {
    return [draftFromText(rawText)];
  }

  const uploadedListShape =
    source === "uploaded_text"
    && nonEmpty.length >= 2
    && nonEmpty.length <= 50
    && nonEmpty.every((entry) => entry.trimmed.length <= 240)
    && !rawText.includes("\n\n");

  const listEntries = markedEntries.length >= 2
    ? markedEntries
    : source === "multiline_list" || uploadedListShape
      ? nonEmpty
      : markedEntries;

  if (listEntries.length < 2) return [draftFromText(rawText)];

  const first = nonEmpty[0];
  const headingOwnsSteps =
    first.index < listEntries[0].index
    && !CHECKBOX_MARKER.test(first.line)
    && !LIST_MARKER.test(first.line)
    && /[:：]\s*$/.test(first.trimmed);

  if (headingOwnsSteps) {
    const root = draftFromText(first.trimmed.replace(/[:：]\s*$/, ""));
    const drafts = [root];
    for (const entry of listEntries) {
      const child = draftFromText(entry.trimmed, "step");
      child.parentIndex = 0;
      drafts.push(child);
    }
    return drafts;
  }

  const drafts: ObjectiveDraft[] = [];
  for (const entry of listEntries) {
    const markerStripped = entry.trimmed
      .replace(CHECKBOX_MARKER, "")
      .replace(LIST_MARKER, "")
      .trim();
    const dependent = DEPENDENT_PREFIX.test(markerStripped);
    const step = STEP_PREFIX.test(markerStripped);
    const draft = draftFromText(
      markerStripped,
      step ? "step" : dependent ? "dependent" : "independent"
    );
    if (step && drafts.length > 0) draft.parentIndex = drafts.length - 1;
    if (dependent && drafts.length > 0) draft.dependsOnIndexes = [drafts.length - 1];
    drafts.push(draft);
  }
  return drafts.length ? drafts : [draftFromText(rawText)];
}

export function normalizeObjectiveIntake(
  input: ObjectiveIntakeInput,
  context: ObjectiveIntakeContext
): readonly ObjectiveRecord[] {
  const rawText = input.rawText.trim();
  if (!rawText) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Objective input cannot be empty");
  }
  if (rawText.length > 100_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Objective input exceeds 100,000 characters");
  }

  const source = inferSource(rawText, input.source);
  const drafts = source === "structured_json"
    ? structuredDrafts(rawText)
    : textDrafts(rawText, source);

  if (drafts.length === 0 || drafts.length > 100) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Objective intake must produce 1 to 100 objectives");
  }

  const nextId = context.nextId ?? (() => crypto.randomUUID());
  const ids = drafts.map(() => nextId());

  return Object.freeze(drafts.map((draft, index) => {
    const parentObjectiveId = draft.parentIndex !== undefined
      ? ids[draft.parentIndex]
      : undefined;
    const dependsOnObjectiveIds = draft.dependsOnIndexes
      .filter((dependencyIndex) => dependencyIndex >= 0 && dependencyIndex < ids.length)
      .map((dependencyIndex) => ids[dependencyIndex]);

    return Object.freeze({
      id: ids[index],
      objectiveId: ids[index],
      correlationId: context.correlationId,
      portfolioId: context.scope.portfolioId,
      companyId: context.scope.companyId,
      environment: context.scope.environment,
      createdByUserId: context.scope.userId,
      source,
      rawText: draft.rawText,
      normalizedGoal: draft.normalizedGoal,
      desiredOutcome: draft.desiredOutcome,
      constraints: Object.freeze([...draft.constraints]),
      priority: draft.priority,
      deadline: draft.deadline,
      successCriteria: Object.freeze([...draft.successCriteria]),
      riskLevel: draft.riskLevel,
      status: draft.status,
      relationship: draft.relationship,
      parentObjectiveId,
      dependsOnObjectiveIds: Object.freeze(dependsOnObjectiveIds),
      progress: Object.freeze([]),
      createdAt: context.now,
      updatedAt: context.now,
      version: 1
    });
  }));
}

export function objectiveInboxCounts(
  objectives: readonly Pick<ObjectiveRecord, "status" | "completedAt" | "updatedAt">[],
  now = new Date()
) {
  const today = now.toISOString().slice(0, 10);
  return {
    running: objectives.filter((objective) =>
      objective.status === "queued"
      || objective.status === "planning"
      || objective.status === "executing"
      || objective.status === "new_work_required"
    ).length,
    waitingForOwner: objectives.filter((objective) =>
      objective.status === "needs_owner_input"
    ).length,
    completedToday: objectives.filter((objective) =>
      objective.status === "completed"
      && (objective.completedAt ?? objective.updatedAt).slice(0, 10) === today
    ).length
  };
}
