"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";

import { AppHeader, PAGE_COLUMN } from "@/components/AppHeader";
import { ago, type BoardSummary } from "@/lib/live";
import { getJson, usePolling } from "@/lib/usePolling";

interface Summary {
  labels: { label: string; n: number }[];
  relationships: { type: string; n: number }[];
  lessons: { id: string; pattern: string; used: number; passed: number }[];
  checks: { check: string; builds: number }[];
  lineage: { version: number; parent: number | null; verdict: string; rules: number }[];
  error?: string;
}
interface TraceNode { id: string; type: string; label: string; detail?: Record<string, unknown> }
interface Trace { nodes: TraceNode[]; edges: { from: string; to: string; type: string }[]; error?: string }
interface Episode { id: string; role: "user" | "kaizen"; text: string; at: string; board_id?: string; passed?: boolean }

const POLL_MS = 4000;

// Columns of the trace, left to right: who acted → what they did → under which procedure → what it drew on.
const COLUMN: Record<string, number> = { agent: 0, run: 1, build: 2, config: 3, rule: 4, lesson: 3, check: 4, subcircuit: 4 };
const TINT: Record<string, string> = {
  agent: "#4ec9e0", run: "#9aa7b8", build: "#7c8aa0", config: "#c39bff", rule: "#c39bff",
  lesson: "#6fd39a", check: "#ff7a7a", subcircuit: "#f0c060",
};

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="py-5">
      <div className="flex items-baseline gap-3">
        <h2 className="text-[13px] text-ink">{title}</h2>
        {note ? <span className="text-[11px] text-faint">{note}</span> : null}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** A layered drawing of one build's provenance graph, plus the same content as a list for screen readers. */
