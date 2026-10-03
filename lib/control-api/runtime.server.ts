import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  CONTROL_API_SURFACE_VERSION,
  type ControlApiApplicationAdapter,
  type ControlApiHealth
} from "@/lib/control-api/contracts";
import { createPostgresControlApiAdapter } from "@/lib/control-api/postgres-runtime.server";

class UnavailableControlApiAdapter implements ControlApiApplicationAdapter {
  private unavailable(): never {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Control API adapter is not connected to authoritative auth/persistence"
    );
  }

  async authenticate(): Promise<never> { return this.unavailable(); }
  async health(): Promise<ControlApiHealth> {
    return {
      service: "getdone-control-api",
      surfaceVersion: CONTROL_API_SURFACE_VERSION,
      status: "unavailable",
      authConnected: false,
      persistenceConnected: false,
      aiGatewayAdapterInstalled: false,
      durableJobStoreConnected: false
    };
  }
  async beginStepUp(): Promise<never> { return this.unavailable(); }
  async verifyStepUp(): Promise<never> { return this.unavailable(); }
  async logout(): Promise<never> { return this.unavailable(); }
  async revokeOtherSessions(): Promise<never> { return this.unavailable(); }
  async submitOwnerIntent(): Promise<never> { return this.unavailable(); }
  async submitObjectives(): Promise<never> { return this.unavailable(); }
  async listObjectives(): Promise<never> { return this.unavailable(); }
  async getObjective(): Promise<never> { return this.unavailable(); }
  async listDecisions(): Promise<never> { return this.unavailable(); }
  async getDecision(): Promise<never> { return this.unavailable(); }
  async mutateDecision(): Promise<never> { return this.unavailable(); }
  async listResources(): Promise<never> { return this.unavailable(); }
  async getResource(): Promise<never> { return this.unavailable(); }
  async discoverResource(): Promise<never> { return this.unavailable(); }
  async listResourceEnrollments(): Promise<never> { return this.unavailable(); }
  async getResourceEnrollment(): Promise<never> { return this.unavailable(); }
  async startResourceEnrollment(): Promise<never> { return this.unavailable(); }
  async advanceResourceEnrollment(): Promise<never> { return this.unavailable(); }
  async listJobs(): Promise<never> { return this.unavailable(); }
  async getJob(): Promise<never> { return this.unavailable(); }
  async getJobResult(): Promise<never> { return this.unavailable(); }
  async listVerifications(): Promise<never> { return this.unavailable(); }
  async getVerification(): Promise<never> { return this.unavailable(); }
}

const unavailableAdapter = new UnavailableControlApiAdapter();
let installedAdapter: ControlApiApplicationAdapter | null = null;

export function installControlApiAdapter(adapter: ControlApiApplicationAdapter) {
  installedAdapter = adapter;
}

export function resetControlApiAdapter() {
  installedAdapter = null;
}

export function getControlApiAdapter() {
  if (installedAdapter) return installedAdapter;

  const runtime = process.env.GETDONE_RUNTIME_ENV;
  if (
    (runtime === "staging" || runtime === "production")
    && process.env.DATABASE_URL?.trim()
  ) {
    installedAdapter = createPostgresControlApiAdapter(process.env);
    return installedAdapter;
  }

  return unavailableAdapter;
}
