import { MemoryGraph } from "@/components/memory/MemoryGraph";
import { AccountWidget } from "@/components/AccountWidget";

export const metadata = { title: "Kaizen · memory" };
// Reads the session cookie via AccountWidget: must render per-request, not prerender statically.
export const dynamic = "force-dynamic";

export default function MemoryPage() {
  return <MemoryGraph accountSlot={<AccountWidget />} />;
}
