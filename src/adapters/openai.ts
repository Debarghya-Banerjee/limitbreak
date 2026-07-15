import type { Adapter, Usage } from "../types.js";

/**
 * OpenAI Chat Completions via fetch. Works with any OpenAI-compatible
 * endpoint (Ollama, OpenRouter, vLLM, LM Studio) through `baseUrl`.
 *
 * Efficiency mechanics:
 * - System (stable prefix) first: OpenAI's automatic prompt caching keys on
 *   the byte prefix, so identical leading content gets discounted.
 * - `response_format: json_schema` constrains output shape and length.
 */
export const openaiAdapter: Adapter = async (req, cfg) => {
  const baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const body: Record<string, unknown> = {
    model: req.model,
    max_completion_tokens: req.maxOutputTokens,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop = req.stop;
  if (req.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "result", strict: true, schema: req.schema },
    };
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey ?? ""}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`openai ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices: Array<{ message: { content: string | null } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };

  const text = data.choices[0]?.message.content ?? "";
  const usage: Usage = {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: 0,
  };

  if (req.schema) {
    try {
      return { text, json: JSON.parse(text), usage };
    } catch {
      return { text, usage };
    }
  }
  return { text, usage };
};