function TraceView({ trace }: { trace: Trace }) {
  const layout = useMemo(() => {
    const cols: TraceNode[][] = [[], [], [], [], []];
    for (const n of trace.nodes) cols[COLUMN[n.type] ?? 4].push(n);
    const pos = new Map<string, { x: number; y: number }>();
    const W = 900, colW = W / cols.length, rowH = 26;
    cols.forEach((col, c) => col.forEach((n, r) => pos.set(n.id, { x: c * colW + 8, y: 18 + r * rowH })));
    const height = Math.max(...cols.map((c) => c.length), 1) * rowH + 24;
    return { pos, height, colW };
  }, [trace]);

  if (!trace.nodes.length) return <p className="text-[12px] text-faint">No runs recorded for this build yet.</p>;
  return (
    <>
      <div className="overflow-x-auto rounded-md border border-line-soft bg-raised">
        <svg viewBox={`0 0 900 ${layout.height}`} className="w-full min-w-[720px] text-ink" role="img" aria-label="Provenance graph of this build">
          {trace.edges.map((e, i) => {
            const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
            if (!a || !b) return null;
            const ax = a.x + Math.min(layout.colW - 20, 160), ay = a.y - 4;
            return <line key={i} x1={ax} y1={ay} x2={b.x} y2={b.y - 4} stroke="currentColor" strokeOpacity={0.18} />;
          })}
          {trace.nodes.map((n) => {
            const p = layout.pos.get(n.id)!;
            const label = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
            return (
              <g key={n.id}>
                <circle cx={p.x + 4} cy={p.y - 4} r={3.5} fill={TINT[n.type] ?? "#9aa7b8"} />
                <text x={p.x + 12} y={p.y} fontSize={11} fill="currentColor">
                  <title>{`${n.type}: ${n.label}`}</title>
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-faint">
        {Object.entries(TINT).map(([t, c]) => (
          <span key={t} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: c }} aria-hidden />
            {t}
          </span>
        ))}
      </div>
      <ul className="sr-only">
        {trace.edges.map((e, i) => (
          <li key={i}>{`${trace.nodes.find((n) => n.id === e.from)?.label} ${e.type} ${trace.nodes.find((n) => n.id === e.to)?.label}`}</li>
        ))}
      </ul>
    </>
  );
}

export function MemoryGraph({ accountSlot }: { accountSlot?: ReactNode } = {}) {
  const { data: summary } = usePolling(() => getJson<Summary>("/api/graph"), POLL_MS);
  const { data: boards } = usePolling(() => getJson<{ boards?: BoardSummary[] }>("/api/boards"), POLL_MS);
  const { data: history } = usePolling(() => getJson<{ episodes?: Episode[]; anonymous?: boolean; error?: string }>("/api/history"), POLL_MS);
  const builds = useMemo(() => {
    const seen = new Set<string>();
    return (boards?.boards ?? []).filter((b) => (seen.has(b.board_id) ? false : (seen.add(b.board_id), true)));
  }, [boards]);
  const [picked, setPicked] = useState<string | null>(null);
  // Default to the newest build the agents actually designed; cache copies have an almost empty trace.
  const selected = picked ?? (builds.find((b) => !b.cached_from) ?? builds[0])?.board_id ?? null;
  const [trace, setTrace] = useState<Trace | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    getJson<Trace>(`/api/graph?board_id=${encodeURIComponent(selected)}`).then((t) => {
      if (!cancelled) setTrace(t);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const nodes = summary?.labels?.reduce((s, l) => s + l.n, 0) ?? 0;
  const rels = summary?.relationships?.reduce((s, r) => s + r.n, 0) ?? 0;

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader active="memory">{accountSlot}</AppHeader>
      <div className={PAGE_COLUMN}>

      <main className="flex-1 divide-y divide-hair">
        <Section title="Memory graph" note={summary?.error ? summary.error : `FalkorDB · ${nodes} nodes · ${rels} relationships`}>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
            {(summary?.labels ?? []).map((l) => (
              <span key={l.label}><span className="text-faint">{l.label} </span><span className="font-mono text-dim">{l.n}</span></span>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]">
            {(summary?.relationships ?? []).map((r) => (
              <span key={r.type}><span className="font-mono text-faint">{r.type} </span><span className="font-mono text-dim">{r.n}</span></span>
            ))}
          </div>
        </Section>

        <Section title="Why did this build turn out this way?" note="traversal: build ← runs → agent, harness version, rules, lessons used, failed checks">
          <label className="mb-3 flex items-center gap-2 text-[12px] text-dim">
            Build
            <select
              value={selected ?? ""}
              onChange={(e) => setPicked(e.target.value)}
              className="rounded-sm border border-line bg-raised px-2 py-1 font-mono text-[12px] text-ink"
            >
              {builds.map((b) => (
                <option key={b.board_id} value={b.board_id}>
                  {b.board_id} {b.spec_id ? `· ${b.spec_id}` : ""} {b.passed === true ? "· passed" : b.passed === false ? "· failed" : ""} {b.cached_from ? "· cached" : ""}
                </option>
              ))}
            </select>
            {selected ? <Link href={`/boards/${encodeURIComponent(selected)}`} className="text-accent hover:underline">open board →</Link> : null}
          </label>
          {trace?.error ? <p className="text-[12px] text-bad">{trace.error}</p> : trace ? <TraceView trace={trace} /> : <p className="text-[12px] text-faint">No builds yet.</p>}
        </Section>

        <div className="grid gap-x-8 sm:grid-cols-2">
          <Section title="Lessons that earned their place" note="passing attempts that had the lesson in context">
            {summary?.lessons?.length ? (
              <ol className="space-y-1.5 text-[12px]">
                {summary.lessons.map((l) => (
                  <li key={l.id} className="flex gap-3">
                    <span className="w-14 shrink-0 font-mono text-dim">{l.passed}/{l.used}</span>
                    <span className="text-ink">{l.pattern}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-[12px] text-faint">No lessons yet: the critic writes one when a board fails a check.</p>}
          </Section>
          <Section title="Most-failed checks" note="distinct builds that failed each">
            {summary?.checks?.length ? (
              <ol className="space-y-1.5 text-[12px]">
                {summary.checks.map((c) => (
                  <li key={c.check} className="flex gap-3"><span className="w-14 shrink-0 font-mono text-dim">{c.builds}</span><span className="text-ink">{c.check}</span></li>
                ))}
              </ol>
            ) : <p className="text-[12px] text-faint">No failed checks recorded.</p>}
          </Section>
        </div>

        <div className="grid gap-x-8 sm:grid-cols-2">
          <Section title="Harness lineage" note="(:Config)-[:CHILD_OF]->(:Config)">
            <ol className="space-y-1 font-mono text-[12px]">
              {(summary?.lineage ?? []).map((c) => (
                <li key={c.version} className="text-dim">
                  v{c.version}{c.parent !== null ? ` ← v${c.parent}` : ""} · <span className={c.verdict === "kept" ? "text-good" : c.verdict === "pending" ? "text-warn" : "text-bad"}>{c.verdict}</span> · {c.rules} rule{c.rules === 1 ? "" : "s"}
                </li>
              ))}
            </ol>
          </Section>
          <Section title="Your history" note="your own memory graph, kept across sessions">
            {history?.anonymous ? (
              <p className="text-[12px] text-faint">Sign-in isn&apos;t configured on this deployment, so builds are anonymous and no personal history is kept.</p>
            ) : history?.error ? (
              <p className="text-[12px] text-faint">{history.error}</p>
            ) : history?.episodes?.length ? (
              <ol className="space-y-1.5 text-[12px]">
                {history.episodes.map((e) => (
                  <li key={e.id} className="flex gap-3">
                    <span className="w-14 shrink-0 text-faint">{ago(e.at)}</span>
                    <span className={e.role === "user" ? "text-ink" : e.passed ? "text-good" : "text-dim"}>{e.role === "user" ? "You: " : "Kaizen: "}{e.text}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-[12px] text-faint">Nothing yet. Build a board and it shows up here.</p>}
          </Section>
        </div>
      </main>
      <footer className="border-t border-hair py-6 text-[12px] text-faint">Read-only view of the Kaizen graph · polling every {POLL_MS / 1000}s</footer>
      </div>
    </div>
  );
}
