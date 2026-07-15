import { estimateTokens } from "./context.js";

export type Intensity = "off" | "light" | "standard" | "aggressive";

/** Target size (estimated tokens) per compressed block, by intensity. */
const BUDGETS: Record<Exclude<Intensity, "off">, number> = {
  light: 1500,
  standard: 600,
  aggressive: 250,
};

/** Target token budget for an intensity level; null means "don't compress". */
export function compressionBudget(intensity: Intensity): number | null {
  return intensity === "off" ? null : BUDGETS[intensity];
}

export interface CompressOutcome {
  text: string;
  changed: boolean;
  originalTokens: number;
  finalTokens: number;
  storeId?: string;
}

/**
 * Content-aware, reversible compression of a single block (a tool result,
 * log dump, RAG chunk...). Detects JSON / logs / prose and applies the
 * matching strategy. The original is saved via `save` first, and the
 * compressed text ends with a retrieval note so the model (or the user)
 * can get the full content back on demand.
 */
export function compress(
  text: string,
  intensity: Intensity,
  opts?: { minTokens?: number; save?: (text: string) => string },
): CompressOutcome {
  const originalTokens = estimateTokens(text);
  const unchanged: CompressOutcome = {
    text,
    changed: false,
    originalTokens,
    finalTokens: originalTokens,
  };
  if (intensity === "off") return unchanged;
  const budget = BUDGETS[intensity];
  if (originalTokens <= Math.max(budget, opts?.minTokens ?? 0)) return unchanged;

  const storeId = opts?.save?.(text);

  let out: string;
  const json = tryParseJson(text);
  if (json !== undefined) out = compressJson(json, budget);
  else if (looksLikeLog(text)) out = compressLog(text, budget);
  else out = headTail(text, budget);

  // Whatever the strategy, never exceed the budget.
  if (estimateTokens(out) > budget) out = headTail(out, budget);

  const finalTokens = estimateTokens(out);
  if (finalTokens >= originalTokens) return unchanged;

  const note = storeId
    ? `\n[limitbreak: compressed ${originalTokens}→${finalTokens} tokens · full content: retrieve id ${storeId}]`
    : `\n[limitbreak: compressed ${originalTokens}→${finalTokens} tokens]`;
  return {
    text: out + note,
    changed: true,
    originalTokens,
    finalTokens: estimateTokens(out + note),
    storeId,
  };
}

function tryParseJson(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const LOG_LINE_RE =
  /^\s*(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|\[[^\]]*\]|(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\b)/;

function looksLikeLog(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 10) return false;
  const loggy = lines.filter((l) => LOG_LINE_RE.test(l)).length;
  return loggy / lines.length > 0.4;
}

const IMPORTANT_RE =
  /error|fatal|panic|exception|traceback|fail(ed|ure)?|warn|critical|denied|timeout|refused/i;

/**
 * Logs: keep every error/warning line verbatim (that's what the model is
 * looking for), collapse consecutive duplicates, and keep head+tail of the
 * routine noise under budget.
 */
export function compressLog(text: string, budgetTokens: number): string {
  const collapsed: { line: string; count: number }[] = [];
  for (const line of text.split("\n")) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.line === line) prev.count++;
    else collapsed.push({ line, count: 1 });
  }
  const rendered = collapsed.map((e) =>
    e.count > 1 ? `${e.line}  [×${e.count}]` : e.line,
  );

  const important: string[] = [];
  const routine: string[] = [];
  for (const line of rendered) {
    (IMPORTANT_RE.test(line) ? important : routine).push(line);
  }

  let remaining = budgetTokens - estimateTokens(important.join("\n"));
  if (remaining <= 0) {
    // Even the important lines exceed budget — they win; trim from the middle.
    return headTail(important.join("\n"), budgetTokens);
  }

  const headCount = Math.ceil(routine.length * 0.5);
  const head: string[] = [];
  const tail: string[] = [];
  for (let i = 0; i < routine.length && remaining > 0; i++) {
    const fromHead = i % 2 === 0 && head.length < headCount;
    const line = fromHead ? routine[head.length] : routine[routine.length - 1 - tail.length];
    if (line === undefined) break;
    const cost = estimateTokens(line);
    if (cost > remaining) break;
    remaining -= cost;
    if (fromHead) head.push(line);
    else tail.unshift(line);
  }
  const elided = routine.length - head.length - tail.length;

  // Reassemble in original order: head, elision marker, tail — with all
  // important lines merged back where budget allows (kept verbatim above).
  const parts = [...head];
  if (elided > 0) parts.push(`… [${elided} routine lines elided] …`);
  parts.push(...tail);
  if (important.length > 0) {
    parts.push("", `— errors/warnings (kept verbatim) —`, ...important);
  }
  return parts.join("\n");
}

