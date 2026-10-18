"use client";

// The live graph: watch the agents read and write FalkorDB while a board is built, and see exactly which graph
// paths decided what the coder was given. Polls every 2 s; new nodes animate in, existing ones keep their place.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowsClockwise, Graph, Lightning, MagnifyingGlass, Play } from "@phosphor-icons/react";

import { AppHeader, PAGE_COLUMN } from "@/components/AppHeader";
import { getJson, usePolling } from "@/lib/usePolling";
import { LABEL_COLORS, type NetLink, type NetNode } from "./graphStyle";

const ForceCanvas = dynamic(() => import("./ForceCanvas").then((m) => m.ForceCanvas), { ssr: false });

interface Network {
  nodes: NetNode[];
  links: NetLink[];
  queries: { purpose: string; cypher: string; rows: number; ms: number }[];
  error?: string;
}
interface Pick {
  id: string;
  why: string;
  via: "graph" | "vector";
}
interface MemoryRecord {
  risky_checks: { check: string; times: number }[];
  picks: { lessons: Pick[]; subcircuits: Pick[] };
  queries: { purpose: string; cypher: string; rows: number; ms: number }[];
}
interface RunRow {
  _id: string;
  board_id: string;
  stage: string;
  passed?: boolean;
  ts: string;
  failures?: { check: string; detail: string }[];
  memory?: MemoryRecord;
  critique?: { lessons_saved?: string[] };
}
interface LessonRow {
  _id: string;
  pattern: string;
  fix: string;
}

const POLL_MS = 2000;
const OVERVIEW = "__overview__";

const panel = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-panel)" } as const;

