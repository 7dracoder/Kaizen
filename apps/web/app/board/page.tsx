import { KaizenDashboard } from "@/components/KaizenDashboard";
import { AccountWidget } from "@/components/AccountWidget";
import { auth, authConfigured } from "@/lib/auth";

// Reads the session cookie: must render per-request, not prerender statically.
export const dynamic = "force-dynamic";

export default async function Page() {
  const session = authConfigured() ? await auth() : null;
  return <KaizenDashboard accountSlot={<AccountWidget />} signedIn={!authConfigured() || Boolean(session?.user)} />;
}
