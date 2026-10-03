import { AlertCircle, CheckCircle2, Circle, LoaderCircle } from "lucide-react";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DecisionActions } from "@/components/decision-actions";
import { DevelopmentBadge } from "@/components/dev-badge";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

function progressIcon(status: "done" | "running" | "waiting" | "failed") {
  if (status === "done") return <CheckCircle2 size={19} />;
  if (status === "running") return <LoaderCircle size={19} />;
  if (status === "failed") return <AlertCircle size={19} />;
  return <Circle size={19} />;
}

function statusLabel(status: string) {
  if (status === "needs_owner_input") return "WAITING FOR YOU";
  if (status === "executing" || status === "planning" || status === "queued") return "EXECUTING";
  return status.replaceAll("_", " ").toUpperCase();
}

export default async function ObjectiveDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const repository = await getOwnerReadRepository();
  const [objective, decisions] = await Promise.all([
    repository.getObjective(id),
    repository.listDecisions()
  ]);
  if (!objective) notFound();

  const pendingDecision = decisions.find(
    (decision) => decision.status === "pending" && decision.objectiveId === objective.id
  );

  return (
    <AppShell navigation={false}>
      <BackHeader title="Objective" href="/" />
      <DevelopmentBadge />
      <section className="page-content ufo-objective-detail">
        <div className="ufo-objective-detail-heading">
          <span>{statusLabel(objective.status)}</span>
          <small>{objective.priority} priority · {objective.riskLevel} risk</small>
        </div>
        <h1>{objective.title}</h1>
        <p className="lead">{objective.desiredOutcome}</p>

        <article className="ufo-outcome-card">
          <span className="ufo-outcome-label">OUTCOMES</span>
          {objective.progress.length ? (
            <ul className="ufo-outcome-list">
              {objective.progress.map((item) => (
                <li key={item.label} className={"ufo-outcome-" + item.status}>
                  {progressIcon(item.status)}
                  <span>{item.label}</span>
                  {item.verified ? <small>verified</small> : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="ufo-objective-queued">
              <LoaderCircle size={18} />
              <span>Objective accepted. Planning has not produced a verified outcome yet.</span>
            </div>
          )}
        </article>

        {pendingDecision ? (
          <article className="ufo-owner-decision">
            <span className="ufo-outcome-label">WAITING FOR YOU</span>
            <h2>{pendingDecision.title}</h2>
            <p>{pendingDecision.subtitle}</p>
            {pendingDecision.evidence?.length ? (
              <ul>
                {pendingDecision.evidence.map((item) => (
                  <li key={item}><CheckCircle2 size={16} />{item}</li>
                ))}
              </ul>
            ) : null}
            {pendingDecision.blastRadius ? (
              <div className="ufo-blast-radius">
                <span>Blast radius</span>
                <strong>{pendingDecision.blastRadius}</strong>
              </div>
            ) : null}
            <DecisionActions
              decisionId={pendingDecision.id}
              initialStatus={pendingDecision.status}
              approveLabel={pendingDecision.actionLabel ?? "Approve"}
            />
          </article>
        ) : null}

        {objective.constraints.length ? (
          <details className="ufo-objective-constraints">
            <summary>Objective boundaries</summary>
            <ul>{objective.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul>
          </details>
        ) : null}
      </section>
    </AppShell>
  );
}
