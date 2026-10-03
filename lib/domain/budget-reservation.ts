import { ControlPlaneError } from "@/lib/control-plane/errors";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";

export type BudgetReservationStatus = "reserved" | "consumed" | "released" | "expired";

export interface BudgetReservation {
  id: string;
  portfolioId: string;
  companyId: string;
  policyId: string;
  policyVersion: string;
  planHash: string;
  stepHash: string;
  amountCents: number;
  currency: string;
  status: BudgetReservationStatus;
  reservedAt: string;
  expiresAt: string;
  reservationHash: string;
}

export interface BudgetReservationStore {
  /**
   * Production implementations must reserve against the budget ledger
   * atomically so concurrent admissions cannot oversubscribe a budget.
   */
  reserve(reservation: BudgetReservation): Promise<{ created: boolean; reservation: BudgetReservation }>;
  consume(id: string, reservationHash: string, consumerId: string, consumedAt: string): Promise<void>;
  release(id: string, reservationHash: string, reason: string, releasedAt: string): Promise<void>;
  get(id: string): Promise<BudgetReservation | null>;
}

export function createBudgetReservation(
  input: Omit<BudgetReservation, "status" | "reservationHash"> & { status?: BudgetReservationStatus }
): BudgetReservation {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Budget reservation amount must be non-negative integer cents");
  }
  const reservedAt = Date.parse(input.reservedAt);
  const expiresAt = Date.parse(input.expiresAt);
  if (!Number.isFinite(reservedAt) || !Number.isFinite(expiresAt) || expiresAt <= reservedAt) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Budget reservation expiry must follow reservation time");
  }

  const base = {
    ...input,
    status: input.status ?? "reserved"
  };
  return Object.freeze({
    ...base,
    reservationHash: sha256Hex(base)
  });
}

export function assertBudgetReservation(input: {
  reservation: BudgetReservation;
  scope: TrustedExecutionScope;
  planHash: string;
  stepHash: string;
  minimumAmountCents: number;
  policyId?: string;
  now?: number;
}) {
  const { reservationHash, ...base } = input.reservation;
  if (sha256Hex(base) !== reservationHash) {
    throw new ControlPlaneError("FORBIDDEN", "Budget reservation integrity check failed");
  }
  const now = input.now ?? Date.now();
  if (
    input.reservation.status !== "reserved"
    || input.reservation.portfolioId !== input.scope.portfolioId
    || input.reservation.companyId !== input.scope.companyId
    || input.reservation.planHash !== input.planHash
    || input.reservation.stepHash !== input.stepHash
    || (input.policyId !== undefined && input.reservation.policyId !== input.policyId)
    || input.reservation.amountCents < input.minimumAmountCents
    || Date.parse(input.reservation.reservedAt) > now
    || Date.parse(input.reservation.expiresAt) <= now
  ) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Budget reservation is not valid for this work");
  }
  return input.reservation;
}
