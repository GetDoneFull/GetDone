import { expect, test } from "@playwright/test";

test.describe("existing owner surface", () => {
  test("applies browser response security headers", async ({ request }) => {
    const response = await request.get("/");
    expect(response.ok()).toBeTruthy();
    const headers = response.headers();
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["strict-transport-security"]).toBeUndefined();
  });

  test("primary Home / Decisions / Resources navigation stays usable", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /What do you want done/i })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(nav.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Decisions" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Resources" })).toBeVisible();

    await nav.getByRole("link", { name: "Decisions" }).click();
    await expect(page.getByRole("heading", { name: /Decision Center/ })).toBeVisible();
    await expect(page.getByText("Approve resource addition")).toBeVisible();

    await page.getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Resources" }).click();
    await expect(page.getByRole("heading", { name: /Resources/ })).toBeVisible();
    await expect(page.getByText("Home Pi")).toBeVisible();

    await page.getByRole("link", { name: /Add Resource/i }).click();
    await expect(page.getByRole("heading", { name: "What would you like to add?" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/resources");
  });

  test("direct decision and resource deep links resolve to scoped detail views", async ({ page }) => {
    await page.goto("/decisions/approve-dc-west");
    await expect(page.getByRole("heading", { name: "Approve resource addition" })).toBeVisible();
    await expect(page.getByText(/No server-side approval or side effect occurs/i)).toBeVisible();

    await page.goto("/resources/home-pi?incident=preview-incident");
    await expect(page.getByRole("heading", { name: /Home Pi/ })).toBeVisible();
    await expect(page.getByText(/Compute · Lightweight/)).toBeVisible();

    await page.goto("/decisions/approve-dc-west?resource=home-pi");
    await expect(page.getByRole("heading", { name: "Approve resource addition" })).toBeVisible();
  });

  test("unknown scoped resources and decisions fail closed to Not found", async ({ page }) => {
    await page.goto("/decisions/not-a-real-decision");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
    await expect(page.getByText(/not available in the current GetDone scope/i)).toBeVisible();

    await page.goto("/resources/not-a-real-resource");
    await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  });

  test("development API envelopes expose only development seed reads", async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.ok()).toBeTruthy();
    const healthBody = await health.json();
    expect(healthBody).toMatchObject({
      ok: true,
      environment: "development",
      data: {
        service: "getdone-web",
        status: "ok",
        authoritativeControlPlane: false,
        authProviderConnected: false,
        persistenceConnected: false,
        aiGatewayConnected: false,
        durableJobEngineConnected: false
      }
    });

    const resources = await request.get("/api/dev/resources");
    expect(resources.ok()).toBeTruthy();
    const resourceBody = await resources.json();
    expect(resourceBody.ok).toBe(true);
    expect(resourceBody.environment).toBe("development");
    expect(resourceBody.data.some((item: { id: string }) => item.id === "home-pi")).toBe(true);

    const decisions = await request.get("/api/dev/decisions");
    expect(decisions.ok()).toBeTruthy();
    const decisionBody = await decisions.json();
    expect(decisionBody.ok).toBe(true);
    expect(decisionBody.data.some((item: { id: string }) => item.id === "approve-dc-west")).toBe(true);

    const controlHealth = await request.get("/api/control/health");
    expect(controlHealth.ok()).toBeTruthy();
    expect(await controlHealth.json()).toMatchObject({
      ok: true,
      environment: "development",
      data: {
        service: "getdone-control-api",
        surfaceVersion: "1.5.0",
        status: "unavailable",
        authConnected: false,
        persistenceConnected: false
      }
    });

    const protectedControlRead = await request.get("/api/control/decisions");
    expect(protectedControlRead.status()).toBe(503);
    expect(await protectedControlRead.json()).toMatchObject({
      ok: false,
      error: { code: "UNAVAILABLE" }
    });
  });

  test("objective and decision controls remain preview-only", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Objective input").fill("Check the current resource state");
    await page.getByRole("button", { name: "Add Objective" }).click();
    await expect(page.getByRole("status")).toContainText("Development preview: objective accepted locally");

    await page.goto("/decisions/approve-dc-west");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Development preview status:/)).toContainText("approved");
    await expect(page.getByText(/No server-side approval or side effect occurs/i)).toBeVisible();
  });
});
