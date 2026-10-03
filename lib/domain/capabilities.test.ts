import { describe, expect, it } from "vitest";
import {
  getCapability,
  requireEnabledCapability,
  validateCapabilityInput,
  validateCapabilityOutput
} from "@/lib/domain/capabilities";

describe("capability registry", () => {
  it("keeps routine repository work AUTO while production deployment requires approval", () => {
    expect(requireEnabledCapability("github.branch.create").approval).toBe("auto");
    expect(requireEnabledCapability("github.commit.create").approval).toBe("auto");

    const capability = requireEnabledCapability("production.deploy");
    expect(capability.productionEffect).toBe(true);
    expect(capability.approval).toBe("approval");

    expect(requireEnabledCapability("github.protected-branch.commit").approval)
      .toBe("strong-approval");
  });

  it("fails closed for unknown capabilities", () => {
    expect(getCapability("execute_anything")).toBeUndefined();
    expect(() => requireEnabledCapability("execute_anything")).toThrow();
  });

  it("validates capability input at runtime", () => {
    const parsed = validateCapabilityInput<{ companyId: string }>("resource.health.read", {
      companyId: "company-a",
      resourceId: "resource-a"
    });
    expect(parsed.companyId).toBe("company-a");

    expect(() => validateCapabilityInput("resource.health.read", {
      companyId: "company-a",
      resourceId: "../resource-a"
    })).toThrow();
  });

  it("validates provider output before downstream use", () => {
    expect(() => validateCapabilityOutput("resource.health.read", {
      resourceId: "resource-a",
      status: "made-up-status",
      telemetryAt: "2026-09-20T16:00:00Z",
      checks: []
    })).toThrow();

    const parsed = validateCapabilityOutput<{ status: string }>("resource.health.read", {
      resourceId: "resource-a",
      status: "ready",
      telemetryAt: "2026-09-20T16:00:00Z",
      checks: [{ name: "heartbeat", healthy: true }]
    });
    expect(parsed.status).toBe("ready");
  });
});
