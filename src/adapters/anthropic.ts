import type { Adapter, Usage } from "../types.js";

/**
 * Anthropic Messages API via fetch (no SDK dependency).
 *
 * Efficiency mechanics:
 * - `cache_control: ephemeral` on the system block → the stable prefix is
 *   written to the prompt cache once and read at ~10% price afterwards.
 * - Structured output via a forced tool call — the schema constrains the
 *   output, so the model can't ramble past the requested shape.
 */
export const anthropicAdapter: Adapter = async (req, cfg) => {
  const baseUrl = cfg.baseUrl ?? "https://api.anthropic.com";
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxOutputTokens,
    system: [
      {
        type: "text",
        text: req.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: req.user }],
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop_sequences = req.stop;
  if (req.schema) {
    body.tools = [
      {
        name: "emit",
        description: "Emit the result in the required shape.",
        input_schema: req.schema,
      },
    ];
    body.tool_choice = { type: "tool", name: "emit" };
  }

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string; input?: unknown }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  const usage: Usage = {
    inputTokens:
      data.usage.input_tokens +
      (data.usage.cache_read_input_tokens ?? 0) +
      (data.usage.cache_creation_input_tokens ?? 0),
    outputTokens: data.usage.output_tokens,
    cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: data.usage.cache_creation_input_tokens ?? 0,
  };

  if (req.schema) {
    const tool = data.content.find((c) => c.type === "tool_use");
    return {
      text: JSON.stringify(tool?.input ?? null),
      json: tool?.input,
      usage,
    };
  }
  const text = data.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  return { text, usage };
};
