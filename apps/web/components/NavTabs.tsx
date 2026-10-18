import Link from "next/link";

import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";

type Tab = "board" | "harness" | "graph" | "memory" | "system";

const TABS: { id: Tab; label: string; href: string }[] = [
  { id: "board", label: "Board", href: "/board" },
  { id: "harness", label: "Harness", href: "/harness" },
  { id: "graph", label: "Graph", href: "/graph" },
  { id: "memory", label: "Memory", href: "/memory" },
  { id: "system", label: "System", href: "/system" },
];

/** Top-level page tabs, shared by every header so order and styling agree. */
export function NavTabs({ active }: { active?: Tab }) {
  return (
    <div className="flex items-center gap-4">
    <nav className="flex items-center gap-1 rounded-[var(--radius-control)] border border-line-soft bg-raised p-0.5 text-[13px]">
      {TABS.map((tab) =>
        tab.id === active ? (
          <span
            key={tab.id}
            aria-current="page"
            className="rounded-[7px] bg-accent/15 px-3 py-1 font-medium text-accent"
          >
            {tab.label}
          </span>
        ) : (
          <Link
            key={tab.id}
            href={tab.href}
            className="rounded-[7px] px-3 py-1 text-dim hover:bg-accent/10 hover:text-ink"
          >
            {tab.label}
          </Link>
        ),
      )}
    </nav>
    <ThemeSwitcher />
    </div>
  );
}
