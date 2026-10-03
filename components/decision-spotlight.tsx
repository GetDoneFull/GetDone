"use client";

import { BarChart3, Bug, CheckCircle2, ChevronRight, Megaphone, Server, Users } from "lucide-react";
import { DecisionActions } from "@/components/decision-actions";
import { DecisionCard } from "@/components/decision-card";
import type { Decision } from "@/lib/types";

const icons = {
  resource: Server,
  growth: BarChart3,
  incident: Bug,
  budget: Megaphone,
  outreach: Users
} as const;

function labelFor(decision: Decision) {
  if (decision.category === "resource") return "RESOURCE DECISION";
  if (decision.category === "growth") return "RELEASE DECISION";
  if (decision.category === "incident") return "INCIDENT DECISION";
  if (decision.category === "budget") return "BUDGET DECISION";
  return "OUTREACH DECISION";
}

export function DecisionSpotlight({ decisions }: { decisions: Decision[] }) {
  const pending = decisions.filter(
    (decision) => decision.status === "pending" && decision.priority !== "fyi"
  );
  const everythingElse = decisions.filter(
    (decision) => !pending.some((item) => item.id === decision.id)
  );

  return (
    <div className="ufo-decision-stack">
      {pending.length ? pending.map((decision) => {
        const Icon = icons[decision.category];
        return (
          <article key={decision.id} className="ufo-decision-card ufo-owner-judgment-card">
            <div className="ufo-decision-kicker">
              <span className={"ufo-decision-icon ufo-decision-icon-" + decision.category}>
                <Icon size={22} />
              </span>
              <strong>{labelFor(decision)}</strong>
              <small>{decision.age}</small>
            </div>

            <h2>{decision.title}</h2>
            <p>{decision.subtitle}</p>

            {decision.evidence?.length ? (
              <ul className="ufo-decision-evidence">
                {decision.evidence.map((item) => (
                  <li key={item}>
                    <CheckCircle2 size={15} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="ufo-decision-evidence">
                {decision.impact.map((item) => (
                  <li key={item}>
                    <CheckCircle2 size={15} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            )}

            {decision.blastRadius ? (
              <div className="ufo-decision-blast">
                <span>Blast radius</span>
                <strong>{decision.blastRadius}</strong>
              </div>
            ) : null}

            <DecisionActions
              decisionId={decision.id}
              initialStatus={decision.status}
              approveLabel={decision.actionLabel ?? "Approve"}
            />
          </article>
        );
      }) : (
        <div className="ufo-empty-attention">
          <CheckCircle2 size={24} />
          <strong>Nothing needs your judgment right now.</strong>
          <span>GetDone will surface the next owner-level decision here.</span>
        </div>
      )}

      <div className="ufo-else-label">EVERYTHING ELSE</div>
      <details className="ufo-else">
        <summary>
          <CheckCircle2 size={22} />
          <span>{everythingElse.length} resolved or informational items</span>
          <ChevronRight size={18} />
        </summary>
        <div className="ufo-more-decisions">
          {everythingElse.length
            ? everythingElse.map((decision) => <DecisionCard key={decision.id} decision={decision} />)
            : <div className="empty-state">The rest of the decision queue is clear.</div>}
        </div>
      </details>
    </div>
  );
}
