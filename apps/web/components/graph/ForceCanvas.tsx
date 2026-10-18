"use client";

// Force-directed drawing of the FalkorDB graph (react-force-graph-2d, as in the whatspoppin design system).
// Node objects are reused across polls, so existing nodes keep their position and only new ones animate in:
// while a build runs you watch the agents' writes arrive in the graph.
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";

import { cssVar, useTheme } from "@/components/theme/ThemeProvider";

import { LABEL_COLORS, type NetLink, type NetNode } from "./graphStyle";

export type { NetLink, NetNode };

const RADIUS: Record<string, number> = { Build: 9, Agent: 7, Lesson: 6.5, Check: 6.5, Config: 6.5, Spec: 7, Run: 4.5 };

type GNode = NodeObject<NetNode>;
type GLink = LinkObject<NetNode, NetLink>;

export function ForceCanvas({
  nodes,
  links,
  selected,
  highlight,
  onSelect,
  height = 560,
}: {
  nodes: NetNode[];
  links: NetLink[];
  selected: string | null;
  /** Nodes to ring (e.g. the lessons the graph chose for the coder). */
  highlight: Set<string>;
  onSelect: (id: string | null) => void;
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);
  // One stable Map for the component's life: node objects carry their simulated x/y, so reusing them keeps
  // existing nodes in place across polls.
  const [cache] = useState(() => new Map<string, GNode>());
  const fitted = useRef(false);
  const [width, setWidth] = useState(0);
  const { mode, theme } = useTheme();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    fgRef.current?.resumeAnimation();
  }, [mode, theme]);

  // More repulsion and longer links than the defaults, so labels of a dense build neighbourhood stay readable.
  const mounted = width > 0;
  useEffect(() => {
    const fg = fgRef.current;
    if (!mounted || !fg) return;
    (fg.d3Force("charge") as unknown as { strength?: (n: number) => void })?.strength?.(-140);
    (fg.d3Force("link") as unknown as { distance?: (n: number) => void })?.distance?.(38);
    fg.d3ReheatSimulation();
  }, [mounted]);

  const signature = useMemo(() => `${nodes.map((n) => n.id).join(",")}|${links.map((l) => `${l.source}>${l.target}:${l.type}`).join(",")}`, [nodes, links]);

  const graphData = useMemo(() => {
    const keep = new Set(nodes.map((n) => n.id));
    for (const id of [...cache.keys()]) if (!keep.has(id)) cache.delete(id);
    const out: GNode[] = nodes.map((n) => {
      const node = cache.get(n.id) ?? ({ id: n.id } as GNode);
      Object.assign(node, n);
      cache.set(n.id, node);
      return node;
    });
    return { nodes: out, links: links.map((l) => ({ ...l })) as GLink[] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // A different graph (another build, or the overview) gets one fresh zoom-to-fit.
  const firstId = nodes[0]?.id;
  useEffect(() => {
    fitted.current = false;
  }, [firstId]);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden"
      style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-panel)" }}
    >
      {width > 0 && (
        <ForceGraph2D<NetNode, NetLink>
          ref={fgRef}
          width={width}
          height={height}
          graphData={graphData}
          cooldownTicks={140}
          nodeRelSize={5}
          nodeLabel={(n) => `${n.label}: ${n.name}`}
          linkColor={() => cssVar("--border", "#243044")}
          linkWidth={1.2}
          linkDirectionalArrowLength={4}
          linkDirectionalArrowRelPos={0.92}
          linkDirectionalParticles={(l) => (l.type === "USED_LESSON" || l.type === "LEARNED_FROM" ? 2 : 0)}
          linkDirectionalParticleWidth={2.2}
          linkDirectionalParticleColor={() => LABEL_COLORS.Lesson}
          onNodeClick={(n) => onSelect(n.id === selected ? null : String(n.id))}
          onBackgroundClick={() => onSelect(null)}
          onEngineStop={() => {
            if (!fitted.current) {
              fitted.current = true;
              fgRef.current?.zoomToFit(600, 48);
            }
          }}
          nodeCanvasObject={(n, ctx, scale) => drawNode(n, ctx, scale, n.id === selected, highlight.has(String(n.id)))}
          nodePointerAreaPaint={(n, color, ctx) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, 10, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkCanvasObjectMode={() => "after"}
          linkCanvasObject={drawLinkLabel}
        />
      )}
    </div>
  );
}

function drawNode(n: GNode, ctx: CanvasRenderingContext2D, scale: number, isSelected: boolean, isHighlighted: boolean) {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const r = RADIUS[n.label] ?? 5.5;
  const color = LABEL_COLORS[n.label] ?? "#8a8f98";
  if (isHighlighted) {
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
    ctx.fillStyle = `${color}40`;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  if (isSelected) {
    ctx.lineWidth = 2.5 / scale;
    ctx.strokeStyle = cssVar("--text-primary", "#eef3fb");
    ctx.stroke();
  }
  const showLabel = scale > 1.1 || n.label !== "Run";
  if (!showLabel) return;
  const fontSize = Math.max(10.5 / scale, 2.5);
  ctx.font = `${n.label === "Build" ? "600 " : ""}${fontSize}px "Plus Jakarta Sans", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = cssVar("--text-primary", "#eef3fb");
  const text = n.name.length > 30 ? `${n.name.slice(0, 29)}…` : n.name;
  ctx.fillText(text, x, y + r + 2);
}

function drawLinkLabel(l: GLink, ctx: CanvasRenderingContext2D, scale: number) {
  if (scale < 1.6) return;
  const s = l.source as GNode;
  const t = l.target as GNode;
  if (typeof s !== "object" || typeof t !== "object") return;
  const x = ((s.x ?? 0) + (t.x ?? 0)) / 2;
  const y = ((s.y ?? 0) + (t.y ?? 0)) / 2;
  const fontSize = Math.max(8 / scale, 1.8);
  ctx.font = `${fontSize}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = cssVar("--text-tertiary", "#717f9c");
  ctx.fillText(String(l.type), x, y);
}
