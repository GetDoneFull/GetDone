"use client";

import Link from "next/link";
import { FileText, Plus, Upload } from "lucide-react";
import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Brand } from "@/components/brand";
import type { ObjectiveView } from "@/lib/types";

function authoritativeRuntime() {
  return process.env.NEXT_PUBLIC_APP_ENV !== "development";
}

function isCompletedToday(objective: ObjectiveView) {
  if (objective.status !== "completed" || !objective.completedAt) return false;
  const completed = new Date(objective.completedAt);
  const now = new Date();
  return completed.getFullYear() === now.getFullYear()
    && completed.getMonth() === now.getMonth()
    && completed.getDate() === now.getDate();
}

export function HomeDashboard({ objectives }: { objectives: ObjectiveView[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [rawText, setRawText] = useState("");
  const [source, setSource] = useState<"uploaded_text" | "structured_json" | undefined>();
  const [fileName, setFileName] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const running = objectives.filter((objective) =>
    objective.status === "queued"
    || objective.status === "planning"
    || objective.status === "executing"
    || objective.status === "new_work_required"
  ).length;
  const waiting = objectives.filter((objective) =>
    objective.status === "needs_owner_input"
  ).length;
  const completedToday = objectives.filter(isCompletedToday).length;
  const recent = objectives
    .filter((objective) => objective.relationship !== "step")
    .slice(0, 3);

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 100_000) {
      setNotice("Text/task files must be 100 KB or smaller.");
      return;
    }
    try {
      const text = await file.text();
      setRawText(text);
      setFileName(file.name);
      setSource(file.name.toLowerCase().endsWith(".json") ? "structured_json" : "uploaded_text");
      setNotice("Loaded " + file.name + ". Review it, then add the objective.");
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch {
      setNotice("GetDone could not read that text/task file.");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = rawText.trim();
    if (!clean || submitting) return;

    if (!authoritativeRuntime()) {
      setNotice("Development preview: objective accepted locally. No authoritative record was created.");
      setRawText("");
      setSource(undefined);
      setFileName(undefined);
      return;
    }

    setSubmitting(true);
    setNotice("Adding objective...");
    try {
      const response = await fetch("/api/control/objectives", {
        method: "POST",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID()
        },
        body: JSON.stringify({
          rawText: clean,
          ...(source ? { source } : {}),
          ...(fileName ? { fileName } : {})
        })
      });
      const value = await response.json().catch(() => null) as {
        ok?: boolean;
        data?: Array<{ id: string }>;
        error?: { message?: string };
      } | null;

      if (!response.ok || !value?.ok) {
        throw new Error(value?.error?.message || "GetDone could not accept the objective");
      }

      const count = value.data?.length ?? 1;
      setRawText("");
      setSource(undefined);
      setFileName(undefined);
      setNotice(count === 1 ? "Objective added. GetDone is taking it from here." : `${count} objectives added from the batch.`);
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "GetDone could not accept the objective");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="ufo-home ufo-objective-home" aria-label="Objective Inbox">
      <div className="ufo-home-brand ufo-objective-brand">
        <Brand />
        <h1>What do you want done?</h1>
        <p>Give GetDone the outcome. It handles the machinery.</p>
      </div>

      <form className="ufo-command-card ufo-objective-composer" onSubmit={submit}>
        <textarea
          ref={inputRef}
          value={rawText}
          onChange={(event) => {
            setRawText(event.target.value);
            if (!fileName) setSource(undefined);
          }}
          placeholder="Fix onboarding. Make safe fixes yourself. Deploy staging automatically. Ask me before production."
          aria-label="Objective input"
          disabled={submitting}
          rows={6}
        />
        <div className="ufo-objective-composer-footer">
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".txt,.md,.task,.json,text/plain,application/json"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
          />
          <button
            className="ufo-objective-file"
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={submitting}
            aria-label="Upload text or task file"
          >
            <Upload size={16} />
            <span>{fileName ?? "Text / task file"}</span>
          </button>
          <button
            className="ufo-objective-add"
            type="submit"
            disabled={submitting || !rawText.trim()}
          >
            <Plus size={17} />
            <span>Add Objective</span>
          </button>
        </div>
      </form>

      {notice ? <div className="ufo-home-notice" role="status">{notice}</div> : null}

      <div className="ufo-objective-stats" aria-label="Objective status">
        <article><strong>{running}</strong><span>Running</span></article>
        <article><strong>{waiting}</strong><span>Waiting for you</span></article>
        <article><strong>{completedToday}</strong><span>Completed today</span></article>
      </div>

      <div className="ufo-objective-section-heading">
        <span>OBJECTIVES</span>
        {waiting > 0 ? <Link href="/decisions">Open Decision Center</Link> : null}
      </div>

      <div className="ufo-objective-list">
        {recent.length ? recent.map((objective) => (
          <Link
            key={objective.id}
            href={"/objectives/" + encodeURIComponent(objective.id)}
            className="ufo-objective-row"
          >
            <span className={"ufo-objective-state ufo-objective-state-" + objective.status} />
            <span>
              <strong>{objective.title}</strong>
              <small>
                {objective.status === "needs_owner_input"
                  ? "Waiting for you"
                  : objective.status.replaceAll("_", " ")}
              </small>
            </span>
            <FileText size={17} />
          </Link>
        )) : (
          <div className="ufo-empty-attention">
            <strong>No objectives yet.</strong>
            <span>Tell GetDone what outcome you want above.</span>
          </div>
        )}
      </div>
    </section>
  );
}
