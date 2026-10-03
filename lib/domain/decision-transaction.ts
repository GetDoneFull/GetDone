import type { ControlPlaneTransaction, ControlPlaneTransactionManager } from "@/lib/domain/control-plane-transaction";
import type {
  DecisionAuthorityStore,
  DecisionResumeRequestStore
} from "@/lib/domain/decision-service";

export interface DecisionStores {
  decisions: DecisionAuthorityStore;
  /**
   * Orchestration Decisions may emit a durable resume request in the same
   * authoritative transaction as the Decision resolution.
   */
  resumeRequests?: DecisionResumeRequestStore;
}

export type DecisionTransaction = ControlPlaneTransaction<DecisionStores>;
export type DecisionTransactionManager = ControlPlaneTransactionManager<DecisionStores>;
