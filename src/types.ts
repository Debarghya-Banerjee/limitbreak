export type Tier = "fast" | "balanced" | "max";

export type Task =
  | "classify"
  | "extract"
  | "summarize"
  | "rewrite"
  | "generate"
  | "reason";

export type ProviderName = "anthropic" | "openai" | "gemini" | (string & {});

export interface ProviderConfig {
  apiKey?: string;
  /** Override for OpenAI-compatible endpoints (Ollama, OpenRouter, vLLM...). */
  baseUrl?: string;
  /** Override the default model per tier. */
  models?: Partial<Record<Tier, string>>;
  /** Wire protocol. Defaults by provider name; set "openai" for compatibles. */
  protocol?: "anthropic" | "openai" | "gemini";
}

export interface ContextItem {
  text: string;
  /** Higher survives budget cuts first. Default 0. */
  priority?: number;
  /** Never dropped; placed in the stable (cacheable) prefix. */
  pinned?: boolean;
  /** Label used in the packed prompt, e.g. "file:src/app.ts". */
  label?: string;
}

export interface Budget {
  /** Estimated cap for packed context tokens. */
  maxInputTokens?: number;
  /** Default output cap applied to every call. */
  maxOutputTokens?: number;
}

export interface LimitbreakConfig {
  providers: Partial<Record<ProviderName, ProviderConfig>>;
  /** Default provider when a request does not specify one. */
  defaultProvider?: ProviderName;
  budget?: Budget;
  /** Path for the JSONL usage log. Set false to disable telemetry. */
  telemetry?: string | false;
  /**
   * URL of a running `limitbreak up` daemon. When set, calls consult its
   * headroom level and downgrade task-routed tiers under pressure. Fails open.
   */
  governor?: { url: string };
  /** $/MTok price overrides keyed by model id: { "model": [input, output] } */
  pricing?: Record<string, [number, number]>;
}

export interface CompletionRequest {
  prompt: string;
  provider?: ProviderName;
  /** Explicit capability tier; wins over `task`. */
  tier?: Tier;
  /** Task kind — routed to the cheapest tier known to handle it well. */
  task?: Task;
  /** Exact model id; wins over tier/task routing. */
  model?: string;
  /** Stable instructions — placed first and marked cacheable. */
  system?: string;
  /** Supporting material, packed under the input budget. */
  context?: (string | ContextItem)[];
  /** JSON Schema. Forces structured output; result.json is the parsed value. */
  schema?: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  stop?: string[];
  /** Ask for a minimal, no-preamble answer. Default true. */
  terse?: boolean;
  /** Tag recorded in telemetry for per-feature reporting. */
  tag?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CompletionResult {
  text: string;
  /** Parsed structured output when `schema` was provided. */
  json?: unknown;
  model: string;
  provider: ProviderName;
  usage: Usage;
  /** Estimated from the pricing table; undefined for unknown models. */
  costUSD?: number;
  /** Tokens the context packer dropped to stay under budget (estimate). */
  droppedContextTokens: number;
}

/** Normalized request handed to a provider adapter. */
export interface AdapterRequest {
  model: string;
  /** Stable, cache-eligible prefix (system + pinned context). */
  system: string;
  /** Volatile user content (packed context + prompt). */
  user: string;
  schema?: Record<string, unknown>;
  maxOutputTokens: number;
  temperature?: number;
  stop?: string[];
}

export interface AdapterResponse {
  text: string;
  json?: unknown;
  usage: Usage;
}

export type Adapter = (
  req: AdapterRequest,
  cfg: ProviderConfig,
) => Promise<AdapterResponse>;
