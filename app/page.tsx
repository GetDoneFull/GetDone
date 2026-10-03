import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { HomeDashboard } from "@/components/home-dashboard";
import { getOwnerReadRepository } from "@/lib/data/runtime-repository.server";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const repository = await getOwnerReadRepository();
  const objectives = await repository.listObjectives();

  return (
    <AppShell>
      <AppHeader />
      <HomeDashboard objectives={[...objectives]} />
    </AppShell>
  );
}
