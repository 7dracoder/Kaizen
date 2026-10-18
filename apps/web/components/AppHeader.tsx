import type { ReactNode } from "react";
import Link from "next/link";

import { NavTabs, type Tab } from "@/components/NavTabs";

/** The one top bar every page uses, so switching tabs never moves or resizes it. */
export function AppHeader({ active, children }: { active?: Tab; children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-6 border-b border-line-soft bg-raised px-6">
      <div className="flex items-center gap-5">
        <Link href="/" className="text-[15px] font-semibold text-ink hover:text-accent">
          Kaizen
        </Link>
        <NavTabs active={active} />
      </div>
      <div className="flex min-w-0 items-center gap-5 whitespace-nowrap text-[12px]">{children}</div>
    </header>
  );
}

/** Shared content column for the dashboard pages: same width on every tab. */
export const PAGE_COLUMN = "mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-6";