/**
 * JSON: compact stringify, elide long arrays (keep head samples + last item),
 * truncate long strings. Two passes, tighter on the second.
 */
export function compressJson(value: unknown, budgetTokens: number): string {
  for (const [keepItems, maxStr] of [
    [5, 300],
    [2, 100],
  ] as const) {
    const pruned = prune(value, keepItems, maxStr);
    const out = JSON.stringify(pruned);
    if (estimateTokens(out) <= budgetTokens) return out;
  }
  return headTail(JSON.stringify(prune(value, 2, 100)), budgetTokens);
}

function prune(value: unknown, keepItems: number, maxStr: number): unknown {
  if (typeof value === "string") {
    return value.length > maxStr
      ? value.slice(0, maxStr) + `…[+${value.length - maxStr} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    if (value.length > keepItems + 2) {
      const head = value.slice(0, keepItems).map((v) => prune(v, keepItems, maxStr));
      const last = prune(value[value.length - 1], keepItems, maxStr);
      return [...head, `…[${value.length - keepItems - 1} items elided]`, last];
    }
    return value.map((v) => prune(v, keepItems, maxStr));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = prune(v, keepItems, maxStr);
    }
    return out;
  }
  return value;
}

/** Prose/code fallback: keep the head and tail, elide the middle. */
export function headTail(text: string, budgetTokens: number): string {
  const budgetChars = budgetTokens * 4;
  if (text.length <= budgetChars) return text;
  const headChars = Math.floor(budgetChars * 0.7);
  const tailChars = Math.floor(budgetChars * 0.25);
  return (
    text.slice(0, headChars) +
    `\n… [${text.length - headChars - tailChars} chars elided] …\n` +
    text.slice(text.length - tailChars)
  );
}

/**
 * Async walk over every compressible tool-result text block in a chat body.
 * `transform` returns the replacement text, or null to leave a block unchanged.
 * Mutates `body`. Shared by the built-in compressor and external backends so the
 * block-finding logic lives in one place.
 */
export async function mapToolResults(
  body: Record<string, unknown>,
  protocol: "anthropic" | "openai",
  transform: (text: string) => Promise<string | null>,
): Promise<void> {
  if (!Array.isArray(body.messages)) return;
  for (const msg of body.messages as Array<Record<string, unknown>>) {
    if (!msg || typeof msg !== "object") continue;
    if (protocol === "openai") {
      if (msg.role === "tool" && typeof msg.content === "string") {
        const r = await transform(msg.content);
        if (r !== null) msg.content = r;
      }
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!block || block.type !== "tool_result") continue;
      if (typeof block.content === "string") {
        const r = await transform(block.content);
        if (r !== null) block.content = r;
      } else if (Array.isArray(block.content)) {
        for (const part of block.content as Array<Record<string, unknown>>) {
          if (part?.type === "text" && typeof part.text === "string") {
            const r = await transform(part.text);
            if (r !== null) part.text = r;
          }
        }
      }
    }
  }
}

/**
 * Walks a chat request body and compresses tool results in place.
 * Returns estimated tokens saved. Mutates `body`.
 */
export function compressToolResults(
  body: Record<string, unknown>,
  protocol: "anthropic" | "openai",
  intensity: Intensity,
  opts: { minTokens: number; save?: (text: string) => string },
): number {
  if (intensity === "off" || !Array.isArray(body.messages)) return 0;
  let saved = 0;
  const doCompress = (text: string): string => {
    const r = compress(text, intensity, { minTokens: opts.minTokens, save: opts.save });
    saved += r.originalTokens - r.finalTokens;
    return r.text;
  };

  for (const msg of body.messages as Array<Record<string, unknown>>) {
    if (!msg || typeof msg !== "object") continue;
    if (protocol === "openai") {
      if (msg.role === "tool" && typeof msg.content === "string") {
        msg.content = doCompress(msg.content);
      }
      continue;
    }
    // anthropic: user messages carry tool_result blocks
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (!block || block.type !== "tool_result") continue;
      if (typeof block.content === "string") {
        block.content = doCompress(block.content);
      } else if (Array.isArray(block.content)) {
        for (const part of block.content as Array<Record<string, unknown>>) {
          if (part?.type === "text" && typeof part.text === "string") {
            part.text = doCompress(part.text);
          }
        }
      }
    }
  }
  return Math.max(0, saved);
}
