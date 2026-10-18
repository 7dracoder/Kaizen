// The web app's only design-adjacent write path: inserting spec requests.
//
// A request is a Request node in the shared graph, linked (User)-[:REQUESTED]->(Request). The worker
// (`npm run worker`) is woken through FalkorDB pub/sub, claims the request atomically and does all the
// design-state writing. Server-side only.
import { appendEpisode, col, publish, type Collection } from "@kaizen/graph";

export interface SpecRequestDoc {
  /** A spec from the specs collection, or… */
  spec_id?: string;
  /** …free text (graded by generic checks built from the board, never by hidden checks). */
  text?: string;
  status: "queued" | "running" | "done" | "failed";
  created_at: string;
  source: "web";
  /** The signed-in user who submitted this. Absent when the deployment has no auth configured (anonymous mode). */
  user_id?: string;
  [key: string]: unknown;
}

export const REQUESTS_CHANNEL = "kaizen:requests";

/** Requests are always accepted when FalkorDB is reachable; the route reports a 503 if it isn't. */
export const requestsConfigured = (): boolean => true;

export function requestsCollection(): Collection<SpecRequestDoc> {
  return col.requests as unknown as Collection<SpecRequestDoc>;
}

/** Wakes the worker right away (it also polls, so a missed message only costs a few seconds). */
export async function notifyWorker(requestId: string) {
  await publish(REQUESTS_CHANNEL, requestId).catch(() => {});
}

/** Records the prompt in the user's own memory graph (persistent conversation history). */
export async function rememberPrompt(userId: string, requestId: string, text: string) {
  await appendEpisode(userId, { role: "user", text, request_id: requestId }).catch(() => {});
}

/** One signed-in user queued/running past this many requests gets refused: keeps one user from starving everyone else. */
export const MAX_PENDING = 3;
/** Total queued/running requests across every user past this many and new submissions are refused outright: the
 * real backstop for one worker on a shared model budget. A small multiple of MAX_PENDING, not per-user × N users. */
export const MAX_PENDING_GLOBAL = 15;
