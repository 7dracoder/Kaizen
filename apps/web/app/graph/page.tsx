import { GraphExplorer } from "@/components/graph/GraphExplorer";
import { AccountWidget } from "@/components/AccountWidget";

export const metadata = { title: "Kaizen · graph" };
// Reads the session cookie via AccountWidget: must render per-request, not prerender statically.
export const dynamic = "force-dynamic";

export default function GraphPage() {
  return <GraphExplorer accountSlot={<AccountWidget />} />;
}
