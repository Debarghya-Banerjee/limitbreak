import type { Task, Tier, ProviderConfig } from "./types.js";

/**
 * Cheapest tier empirically adequate per task kind. The point of routing:
 * most calls in a real app are classify/extract and never need a frontier model.
 */
const TASK_TIER: Record<Task, Tier> = {
  classify: "fast",
  extract: "fast",
  summarize: "fast",
  rewrite: "balanced",
  generate: "balanced",
  reason: "max",
};

const DEFAULT_MODELS: Record<string, Record<Tier, string>> = {
  anthropic: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-4-6",
    max: "claude-opus-4-7",
  },
  openai: {
    fast: "gpt-4o-mini",
    balanced: "gpt-4o",
    max: "o3",
  },
  gemini: {
    fast: "gemini-2.5-flash-lite",
    balanced: "gemini-2.5-flash",
    max: "gemini-2.5-pro",
  },
};

// $/MTok [input, output]. An OPTIONAL convenience seed for cost estimates, not a
// maintained source of truth — limitbreak governs tokens, not dollars, so this is
// never on the critical path. Models absent here report cost as n/a (not $0);
// extend or correct via config.json "pricing" or LimitbreakConfig.pricing.
export const DEFAULT_PRICING: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-4-7": [5, 25],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
  "o3": [2, 8],
  "gemini-2.5-flash-lite": [0.1, 0.4],
  "gemini-2.5-flash": [0.3, 2.5],
  "gemini-2.5-pro": [1.25, 10],
};

export function resolveTier(tier?: Tier, task?: Task): Tier {
  if (tier) return tier;
  if (task) return TASK_TIER[task];
  return "balanced";
}

export function resolveModel(
  provider: string,
  cfg: ProviderConfig,
  tier: Tier,
): string {
  const fromCfg = cfg.models?.[tier];
  if (fromCfg) return fromCfg;
  const defaults = DEFAULT_MODELS[provider];
  if (defaults) return defaults[tier];
  throw new Error(
    `No model configured for provider "${provider}" tier "${tier}". ` +
      `Set providers.${provider}.models.${tier}.`,
  );
}

export function estimateCostUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  pricing: Record<string, [number, number]>,
): number | undefined {
  const p = pricing[model];
  if (!p) return undefined;
  const [inPrice, outPrice] = p;
  // Cached reads bill at ~10% of input price on Anthropic/OpenAI/Gemini.
  const freshIn = Math.max(0, inputTokens - cacheReadTokens);
  return (
    (freshIn * inPrice + cacheReadTokens * inPrice * 0.1 + outputTokens * outPrice) /
    1_000_000
  );
}
