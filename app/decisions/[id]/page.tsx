import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { BackHeader } from "@/components/back-header";
import { DecisionActions } from "@/components/decision-actions";
import { DevelopmentBadge } from "@/components/dev-badge";
import { PriorityPill } from "@/components/status";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function DecisionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repository = await getOwnerReadRepository();
  const decision = await repository.getDecision(id);
  if (!decision) notFound();

  return (
    <AppShell navigation={false}>
      <BackHeader title="Decision" href="/decisions" />
      <DevelopmentBadge />
      <section className="page-content decision-detail-page">
        <div className="decision-detail-heading"><PriorityPill priority={decision.priority} /><span>{decision.age}</span></div>
        <h1>{decision.title}</h1>
        <p className="lead">{decision.subtitle}</p>
        <article className="detail-card"><span>Why this is here</span><p>{decision.rationale}</p></article>
        <article className="detail-card">
          <span>Verified context</span>
          <ul>{(decision.evidence?.length ? decision.evidence : decision.impact).map((item) => <li key={item}>{item}</li>)}</ul>
        </article>
        {decision.blastRadius ? (
          <article className="detail-card"><span>Blast radius</span><p>{decision.blastRadius}</p></article>
        ) : null}
        <DecisionActions
          decisionId={decision.id}
          initialStatus={decision.status}
          approveLabel={decision.actionLabel ?? "Approve"}
        />
      </section>
    </AppShell>
  );
}
