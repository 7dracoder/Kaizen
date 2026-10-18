"use client";

import Link from "next/link";

import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";
import { useCurrentBoard } from "@/lib/currentBoard";

export type Tab = "board" | "harness" | "graph" | "memory" | "system";

const TABS: { id: Tab; label: string; href: (board: string | null) => string }[] = [
  { id: "board", label: "Board", href: (b) => (b ? `/boards/${encodeURIComponent(b)}` : "/board") },
  { id: "harness", label: "Harness", href: (b) => (b ? `/harness?board=${encodeURIComponent(b)}` : "/harness") },
  { id: "graph", label: "Graph", href: (b) => (b ? `/graph?board=${encodeURIComponent(b)}` : "/graph") },
  { id: "memory", label: "Memory", href: (b) => (b ? `/memory?board=${encodeURIComponent(b)}` : "/memory") },
  { id: "system", label: "System", href: () => "/system" },
];

/** Top-level page tabs, shared by every header so order and styling agree. Links carry the current board. */
export function NavTabs({ active }: { active?: Tab }) {
  const board = useCurrentBoard();
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
            href={tab.href(board)}
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
