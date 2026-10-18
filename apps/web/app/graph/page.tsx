import { GraphExplorer } from "@/components/graph/GraphExplorer";
import { AccountWidget } from "@/components/AccountWidget";

export const metadata = { title: "Kaizen · graph" };
// Reads the session cookie via AccountWidget: must render per-request, not prerender statically.
export const dynamic = "force-dynamic";

export default async function GraphPage({ searchParams }: PageProps<"/graph">) {
  const { q } = await searchParams;
  return <GraphExplorer accountSlot={<AccountWidget />} initialPrompt={typeof q === "string" ? q : undefined} />;
}
