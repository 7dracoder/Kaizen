import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";

import { NavTabs } from "@/components/NavTabs";
import { AccountWidgetClient } from "@/components/AccountWidgetClient";

const EXAMPLES = [
  "USB-C powered I2C temperature sensor with a status LED",
  "I2C humidity sensor board, USB-C powered",
  "RC low-pass filter with test points",
  "Dual LED driver from a 5V header",
];

export default function Landing() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line-soft bg-raised px-6">
        <div className="flex items-center gap-5">
          <span className="text-[15px] font-semibold text-ink">Kaizen</span>
          <NavTabs />
        </div>
        <AccountWidgetClient />
      </header>

      <main className="dot-grid flex flex-1 flex-col items-center justify-center px-6 pb-24">
        <div className="w-full max-w-[560px]">
          <form action="/graph" className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line-soft bg-raised py-2 pl-4 pr-2">
            <label htmlFor="q" className="sr-only">Describe a board</label>
            <input
              id="q"
              name="q"
              required
              minLength={10}
              autoFocus
              autoComplete="off"
              placeholder="Describe a circuit board"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none"
            />
            <button
              type="submit"
              aria-label="Build it and watch the graph"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-contrast hover:opacity-90"
            >
              <ArrowRight size={15} weight="bold" aria-hidden />
            </button>
          </form>
          <p className="mt-2 px-1 text-[12px] leading-relaxed text-faint">
            the agents design it, a hidden checker grades it, and FalkorDB decides what they remember. you watch the
            graph fill in while it builds.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <Link
                key={ex}
                href={`/graph?q=${encodeURIComponent(ex)}`}
                className="rounded-full border border-line-soft bg-raised px-3 py-1 text-[12px] text-dim hover:border-accent hover:text-accent"
              >
                {ex}
              </Link>
            ))}
          </div>
        </div>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft bg-raised px-6 py-3 text-[12px] text-faint">
        <span>PCB agents with one shared FalkorDB memory</span>
        <span className="flex gap-4">
          <Link href="/graph" className="hover:text-accent">the live graph</Link>
          <Link href="/memory" className="hover:text-accent">why a board turned out the way it did</Link>
        </span>
      </footer>
    </div>
  );
}
