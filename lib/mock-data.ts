import type { Decision, ObjectiveView, Resource } from "./types";

export const resourceSummary = {
  health: "Healthy",
  resourceCount: 12,
  capacity: 68,
  monthlySpend: "$84,210",
  monthlyChange: "↓ 18%",
  ownedSavings: "$29,440"
} as const;

export const resources: Resource[] = [
  {
    id: "home-pi",
    name: "Home Pi",
    role: "Compute · Lightweight",
    kind: "compute",
    health: "online",
    provider: "Owned",
    location: "Home",
    environments: ["Development", "Staging"],
    customerDataPolicy: "No production customer data",
    reliabilityTier: "Best effort",
    autoScheduling: true,
    metrics: [
      { label: "CPU Available", value: "4 cores" },
      { label: "Memory Free", value: "6.1 GB", tone: "good" },
      { label: "Effective Cost", value: "$0.01/hr" }
    ],
    workloads: { running: 2, queued: 1, utilization: 41 },
    icon: "server"
  },
  {
    id: "home-gpu",
    name: "Home GPU",
    role: "Compute · AI/ML",
    kind: "compute",
    health: "online",
    provider: "Owned",
    location: "Home",
    environments: ["Development", "Staging"],
    customerDataPolicy: "Restricted",
    reliabilityTier: "Best effort",
    autoScheduling: true,
    metrics: [
      { label: "VRAM Available", value: "18 GB" },
      { label: "Utilization", value: "52%", tone: "good" },
      { label: "Effective Cost", value: "$0.07/hr" }
    ],
    workloads: { running: 3, queued: 2, utilization: 52 },
    icon: "gpu"
  },
  {
    id: "home-nas",
    name: "Home NAS",
    role: "Storage · Backup",
    kind: "storage",
    health: "healthy",
    provider: "Owned",
    location: "Home",
    environments: ["Development", "Staging"],
    customerDataPolicy: "Approved cache / backup only",
    reliabilityTier: "Secondary",
    autoScheduling: false,
    metrics: [
      { label: "Free Space", value: "3.2 TB", tone: "good" },
      { label: "Utilization", value: "68%" },
      { label: "Monthly Cost", value: "$18" }
    ],
    workloads: { running: 4, queued: 0, utilization: 68 },
    icon: "storage"
  },
  {
    id: "dc-west",
    name: "DC West",
    role: "Compute · GPU Pool",
    kind: "partner",
    health: "healthy",
    provider: "Partner Data Center",
    location: "US West",
    environments: ["Development", "Staging", "Production"],
    customerDataPolicy: "Allowed (restricted)",
    reliabilityTier: "High",
    autoScheduling: true,
    metrics: [
      { label: "GPUs Available", value: "1,248" },
      { label: "Utilization", value: "67%", tone: "good" },
      { label: "/ GPU hour", value: "$0.42" }
    ],
    workloads: { running: 12, queued: 48, utilization: 67 },
    icon: "server"
  },
  {
    id: "aws",
    name: "AWS",
    role: "Cloud · Multi",
    kind: "cloud",
    health: "healthy",
    provider: "AWS",
    location: "US multi-region",
    environments: ["Development", "Staging", "Production"],
    customerDataPolicy: "Policy-bound",
    reliabilityTier: "High",
    autoScheduling: true,
    metrics: [
      { label: "Regions Ready", value: "3" },
      { label: "Capacity", value: "Elastic", tone: "good" },
      { label: "Spend MTD", value: "$5.4k" }
    ],
    workloads: { running: 8, queued: 6, utilization: 38 },
    icon: "cloud"
  }
];

