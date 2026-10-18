// Model router: resolves an agent role to a model tier via HarnessConfig,
// maps the tier to a concrete model id (single place to swap model ids), and makes the call.
// Agents never talk to a provider directly. Any OpenAI-compatible chat-completions endpoint works:
//   AI_BASE_URL (default https://openrouter.ai/api/v1) and AI_API_KEY (falls back to OPENROUTER_API_KEY).
import type { AgentName, HarnessConfig, ModelTier } from "@kaizen/types";
import { Client as LangSmith } from "langsmith";
import { traceable } from "langsmith/traceable";

// MODEL_CHEAP/MODEL_STRONG in .env override these; the literals here are
// only the fallback if the env vars aren't set.
const MODEL_IDS: Record<ModelTier, string> = {
  cheap: process.env.MODEL_CHEAP || "openai/gpt-4o-mini",
  strong: process.env.MODEL_STRONG || "anthropic/claude-sonnet-4.5",
};

// Every call is capped (always set max_tokens). A whole board of
// TSX fits comfortably; callers can raise it per call.
const DEFAULT_MAX_TOKENS = 4000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** OpenAI-style structured-output schema, e.g. critic/prompt.ts's CRITIC_SCHEMA. */
export interface JsonSchema {
  name: string;
  strict?: boolean;
  schema: unknown;
}

export interface CallModelInput {
  role: AgentName;
  messages: ChatMessage[];
  config: HarnessConfig;
  maxTokens?: number;
  /** Requests JSON-schema structured output (OpenAI-style response_format) instead of free text. */
  schema?: JsonSchema;
}

export interface RouterCallResult {
  content: string;
  model: string;
  tier: ModelTier;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

const langsmith = process.env.LANGSMITH_TRACING === "true" ? new LangSmith() : undefined;

export const aiBaseUrl = () => (process.env.AI_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
export const aiApiKey = () => process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY;
const isOpenRouter = () => aiBaseUrl().includes("openrouter.ai");

async function openRouterCall(model: string, messages: ChatMessage[], maxTokens: number, schema?: JsonSchema) {
  const apiKey = aiApiKey();
  if (!apiKey) throw new Error("AI_API_KEY is not set (no model provider configured); see .env.example");

  const res = await fetch(`${aiBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(isOpenRouter() && { "X-Title": "Kaizen" }),
      "Content-Type": "application/json",
    },
    // On OpenRouter, usage.include returns the real cost in the response instead of us maintaining a per-model
    // price table. Other OpenAI-compatible providers report tokens only (cost_usd is then left empty).
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      ...(isOpenRouter() && { usage: { include: true } }),
      ...(schema && { response_format: { type: "json_schema", json_schema: schema } }),
    }),
  });

  if (!res.ok) {
    throw new Error(`model request failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  return (await res.json()) as {
    model?: string;
    choices: { message: { content: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
    };
  };
}

export async function callModel({
  role,
  messages,
  config,
  maxTokens = DEFAULT_MAX_TOKENS,
  schema,
}: CallModelInput): Promise<RouterCallResult> {
  const tier = config.routing[role];
  const model = MODEL_IDS[tier];

  // Traced when LANGSMITH_TRACING=true (see green-check.ts for the same
  // pattern); falls back to a plain call otherwise so tracing setup never
  // blocks the router.
  const call = langsmith
    ? traceable((m: string, msgs: ChatMessage[], max: number, s?: JsonSchema) => openRouterCall(m, msgs, max, s), {
        name: `router:${role}`,
        run_type: "llm",
        client: langsmith,
        project_name: process.env.LANGSMITH_PROJECT,
      })
    : openRouterCall;

  const data = await call(model, messages, maxTokens, schema);

  return {
    content: data.choices[0].message.content,
    model: data.model ?? model,
    tier,
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
    totalTokens: data.usage?.total_tokens,
    costUsd: data.usage?.cost,
  };
}

export type CompleteFn = ((system: string, user: string, schema: JsonSchema) => Promise<unknown>) & {
  /** Usage from the most recent call, for callers that need to log its cost (e.g. critic/meta runs). */
  lastUsage?: RouterCallResult;
};

/**
 * The critic and planner both take a `complete(system, user, schema) -> Promise<unknown>`
 * dependency (see CriticDeps/PlannerDeps) so they stay model-agnostic. Role and config
 * pick the tier the same way callModel does; bind them once per caller.
 *
 * The returned function also carries `.lastUsage` (model/tokens/cost from the most recent
 * call) as a property, since CriticDeps/PlannerDeps only pass the parsed JSON back — callers
 * that need to log the call's cost (e.g. as a `runs` document) read it from there afterward.
 */
export function createComplete(role: AgentName, config: HarnessConfig): CompleteFn {
  const complete: CompleteFn = async (system, user, schema) => {
    const result = await callModel({
      role,
      config,
      schema,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    complete.lastUsage = result;
    try {
      return JSON.parse(result.content);
    } catch (cause) {
      throw new Error(`${role} model returned non-JSON content: ${result.content.slice(0, 200)}`, { cause });
    }
  };
  return complete;
}
