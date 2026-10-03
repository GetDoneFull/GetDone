import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  ConfirmedPreferenceRule,
  DecisionPreferenceObservation,
  LearnedRuleSuggestion,
  PreferenceLearningStore,
  PreferenceSuggestionDisposition,
  PreferenceSuggestionResolution
} from "@/lib/domain/preference-learning";
import type {
  PostgresTransactionalDatabase,
  SqlQueryable
} from "@/lib/persistence/postgres/client";

export class PostgresPreferenceLearningStore implements PreferenceLearningStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async appendObservation(observation: DecisionPreferenceObservation) {
    const inserted = await this.db.query(
      `INSERT INTO preference_decision_observations
        (id,portfolio_id,company_id,decision_id,capability,pattern_hash,observed_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (portfolio_id,company_id,decision_id,capability) DO NOTHING`,
      [
        observation.id,
        observation.portfolioId,
        observation.companyId,
        observation.decisionId,
        observation.pattern.capability,
        observation.patternHash,
        observation.observedAt,
        JSON.stringify(observation)
      ]
    );
    if (inserted.rowCount === 1) return;

    const existing = await this.db.query<{ payload: DecisionPreferenceObservation }>(
      `SELECT payload
         FROM preference_decision_observations
        WHERE portfolio_id=$1
          AND company_id=$2
          AND decision_id=$3
          AND capability=$4`,
      [
        observation.portfolioId,
        observation.companyId,
        observation.decisionId,
        observation.pattern.capability
      ]
    );
    if (existing.rows[0]?.payload.observationHash === observation.observationHash) return;
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Preference observation conflicts with existing evidence"
    );
  }

  async listObservations(
    portfolioId: string,
    companyId: string,
    patternHash: string
  ) {
    const result = await this.db.query<{ payload: DecisionPreferenceObservation }>(
      `SELECT payload
         FROM preference_decision_observations
        WHERE portfolio_id=$1 AND company_id=$2 AND pattern_hash=$3
        ORDER BY observed_at,id`,
      [portfolioId, companyId, patternHash]
    );
    return result.rows.map((row) => row.payload);
  }

  async putSuggestion(suggestion: LearnedRuleSuggestion) {
    await this.db.query(
      `INSERT INTO learned_rule_suggestions
        (id,portfolio_id,company_id,capability,pattern_hash,status,times_observed,created_at,payload)
       VALUES($1,$2,$3,$4,$5,'suggested',$6,$7,$8::jsonb)
       ON CONFLICT (id) DO UPDATE
         SET times_observed=EXCLUDED.times_observed,
             payload=EXCLUDED.payload
       WHERE learned_rule_suggestions.status='suggested'`,
      [
        suggestion.id,
        suggestion.portfolioId,
        suggestion.companyId,
        suggestion.capability,
        suggestion.patternHash,
        suggestion.timesObserved,
        suggestion.createdAt,
        JSON.stringify(suggestion)
      ]
    );
  }

  async getSuggestion(id: string) {
    const result = await this.db.query<{ payload: LearnedRuleSuggestion }>(
      `SELECT payload
         FROM learned_rule_suggestions
        WHERE id=$1 AND status='suggested'`,
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }

  async listSuggestions(portfolioId: string, companyId: string) {
    const result = await this.db.query<{ payload: LearnedRuleSuggestion }>(
      `SELECT payload
         FROM learned_rule_suggestions
        WHERE portfolio_id=$1 AND company_id=$2 AND status='suggested'
        ORDER BY created_at,id`,
      [portfolioId, companyId]
    );
    return result.rows.map((row) => row.payload);
  }

  async resolveSuggestion(input: {
    suggestion: LearnedRuleSuggestion;
    action: PreferenceSuggestionResolution;
    actorId: string;
    resolvedAt: string;
    confirmedRule?: ConfirmedPreferenceRule;
    disposition?: PreferenceSuggestionDisposition;
  }) {
    await this.db.transaction(async (client) => {
      const locked = await client.query<{ status: string; payload: LearnedRuleSuggestion }>(
        `SELECT status,payload
           FROM learned_rule_suggestions
          WHERE id=$1 AND portfolio_id=$2 AND company_id=$3
          FOR UPDATE`,
        [
          input.suggestion.id,
          input.suggestion.portfolioId,
          input.suggestion.companyId
        ]
      );
      const row = locked.rows[0];
      if (!row) throw new ControlPlaneError("NOT_FOUND", "Preference suggestion was not found");
      if (row.status !== "suggested") {
        throw new ControlPlaneError("CONFLICT", "Preference suggestion was already resolved");
      }
      if (row.payload.suggestionHash !== input.suggestion.suggestionHash) {
        throw new ControlPlaneError("FORBIDDEN", "Preference suggestion changed before resolution");
      }

      const status = input.action === "allow"
        ? "confirmed"
        : input.action === "never-suggest"
          ? "never-suggest"
          : "keep-asking";
      await client.query(
        `UPDATE learned_rule_suggestions
            SET status=$2,resolved_by=$3,resolved_at=$4,resolution_payload=$5::jsonb
          WHERE id=$1`,
        [
          input.suggestion.id,
          status,
          input.actorId,
          input.resolvedAt,
          JSON.stringify(input.confirmedRule ?? input.disposition ?? null)
        ]
      );

      if (input.action === "allow") {
        if (!input.confirmedRule) {
          throw new ControlPlaneError("VALIDATION_FAILED", "Confirmed rule is required for Allow");
        }
        const insertedRule = await client.query(
          `INSERT INTO confirmed_preference_rules
            (id,portfolio_id,company_id,capability,pattern_hash,confirmed_by,confirmed_at,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [
            input.confirmedRule.id,
            input.confirmedRule.portfolioId,
            input.confirmedRule.companyId,
            input.confirmedRule.capability,
            input.confirmedRule.patternHash,
            input.confirmedRule.confirmedBy,
            input.confirmedRule.confirmedAt,
            JSON.stringify(input.confirmedRule)
          ]
        );
        if (insertedRule.rowCount !== 1) {
          const existingRule = await client.query<{ payload: ConfirmedPreferenceRule }>(
            "SELECT payload FROM confirmed_preference_rules WHERE id=$1 FOR SHARE",
            [input.confirmedRule.id]
          );
          if (existingRule.rows[0]?.payload.ruleHash !== input.confirmedRule.ruleHash) {
            throw new ControlPlaneError(
              "IDEMPOTENCY_CONFLICT",
              "Confirmed preference rule ID already exists with different content"
            );
          }
        }
      }
    });
  }

  async listActiveRules(portfolioId: string, companyId: string, capability: string) {
    const result = await this.db.query<{ payload: ConfirmedPreferenceRule }>(
      `SELECT payload
         FROM confirmed_preference_rules
        WHERE portfolio_id=$1
          AND company_id=$2
          AND capability=$3
          AND revoked_at IS NULL
        ORDER BY confirmed_at DESC,id`,
      [portfolioId, companyId, capability]
    );
    return result.rows.map((row) => row.payload);
  }
}

export class ScopedPostgresPreferenceLearningStore extends PostgresPreferenceLearningStore {
  constructor(db: PostgresTransactionalDatabase | SqlQueryable) {
    super(db as PostgresTransactionalDatabase);
  }
}