export const objectives: ObjectiveView[] = [
  {
    id: "objective-onboarding",
    title: "Improve OpsManagerPro onboarding",
    desiredOutcome: "New users complete onboarding successfully on the verified production build.",
    status: "needs_owner_input",
    priority: "high",
    riskLevel: "high",
    constraints: [
      "Make safe fixes automatically",
      "Deploy and verify staging automatically",
      "Ask the owner before production"
    ],
    successCriteria: [
      "Signup funnel issue reproduced",
      "Automated tests pass",
      "Staging deployment is verified",
      "Production requires explicit owner approval"
    ],
    relationship: "independent",
    dependsOnObjectiveIds: [],
    progress: [
      { label: "Investigated signup funnel", status: "done", verified: true },
      { label: "Reproduced frontend bug", status: "done", verified: true },
      { label: "Generated patch", status: "done", verified: true },
      { label: "Tests passed", status: "done", verified: true },
      { label: "Staging deployed", status: "done", verified: true },
      { label: "Staging verified", status: "done", verified: true },
      { label: "Production release needs your approval", status: "waiting" }
    ],
    createdAt: "2026-09-28T15:00:00.000Z"
  },
  {
    id: "objective-growth",
    title: "Increase qualified warehouse trials",
    desiredOutcome: "Increase qualified OpsManagerPro trials without raising unsafe spend.",
    status: "executing",
    priority: "normal",
    riskLevel: "medium",
    constraints: ["Stay inside approved outreach and budget policy"],
    successCriteria: ["Qualified trial trend improves"],
    relationship: "independent",
    dependsOnObjectiveIds: [],
    progress: [
      { label: "Analyzed current acquisition funnel", status: "done", verified: true },
      { label: "Running approved outreach experiment", status: "running" }
    ],
    createdAt: "2026-09-28T14:00:00.000Z"
  },
  {
    id: "objective-completed-today",
    title: "Verify StatusWatchPro monitor health",
    desiredOutcome: "All production monitors report verified healthy state.",
    status: "completed",
    priority: "normal",
    riskLevel: "low",
    constraints: [],
    successCriteria: ["Monitor health verified"],
    relationship: "independent",
    dependsOnObjectiveIds: [],
    progress: [{ label: "Production monitors verified healthy", status: "done", verified: true }],
    createdAt: "2026-09-28T12:00:00.000Z",
    completedAt: "2026-09-28T16:30:00.000Z"
  }
];

export const decisions: Decision[] = [
  {
    id: "approve-dc-west",
    title: "Approve resource addition",
    subtitle: "DC West compute pool",
    priority: "high",
    age: "2h ago",
    category: "resource",
    status: "pending",
    rationale: "The new partner pool passed the development preview checks and needs owner review before a future production enrollment workflow exists.",
    impact: ["Adds projected GPU capacity", "No production side effect in this build", "Real authorization is deferred"]
  },
  {
    id: "landing-page",
    title: "Release OpsManagerPro onboarding fix?",
    subtitle: "Verified staging build is ready for production",
    priority: "high",
    age: "4h ago",
    category: "growth",
    status: "pending",
    rationale: "The objective allowed safe fixes and staging deployment automatically, but production release was explicitly reserved for owner approval.",
    impact: ["7 files changed", "42 tests passed", "Staging verification passed"],
    objectiveId: "objective-onboarding",
    actionLabel: "Approve Production",
    evidence: ["7 files changed", "42 tests passed", "Staging verification passed", "No schema migration", "Rollback available"],
    blastRadius: "Onboarding flow"
  },
  {
    id: "production-error",
    title: "Production error fix",
    subtitle: "Error rate increased overnight",
    priority: "high",
    age: "6h ago",
    category: "incident",
    status: "pending",
    rationale: "Seed data representing a future incident-response approval.",
    impact: ["High attention", "No automatic production authority"]
  },
  {
    id: "ad-budget",
    title: "Increase ad budget",
    subtitle: "$50 → $100/day (test 7 days)",
    priority: "normal",
    age: "8h ago",
    category: "budget",
    status: "pending",
    rationale: "Seeded budget decision for UI testing.",
    impact: ["Would require budget policy checks in a later phase"]
  },
  {
    id: "prospects",
    title: "Add 2 prospects to outreach",
    subtitle: "High-fit warehouse leads",
    priority: "normal",
    age: "12h ago",
    category: "outreach",
    status: "pending",
    rationale: "Seeded outreach decision for UI testing.",
    impact: ["No email is sent in this phase"]
  },
  {
    id: "capacity-note",
    title: "Capacity trend recorded",
    subtitle: "Home GPU headroom remains healthy",
    priority: "fyi",
    age: "14h ago",
    category: "resource",
    status: "pending",
    rationale: "Seeded FYI item used to represent low-attention infrastructure context.",
    impact: ["Informational only", "No approval or action is required"]
  },
  {
    id: "growth-note",
    title: "Growth experiment summary",
    subtitle: "Landing-page signal retained for review",
    priority: "fyi",
    age: "1d ago",
    category: "growth",
    status: "pending",
    rationale: "Seeded FYI item used to round out the screenshot-style decision queue.",
    impact: ["Informational only"]
  }
];

export function getResource(id: string) {
  return resources.find((resource) => resource.id === id);
}

export function getDecision(id: string) {
  return decisions.find((decision) => decision.id === id);
}

export function getObjective(id: string) {
  return objectives.find((objective) => objective.id === id);
}
