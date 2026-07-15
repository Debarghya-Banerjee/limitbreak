import type { Adapter, Usage } from "../types.js";

/**
 * Gemini generateContent via fetch.
 *
 * Efficiency mechanics:
 * - Stable prefix goes in systemInstruction; Gemini's implicit caching
 *   discounts repeated prefixes automatically on 2.5 models.
 * - `responseSchema` + JSON mime type constrains output shape.
 */
export const geminiAdapter: Adapter = async (req, cfg) => {
  const baseUrl =
    cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens,
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.stop?.length && { stopSequences: req.stop }),
      ...(req.schema && {
        responseMimeType: "application/json",
        responseSchema: req.schema,
      }),
    },
  };

  const res = await fetch(
    `${baseUrl}/models/${req.model}:generateContent?key=${cfg.apiKey ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`gemini ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  };

  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ??
    "";
  const usage: Usage = {
    inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    cacheReadTokens: data.usageMetadata?.cachedContentTokenCount ?? 0,
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
