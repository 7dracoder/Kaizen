# Kaizen

**Circuit boards from plain English, designed by AI agents that share one graph memory.**

Kaizen turns a sentence like *"USB-C powered temperature sensor with a status LED"* into a routed, manufacturable printed circuit board (Gerbers, BOM, KiCad project, 3D model). A team of agents plans, writes, checks and repairs the board. Everything they do (every attempt, failure, lesson, reusable subcircuit, config change and handoff) lands in one [FalkorDB](https://www.falkordb.com) graph. The next board starts from what the last one learned, and every decision can be traced back to its source.

![Landing page](docs/screenshots/landing.png)

## The problem

Most first-run PCBs get respun for the same handful of mistakes: missing I2C pull-ups, no decoupling capacitor next to a chip, an unconnected pin, a routing error. LLMs can write board code, but on their own they make those mistakes again and again. They have no memory of what failed last time, no way to check their own work against the requirements, and no record of *why* they made a choice.

## What Kaizen does

1. **Design**: a planner splits the spec into subcircuits, and a coder writes [tscircuit](https://tscircuit.com) code for each one. Deterministic tools compile it, autoroute it and run design-rule checks.
2. **Check**: a hidden checker grades the board against requirements the agents never see (connectivity, pull-ups, decoupling, DRC).
3. **Repair and learn**: a critic diagnoses each failure, proposes the smallest fix, and writes a **lesson** into the graph. Verified blocks become reusable **subcircuits**.
4. **Remember**: the next build retrieves the relevant lessons and subcircuits by vector search over the graph. Every run records which lessons and which harness version shaped it.
5. **Evolve**: a meta-agent proposes changes to the system's own rules and routing. A gate keeps a change only if the next batch scores better, and the full lineage stays in the graph.

| Board (real 3D view of a 20-part board built through the work queue) | Memory graph and the "why" trace of one build |
|---|---|
| ![3D board](docs/screenshots/board-3d.png) | ![Memory graph](docs/screenshots/memory-graph.png) |

> The 3D board above was built by the long-horizon pipeline with **stand-in planner and coder** (`npm run finale -- --stub`, no model calls). Every screenshot is of the real running app on local FalkorDB.

## Architecture

```mermaid
flowchart LR
  subgraph Web["apps/web (Next.js)"]
    UI[Board / Harness / Memory / System pages]
    API[API routes]
  end
  subgraph Worker["apps/worker (Node)"]
    P[Planner] --> C[Coder] --> K[Checker + DRC] --> CR[Critic]
    CR --> C
    K --> A[Assembler]
    K --> M[Meta-agent] --> G[Config gate]
    Q[Durable work queue]
  end
  subgraph F["FalkorDB"]
    S[(Shared graph "kaizen": memory, runs, configs, queue, requests)]
    U[(One graph per user: conversation history)]
  end
  UI --> API -->|read + Request nodes| S
  API -->|pub/sub wake-up| Worker
  API --> U
  Worker <-->|Cypher, vector search, atomic claims| S
  Worker --> U
  C & CR & P & M --> LLM[OpenAI-compatible model API]
  Worker -.optional.-> V[Voyage embeddings + rerank]
```

### The graph

```
(:Config)-[:CHILD_OF]->(:Config)               harness lineage            (procedural memory)
(:Config)-[:HAS_RULE]->(:Rule)
(:Run)-[:OF_BUILD]->(:Build)-[:FOR_SPEC]->(:Spec)                         (episodic memory)
(:Run)-[:UNDER]->(:Config)    (:Run)-[:BY_AGENT]->(:Agent)    (:Run)-[:FAILED_CHECK]->(:Check)
(:Run)-[:USED_LESSON]->(:Lesson)-[:LEARNED_FROM]->(:Build)                (semantic memory, vector-indexed)
(:Run)-[:REUSED]->(:Subcircuit)                                           (vector-indexed)
(:WorkItem)-[:PART_OF]->(:Build)  (:WorkItem)-[:DEPENDS_ON]->(:WorkItem)  (:WorkItem)-[:CLAIMED_BY]->(:Worker)
(:Agent)-[:HANDS_OFF_TO]->(:Agent)
(:User)-[:REQUESTED]->(:Request)-[:PRODUCED]->(:Build)
(:User)-[:HAS_ACCOUNT]->(:Account)  (:User)-[:HAS_SESSION]->(:Session)
per-user graph kaizen_user_<hash>:  (:Episode)-[:NEXT]->(:Episode)-[:ABOUT]->(:Build)
```

### How each core part works

- **Graph store** (`packages/graph`): records are FalkorDB nodes. Scalar fields are node properties, so Cypher can filter, index and traverse them. Nested data (failures, Circuit JSON) is stored as JSON on the node. Every write re-derives the node's relationships, so the graph never drifts from the records. A `_rev` counter makes read-modify-write updates compare-and-set.
- **Coordination**: FalkorDB runs each query atomically. Claiming the next ready work item ("pending, no unfinished dependency, lowest step") is one Cypher query, and so is claiming a spec request. Twelve concurrent workers racing for six steps never double-claim, and that's covered by a test. Heartbeats plus process checks make a killed worker's step resumable. Pub/sub wakes the worker the moment a request arrives.
- **Memory**: lessons, subcircuits and failure summaries are embedded and stored with FalkorDB vector indexes. Embeddings come from Voyage when a key is set. Otherwise a free local hashing embedder keeps memory working with lower recall. Vectors from different embedders are never compared.
- **Per-user memory**: each signed-in user gets an isolated graph holding their prompt and result history, kept across sessions. Deleting the account deletes that graph.
- **Traceability**: `/memory` runs graph traversals that answer *"why did this build turn out this way?"*: build ← runs → agent, harness version → rules, lessons used → where each lesson was learned, failed checks → how many other builds failed them.
- **Self-improvement**: the gate (`apps/worker/src/harness/gate.ts`) scores a proposed config on a fresh batch, spec by spec. It keeps the change, rolls it back, or rejects it if it weakens a check.

## Tech stack

TypeScript on Node 22 · FalkorDB 4.18 (graph + vector + pub/sub) · Next.js 16, React 19, Tailwind 4, React Three Fiber · tscircuit (pinned) · Auth.js with a FalkorDB adapter · OpenAI-compatible model API (OpenRouter by default) · Voyage AI (optional) · LangSmith (optional)

## Folder layout

```
apps/web/          Next.js app: pages, API routes, 3D board scene, FalkorDB auth adapter
apps/worker/       agents (planner, coder, critic, meta), tools (compile, DRC, metrics, router),
                   harness (config, gate, memory, queue, requests), long-horizon pipeline, exporters
packages/graph/    FalkorDB client, record collections, schema and relationships, vector search,
                   per-user graphs, provenance traversals
packages/types/    shared contracts (HarnessConfig, RunResult, ...)
checks/            hidden checker (never shown to agents)
specs/             public spec text      parts/  whitelisted parts
scripts/           setup, worker, finale, evolve, ablation, local FalkorDB launcher, key checker
```

## Run it locally

Needs Node 22.13+ and `redis-server` (macOS: `brew install redis`). The FalkorDB module is downloaded automatically during install. Docker works too: `docker run -p 6379:6379 falkordb/falkordb`.

```bash
npm install                                   # also builds packages/graph and packages/types
cp .env.example .env && cp .env.example apps/web/.env.local
npm run db                                    # terminal 1: FalkorDB on :6379, data in .data/
npm run setup                                 # once: indexes, vector indexes, config v0, specs, agents
npm run dev                                   # terminal 2: http://localhost:3000
npm run worker                                # terminal 3: serves builds from the web app
```

With no keys at all you can still run the stand-in 20-part board through the queue and open it in 3D, the memory graph, the system and harness views, and every test. Real board design needs `AI_API_KEY`.

```bash
npm run finale -- --stub --reset              # free: planner + coder stand-ins, real checks, real queue
npm run green                                 # one real call per configured service
```

## API keys

| Key | Priority | Unlocks | Without it |
|---|---|---|---|
| `FALKORDB_URL` | required | everything (defaults to local `redis://127.0.0.1:6379`) | nothing works; pages show "Disconnected" |
| `AI_API_KEY` (+ `AI_BASE_URL`) | 1 | the agents: designing boards from the web or CLI | builds fail with a clear message |
| `VOYAGE_API_KEY` | 2 | semantic embeddings and reranking for memory | local hashing embedder (works, lower recall) |
| `AUTH_SECRET` + `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` or `AUTH_RESEND_KEY` | 3 | sign-in, per-user memory graphs and build limits | anonymous mode, no personal history |
| `LANGSMITH_API_KEY` | 4 | traces of every model call | no tracing |

## API routes

| Route | Returns |
|---|---|
| `GET /api/health` | FalkorDB connection, record counts, user-graph count, active embedder |
| `GET /api/graph` | memory summary: node/relationship counts, lessons ranked by passing uses, most-failed checks, config lineage |
| `GET /api/graph?board_id=` | provenance trace of one build (nodes + edges) |
| `GET /api/history` | the signed-in user's conversation history from their own graph |
| `GET/POST /api/spec`, `GET /api/spec/:id` | spec list, submit a build (`{ text }` or `{ spec_id }`), request status |
| `GET /api/runs?since=&board_id=` | run feed |
| `GET /api/boards`, `GET /api/boards/:id` | board index, one board adapted for the 3D scene |
| `GET /api/boards/:id/deliverables[?file=]` | manifest and files (Gerbers, BOM, KiCad, ...) |
| `GET /api/harness` | every config version and the current one |
| `GET /api/memory` | active lessons and the subcircuit library |
| `GET /api/queue?board_id=` | work items with stale-worker detection |

## Tests

```bash
npm test             # everything below
npm run test:graph   # FalkorDB integration: store, relationships, vector search, per-user isolation,
                     # concurrent queue and request claims, lessons (needs `npm run db`; uses a throwaway graph)
npm run test:checks  # hidden checker     npm run test:gate     config gate
npm run test:critic  npm run test:planner  npm run test:assembler  npm run test:export  npm run test:meta
npm run typecheck && npm run smoke
```

## Roadmap

- Feed each user's history back into the planner, so follow-ups like "make it smaller" refine the previous board
- Graph algorithms as agent tools (PageRank over lessons, community detection over failure patterns)
- Read-only Cypher tool access for the critic and meta-agent
- Hosted FalkorDB with one graph per organisation, plus team-shared libraries
- More parts, 4-layer boards, SPICE checks in the loop

## Security

- Secrets live only in `.env` / `apps/web/.env.local` (gitignored). The app never sends keys to the browser, and all model and database calls run server-side.
- The web app writes only spec requests and accounts. Design state has one writer, the worker.
- With sign-in configured, building requires a session, with per-user and global caps on queued builds (they protect the model budget).
- **Without sign-in the app is anonymous, so anyone who can reach it can queue builds that spend your model budget.** Don't expose it publicly without auth.
- Local FalkorDB binds to 127.0.0.1 with no password. Any hosted instance must have a password and TLS.
- Hidden checks never reach the agents, the graph or the model.