function Panel({ title, icon, note, children }: { title: string; icon?: ReactNode; note?: string; children: ReactNode }) {
  return (
    <section className="p-4" style={panel}>
      <div className="flex items-baseline gap-2">
        {icon ? <span className="self-center text-accent">{icon}</span> : null}
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
        {note ? <span className="text-[11px] text-faint">{note}</span> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Cypher({ q }: { q: { purpose: string; cypher: string; rows: number; ms: number } }) {
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-[12px]">
        <span className="text-dim">{q.purpose}</span>
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {q.rows} row{q.rows === 1 ? "" : "s"}
          {q.ms ? ` · ${q.ms} ms` : ""}
        </span>
      </div>
      <pre className="slim-scroll overflow-x-auto whitespace-pre-wrap rounded-[var(--radius-control)] bg-void/60 p-2 font-mono text-[10.5px] leading-relaxed text-dim" style={{ border: "1px solid var(--border)" }}>
        {q.cypher.replace(/\n\s+/g, "\n  ")}
      </pre>
    </li>
  );
}

export function GraphExplorer({ accountSlot, initialPrompt }: { accountSlot?: ReactNode; initialPrompt?: string } = {}) {
  const [target, setTarget] = useState<string>(OVERVIEW);
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt ?? "USB-C powered I2C temperature sensor breakout with a status LED");
  const [buildNote, setBuildNote] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);

  // Newest builds first, from the run feed (the memory record is written before the first attempt, so a build
  // shows up here the moment the graph is consulted).
  const { data: feed } = usePolling(() => getJson<{ runs?: RunRow[] }>("/api/runs?limit=120"), POLL_MS);
  const builds = useMemo(() => {
    // Cache copies never consulted the graph, so following one would show an empty decision panel.
    const cached = new Set((feed?.runs ?? []).filter((r) => r.stage === "cache_hit").map((r) => r.board_id));
    const seen: string[] = [];
    for (const r of feed?.runs ?? []) if (!seen.includes(r.board_id) && !cached.has(r.board_id)) seen.push(r.board_id);
    return seen.slice(0, 30);
  }, [feed]);

  // A build started from this page: follow it as soon as the worker gives it a board id.
  useEffect(() => {
    if (!pendingRequest) return;
    const t = setInterval(async () => {
      const r = await getJson<{ board_id?: string; status?: string; error?: string }>(`/api/spec/${pendingRequest}`);
      if (r?.board_id) {
        setTarget(r.board_id);
        setFollow(false);
      }
      if (r?.status === "done" || r?.status === "failed") {
        setBuildNote(r.status === "done" ? "Build finished: the graph below is its final state." : `Build failed: ${r.error ?? "unknown error"}`);
        setPendingRequest(null);
      } else if (r?.status) setBuildNote(`Build ${r.status}…`);
    }, 1500);
    return () => clearInterval(t);
  }, [pendingRequest]);

  const current = follow && !pendingRequest && builds[0] ? builds[0] : target;
  const isOverview = current === OVERVIEW;

  const fetchNetwork = useCallback(
    () => getJson<Network>(isOverview ? "/api/graph/network?limit=500" : `/api/graph/network?board_id=${encodeURIComponent(current)}`),
    [current, isOverview],
  );
  const { data: net } = usePolling(fetchNetwork, POLL_MS);
  const fetchRuns = useCallback(
    () => (isOverview ? Promise.resolve(null) : getJson<{ runs?: RunRow[] }>(`/api/runs?board_id=${encodeURIComponent(current)}&limit=80`)),
    [current, isOverview],
  );
  const { data: buildRuns } = usePolling(fetchRuns, POLL_MS);
  const { data: lessonsData } = usePolling(() => getJson<{ lessons?: LessonRow[] }>("/api/memory"), 5000);

  const memoryRecord = (buildRuns?.runs ?? []).find((r) => r.stage === "memory")?.memory ?? null;
  const isCacheHit = (buildRuns?.runs ?? []).some((r) => r.stage === "cache_hit");
  const lessonById = useMemo(() => new Map((lessonsData?.lessons ?? []).map((l) => [l._id, l])), [lessonsData]);
  const savedLessons = useMemo(() => [...new Set((buildRuns?.runs ?? []).flatMap((r) => r.critique?.lessons_saved ?? []))], [buildRuns]);

  // Ring the lessons/subcircuits the graph handed to the coder, so the decision is visible on the canvas too.
  const highlight = useMemo(() => {
    const ids = new Set([...(memoryRecord?.picks.lessons ?? []), ...(memoryRecord?.picks.subcircuits ?? [])].map((p) => p.id));
    const out = new Set<string>();
    for (const n of net?.nodes ?? []) if (ids.has(String(n.props._id ?? ""))) out.add(n.id);
    return out;
  }, [memoryRecord, net]);

  const selectedNode = (net?.nodes ?? []).find((n) => n.id === selected) ?? null;
  const labelsPresent = useMemo(() => [...new Set((net?.nodes ?? []).map((n) => n.label))], [net]);

  const startBuild = async () => {
    setBuildNote("Submitting…");
    const res = await fetch("/api/spec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: prompt }) });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.request_id) {
      setBuildNote(json?.error ?? "The worker did not accept the request");
      return;
    }
    setPendingRequest(json.request_id);
    setBuildNote("Queued: the worker picks it up through FalkorDB pub/sub…");
  };

  // Arriving from the landing prompt (/graph?q=…): start that build once.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !initialPrompt || initialPrompt.trim().length < 10) return;
    autoStarted.current = true;
    // Drop ?q= so a reload doesn't queue the same build again.
    window.history.replaceState(null, "", "/graph");
    void startBuild();
  }, [initialPrompt]);

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader active="graph">{accountSlot}</AppHeader>
      <div className={`${PAGE_COLUMN} pt-5`}>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex min-w-[320px] flex-1 items-center gap-2 px-3 py-2" style={panel}>
          <MagnifyingGlass size={16} className="text-faint" aria-hidden />
          <label htmlFor="graph-prompt" className="sr-only">Describe a board to build</label>
          <input
            id="graph-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint focus:outline-none"
            placeholder="Describe a board, then watch the graph work"
          />
          <button
            type="button"
            onClick={startBuild}
            disabled={Boolean(pendingRequest) || prompt.trim().length < 10}
            className="flex items-center gap-1.5 rounded-[var(--radius-control)] bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-contrast disabled:opacity-50"
          >
            <Play size={13} weight="fill" aria-hidden /> Build and watch
          </button>
        </div>
        <label className="flex items-center gap-2 px-3 py-2 text-[12px] text-dim" style={panel}>
          View
          <select
            value={follow && !pendingRequest ? "__follow__" : target}
            onChange={(e) => {
              if (e.target.value === "__follow__") setFollow(true);
              else {
                setFollow(false);
                setTarget(e.target.value);
              }
              setSelected(null);
            }}
            className="rounded-[var(--radius-control)] bg-transparent font-mono text-[12px] text-ink focus:outline-none"
          >
            <option value="__follow__">Follow the latest build</option>
            <option value={OVERVIEW}>Whole memory</option>
            {builds.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
        {buildNote ? <span className="text-[12px] text-dim">{buildNote}</span> : null}
      </div>

      <main className="grid flex-1 gap-4 pb-8 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-3">
          {net?.error ? <p className="text-[13px] text-bad">{net.error}</p> : null}
          <ForceCanvas nodes={net?.nodes ?? []} links={net?.links ?? []} selected={selected} highlight={highlight} onSelect={setSelected} height={600} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-dim">
            <span className="flex items-center gap-1.5 font-mono text-faint">
              <Graph size={13} aria-hidden /> {isOverview ? "whole memory" : current} · {net?.nodes.length ?? 0} nodes · {net?.links.length ?? 0} relationships
            </span>
            {labelsPresent.map((l) => (
              <span key={l} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: LABEL_COLORS[l] ?? "#8a8f98" }} aria-hidden />
                {l}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ boxShadow: `0 0 0 3px ${LABEL_COLORS.Lesson}55`, background: LABEL_COLORS.Lesson }} aria-hidden />
              ringed = chosen by the graph for the coder
            </span>
          </div>
          {selectedNode ? (
            <Panel title={`${selectedNode.label}: ${selectedNode.name}`} note="node properties in FalkorDB">
              <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
                {Object.entries(selectedNode.props).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-mono text-faint">{k}</dt>
                    <dd className="break-words font-mono text-dim">{Array.isArray(v) ? v.join(", ") || "[]" : String(v)}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          ) : null}
        </div>

        <aside className="space-y-4">
          {isOverview ? (
            <Panel title="The whole memory" icon={<Graph size={15} weight="bold" />} note="every agent reads and writes this graph">
              <p className="text-[12px] leading-relaxed text-dim">
                Pick a build (or start one above) to see where the coder&apos;s context came from. Runs point at the agent that made them,
                the harness version they ran under, the checks they failed, and the lessons they used; lessons point back at the build
                that taught them.
              </p>
            </Panel>
          ) : (
            <Panel title="How the graph decided" icon={<Lightning size={15} weight="bold" />} note="before the coder wrote a line">
              {memoryRecord ? (
                <div className="space-y-4 text-[12px]">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">Risky checks for this spec</div>
                    {memoryRecord.risky_checks.length ? (
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {memoryRecord.risky_checks.map((r) => (
                          <li key={r.check} className="rounded-full px-2 py-0.5 font-mono text-[11px]" style={{ background: `${LABEL_COLORS.Check}22`, color: LABEL_COLORS.Check }}>
                            {r.check} ×{r.times}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-faint">None yet: the graph had no failures to learn from.</p>
                    )}
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">Lessons handed to the coder</div>
                    {memoryRecord.picks.lessons.length ? (
                      <ol className="mt-1.5 space-y-2">
                        {memoryRecord.picks.lessons.map((p) => (
                          <li key={p.id} className="rounded-[var(--radius-control)] p-2" style={{ border: "1px solid var(--border)" }}>
                            <div className="flex items-center gap-2">
                              <span className="rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold" style={p.via === "graph" ? { background: `${LABEL_COLORS.Lesson}26`, color: LABEL_COLORS.Lesson } : { background: "var(--border)", color: "var(--text-secondary)" }}>
                                {p.via === "graph" ? "graph path" : "vector"}
                              </span>
                              <span className="text-ink">{lessonById.get(p.id)?.pattern ?? p.id}</span>
                            </div>
                            <p className="mt-1 text-faint">{p.why}</p>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="mt-1 text-faint">No lessons in memory yet. This build starts from scratch; whatever the critic learns from it is saved for the next one.</p>
                    )}
                  </div>
                  {memoryRecord.picks.subcircuits.length ? (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">Subcircuits offered for reuse</div>
                      <ul className="mt-1.5 space-y-1">
                        {memoryRecord.picks.subcircuits.map((p) => (
                          <li key={p.id} className="text-dim">
                            <span className="font-mono text-ink">{p.id}</span> · {p.why}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {savedLessons.length ? (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">Lessons this build wrote back</div>
                      <ul className="mt-1.5 space-y-1">
                        {savedLessons.map((id) => (
                          <li key={id} className="text-dim">{lessonById.get(id)?.pattern ?? id}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-faint">Cypher the agent ran</div>
                    <ul className="mt-1.5 space-y-3">
                      {memoryRecord.queries.map((q, i) => (
                        <Cypher key={i} q={q} />
                      ))}
                    </ul>
                  </div>
                </div>
              ) : !buildRuns ? (
                <p className="text-[12px] text-faint">Reading this build&apos;s memory record from FalkorDB…</p>
              ) : isCacheHit ? (
                <p className="text-[12px] text-faint">
                  Same wording as a board that already passed under this harness version, so the stored design was re-graded
                  against today&apos;s hidden checks and served without model calls. Pick the original build in View to see how the
                  graph decided its context.
                </p>
              ) : (
                <p className="text-[12px] text-faint">
                  No memory record for this build. Builds made before graph-driven context, and stand-in runs, don&apos;t consult the graph.
                </p>
              )}
            </Panel>
          )}

          <Panel title="Queries behind this view" icon={<ArrowsClockwise size={15} weight="bold" />} note={`re-run every ${POLL_MS / 1000}s`}>
            <ul className="space-y-3">
              {(net?.queries ?? []).map((q, i) => (
                <Cypher key={i} q={q} />
              ))}
            </ul>
          </Panel>
        </aside>
      </main>
      </div>
    </div>
  );
}
