"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  getPasskeyAssertion,
  type BrowserPasskeyChallenge
} from "@/lib/auth/webauthn-browser";
import type { DecisionStatus } from "@/lib/types";

type DecisionAction = "approve" | "modify" | "reject";

function authoritativeRuntime() {
  return process.env.NEXT_PUBLIC_APP_ENV !== "development";
}

type Envelope<T> = {
  ok?: boolean;
  data?: T;
  error?: { message?: string };
};

async function responseEnvelope<T>(response: Response): Promise<Envelope<T>> {
  return await response.json().catch(() => ({})) as Envelope<T>;
}

async function performPasskeyStepUp() {
  const beginResponse = await fetch("/api/control/auth/step-up/begin", {
    method: "POST",
    cache: "no-store"
  });
  const begin = await responseEnvelope<BrowserPasskeyChallenge & {
    challengeId: string;
    expiresAt: string;
  }>(beginResponse);
  if (!beginResponse.ok || !begin.ok || !begin.data) {
    throw new Error(begin.error?.message || "Passkey step-up could not start");
  }

  const credential = await getPasskeyAssertion(begin.data);
  const verifyResponse = await fetch("/api/control/auth/step-up/verify", {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: begin.data.challengeId,
      credential
    })
  });
  const verified = await responseEnvelope<{ stepUpAuthenticatedAt: string }>(verifyResponse);
  if (!verifyResponse.ok || !verified.ok || !verified.data?.stepUpAuthenticatedAt) {
    throw new Error(verified.error?.message || "Passkey step-up failed");
  }
}

export function DecisionActions({
  decisionId,
  initialStatus,
  approveLabel = "Approve"
}: {
  decisionId: string;
  initialStatus: DecisionStatus;
  approveLabel?: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<DecisionStatus>(initialStatus);
  const [note, setNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function mutate(action: DecisionAction) {
    const next: DecisionStatus = action === "approve"
      ? "approved"
      : action === "modify"
        ? "modified"
        : "rejected";

    if (!authoritativeRuntime()) {
      setStatus(next);
      setNote(`Development preview status: ${next}. No server-side approval or side effect occurs.`);
      return;
    }

    if (submitting) return;
    setSubmitting(true);
    setNote("Saving authoritative decision...");
    const idempotencyKey = crypto.randomUUID();

    async function sendMutation() {
      const response = await fetch(`/api/control/decisions/${encodeURIComponent(decisionId)}`, {
        method: "PATCH",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        },
        body: JSON.stringify({ action })
      });
      return {
        response,
        value: await responseEnvelope<{ status?: DecisionStatus }>(response)
      };
    }

    try {
      let result = await sendMutation();
      const message = result.value.error?.message ?? "";
      if (
        action === "approve"
        && result.response.status === 403
        && /step-up/i.test(message)
      ) {
        setNote("Passkey approval required...");
        await performPasskeyStepUp();
        result = await sendMutation();
      }

      if (!result.response.ok || !result.value.ok || !result.value.data?.status) {
        throw new Error(result.value.error?.message || "Decision mutation failed");
      }
      setStatus(result.value.data.status);
      setNote(`Authoritative status: ${result.value.data.status}.`);
      router.refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Decision mutation failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="decision-actions">
      <div className="inline-note">
        {note ?? (
          authoritativeRuntime()
            ? <>Authoritative status: <strong>{status}</strong>.</>
            : <>Development preview status: <strong>{status}</strong>. No server-side approval or side effect occurs.</>
        )}
      </div>
      <div className="action-grid">
        <button type="button" className="secondary-action" disabled={submitting} onClick={() => mutate("reject")}>Reject</button>
        <button type="button" className="secondary-action" disabled={submitting} onClick={() => mutate("modify")}>Modify</button>
        <button type="button" className="primary-action" disabled={submitting} onClick={() => mutate("approve")}>{approveLabel}</button>
      </div>
    </div>
  );
}
