import type { ContextItem } from "./types.js";

/**
 * Rough token estimate (~4 chars/token for English/code). Used only for
 * budget packing decisions; real usage comes back from the API.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface PackedContext {
  /** Pinned items — stable across calls, safe to place in the cached prefix. */
  pinned: string;
  /** Remaining items that fit the budget, in original order. */
  volatile: string;
  droppedTokens: number;
}

function render(item: ContextItem): string {
  return item.label ? `[${item.label}]\n${item.text}` : item.text;
}

/**
 * Packs context under a token budget.
 *
 * - Pinned items are never dropped and are returned separately so callers can
 *   put them in the cache-eligible prefix (identical bytes across calls).
 * - Unpinned items are kept highest-priority-first until the budget runs out,
 *   but emitted in their ORIGINAL order — reordering by priority would change
 *   the byte prefix between calls and break provider prompt caches.
 */
export function packContext(
  items: (string | ContextItem)[],
  maxInputTokens?: number,
): PackedContext {
  const norm: ContextItem[] = items.map((it) =>
    typeof it === "string" ? { text: it } : it,
  );

  const pinnedItems = norm.filter((i) => i.pinned);
  const rest = norm.filter((i) => !i.pinned);

  const pinned = pinnedItems.map(render).join("\n\n");
  let budget = maxInputTokens === undefined
    ? Infinity
    : maxInputTokens - estimateTokens(pinned);

  const scored = rest
    .map((item, idx) => ({ item, idx, tokens: estimateTokens(render(item)) }))
    .sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0));

  const kept: typeof scored = [];
  let droppedTokens = 0;
  for (const entry of scored) {
    if (entry.tokens <= budget) {
      kept.push(entry);
      budget -= entry.tokens;
    } else {
      droppedTokens += entry.tokens;
    }
  }

  kept.sort((a, b) => a.idx - b.idx);
  return {
    pinned,
    volatile: kept.map((e) => render(e.item)).join("\n\n"),
    droppedTokens,
  };
}
