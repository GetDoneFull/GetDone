import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, createTransitionRecord } from "@/lib/domain/state-machine";

describe("authoritative state transitions", () => {
  it("allows configured transitions", () => {
    expect(canTransition("decision", "pending", "approved")).toBe(true);
    expect(canTransition("job", "executing", "provider_completed")).toBe(true);
    expect(canTransition("job", "provider_completed", "verifying")).toBe(true);
    expect(canTransition("job", "verifying", "verified")).toBe(true);
  });

  it("fails closed on invalid transitions", () => {
    expect(() => assertTransition("decision", "approved", "pending")).toThrow();
    expect(() => assertTransition("job", "created", "verified")).toThrow();
    expect(() => assertTransition("job", "provider_completed", "verified")).toThrow();
  });

  it("records actor and scope when transitioning", () => {
    const record = createTransitionRecord({
      entityType: "task",
      entityId: "task-1",
      from: "authorized",
      to: "queued",
      actorId: "user-1",
      scopeId: "company-1",
      triggeringEvent: "decision-approved"
    });

    expect(record.actorId).toBe("user-1");
    expect(record.scopeId).toBe("company-1");
  });
});
