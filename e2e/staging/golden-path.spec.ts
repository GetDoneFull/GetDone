import { expect, test } from "@playwright/test";
import {
  STAGING_USER_ID,
  createTaskJobAndExecute,
  decisionStatus,
  installVirtualAuthenticator,
  latestIntent,
  materializeDecisionFromIntent,
  resetAuthoritativeStaging,
  seedPasskeyOwner
} from "./support";

test.describe("authoritative staging browser golden path", () => {
  test("sign in → intent → Decision → approval → Task/Job → safe integration → verified completion", async ({ page, baseURL }) => {
    await resetAuthoritativeStaging();
    const passkey = await seedPasskeyOwner();

    await page.goto("/sign-in");
    await installVirtualAuthenticator(page, passkey);

    await page.getByLabel("GetDone user").fill(STAGING_USER_ID);
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByRole("heading", { name: /How can I/i })).toBeVisible();

    // The redirect can expose server-rendered HTML before the client component is
    // hydrated. Wait for the navigation to settle so this click exercises the
    // React Chat composer rather than a native form submit/reload.
    await page.waitForLoadState("networkidle");

    await page.getByLabel("Message GetDone").fill(
      "Run the controlled safe staging integration and show me the verified result"
    );
    const [intentResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/api/control/chat")
        && response.request().method() === "POST"
      ),
      page.getByRole("button", { name: "Send message" }).click()
    ]);
    expect(intentResponse.status()).toBe(202);
    await expect(page.getByRole("status")).toContainText("Accepted by GetDone");

    const intent = await latestIntent();
    expect(intent.correlationId).toBeTruthy();
    const decision = await materializeDecisionFromIntent(intent.correlationId);

    await page.goto("/decisions");
    await expect(page.getByText("Approve safe staging integration")).toBeVisible();
    await page.getByText("Approve safe staging integration").click();
    await expect(page).toHaveURL(`/decisions/${decision.id}`);

    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Authoritative status:/)).toContainText("approved");
    expect((await decisionStatus())?.status).toBe("approved");

    const execution = await createTaskJobAndExecute(
      intent.correlationId,
      baseURL ?? "http://localhost:3200"
    );

    await page.goto(`/operations/jobs/${execution.jobId}`);
    await expect(page.getByRole("heading", { name: "Authoritative completion" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("verified");
    await expect(page.getByText(/Verified · 1 evidence item/)).toBeVisible();
    await expect(page.getByTestId("job-correlation-id")).toHaveText(intent.correlationId);

    const jobResponse = await page.evaluate(async (jobId) => {
      const response = await fetch(`/api/control/jobs/${encodeURIComponent(jobId)}/result`, {
        cache: "no-store",
        credentials: "same-origin"
      });
      return { status: response.status, body: await response.json() };
    }, execution.jobId);

    expect(jobResponse.status).toBe(200);
    expect(jobResponse.body).toMatchObject({
      ok: true,
      environment: "staging",
      data: {
        jobId: execution.jobId,
        state: "verified",
        correlationId: intent.correlationId,
        verificationReceiptId: execution.receiptId
      }
    });
  });
});
