import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_PRICING, estimateCostUSD } from "./router.js";
import type { Usage } from "./types.js";

export interface UsageRecord extends Usage {
  ts: string;
  provider: string;
  model: string;
  /** Model the caller asked for, when the governor downgraded it. */
  requestedModel?: string;
  tag?: string;
  costUSD?: number;
  droppedContextTokens: number;
  /** Where the call came from: "proxy" | "sdk". */
  surface?: string;
  /** Governor verdict: true = policies applied, false = holdout control. */
  shaped?: boolean;
  /** Estimated tokens removed from the prompt by the compressor. */
  compressionSavedTokens?: number;
  /** False when the upstream returned a non-2xx — recorded for guardrail signals. */
  ok?: boolean;
  /** True when the response hit the output cap (stop_reason max_tokens / finish_reason length). */
  truncated?: boolean;
}

export function appendRecord(path: string, rec: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    // Telemetry must never break the actual call.
  }
}

export function recordUsage(path: string, rec: UsageRecord): void {
  appendRecord(path, rec);
}

export interface UsageReport {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  droppedContextTokens: number;
  compressionSavedTokens: number;
  /** Dollar value of compression-saved input tokens, at each call's model price. */
  compressionSavedUSD: number;
  /** Dollar delta between the requested model and the downgraded one actually used. */
  downgradeSavedUSD: number;
  /** Estimated output tokens saved by shaping: (holdoutAvg − shapedAvg) × shapedCalls. */
  shapingSavedTokens: number;
  /** Count of recorded rate-limit (429/warning) observations in range. */
  limitEvents: number;
  costUSD: number;
  /** Models seen with no configured price — their cost/savings can't be valued. */
  unpricedModels: string[];
  /** True when every model in range has a price, so dollar totals are complete. */
  costComplete: boolean;
  cacheHitRate: number;
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUSD: number }>;
  byTag: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUSD: number }>;
  /** Shaped vs holdout comparison; null until both groups have data. */
  shaping: {
    shapedCalls: number;
    holdoutCalls: number;
    shapedAvgOutput: number;
    holdoutAvgOutput: number;
    /** 1 - shapedAvg/holdoutAvg. Estimated: groups see different traffic. */
    estOutputReductionPct: number;
  } | null;
}

/** Parses durations like "7d", "24h", "30m" into milliseconds; null if invalid. */
export function parseDuration(spec: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(spec.trim());
  if (!m) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

export function aggregateUsage(
  path: string,
  opts: { sinceMs?: number; pricing?: Record<string, [number, number]> } = {},
): UsageReport {
  // Dollar cost is opt-in: the in-repo table is a convenience seed, extended by
  // the user's config pricing. Cost is recomputed here (not read from stored
  // records) so adding a price to config.json retroactively values old usage.
  const pricing = { ...DEFAULT_PRICING, ...(opts.pricing ?? {}) };
  const unpriced = new Set<string>();
  const report: UsageReport = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    droppedContextTokens: 0,
    compressionSavedTokens: 0,
    compressionSavedUSD: 0,
    downgradeSavedUSD: 0,
    shapingSavedTokens: 0,
    limitEvents: 0,
    costUSD: 0,
    unpricedModels: [],
    costComplete: true,
    cacheHitRate: 0,
    byModel: {},
    byTag: {},
    shaping: null,
  };
  if (!existsSync(path)) return report;
  const shaped = { calls: 0, output: 0 };
  const holdout = { calls: 0, output: 0 };

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let rec: UsageRecord & { kind?: string };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (opts.sinceMs !== undefined && Date.parse(rec.ts) < opts.sinceMs) continue;
    if (rec.kind === "limit") {
      report.limitEvents++;
      continue;
    }
    // Error lines are recorded only for guardrail signals — keep them out of the
    // usage/savings report so token and cost totals stay clean.
    if (rec.ok === false) continue;
    report.calls++;
    report.inputTokens += rec.inputTokens ?? 0;
    report.outputTokens += rec.outputTokens ?? 0;
    report.cacheReadTokens += rec.cacheReadTokens ?? 0;
    report.cacheWriteTokens += rec.cacheWriteTokens ?? 0;
    report.droppedContextTokens += rec.droppedContextTokens ?? 0;
    const savedTokens = rec.compressionSavedTokens ?? 0;
    report.compressionSavedTokens += savedTokens;

    // Cost is recomputed from effective pricing; unknown models are flagged, not
    // silently zeroed. Tokens (the governor's real unit) are always exact.
    const inTok = rec.inputTokens ?? 0;
    const outTok = rec.outputTokens ?? 0;
    const cacheTok = rec.cacheReadTokens ?? 0;
    const price = pricing[rec.model];
    if (!price) unpriced.add(rec.model);
    const cost = estimateCostUSD(rec.model, inTok, outTok, cacheTok, pricing) ?? 0;
    report.costUSD += cost;

    // Compression removes input tokens — value them at this call's input price.
    if (savedTokens > 0 && price) {
      report.compressionSavedUSD += (savedTokens * price[0]) / 1_000_000;
    }

    // Downgrade savings: what the requested model would have cost minus actual.
    if (rec.requestedModel && rec.requestedModel !== rec.model) {
      const wouldHave = estimateCostUSD(rec.requestedModel, inTok, outTok, cacheTok, pricing);
      if (wouldHave !== undefined) {
        report.downgradeSavedUSD += Math.max(0, wouldHave - cost);
      }
    }

    if (rec.shaped === true) {
      shaped.calls++;
      shaped.output += rec.outputTokens ?? 0;
    } else if (rec.shaped === false) {
      holdout.calls++;
      holdout.output += rec.outputTokens ?? 0;
    }

    for (const [key, bucket] of [
      [rec.model, report.byModel],
      [rec.tag ?? "(untagged)", report.byTag],
    ] as const) {
      const b = (bucket[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUSD: 0 });
      b.calls++;
      b.inputTokens += rec.inputTokens ?? 0;
      b.outputTokens += rec.outputTokens ?? 0;
      b.costUSD += cost;
    }
  }
  report.unpricedModels = [...unpriced].sort();
  report.costComplete = unpriced.size === 0;
  report.cacheHitRate =
    report.inputTokens > 0 ? report.cacheReadTokens / report.inputTokens : 0;
  if (shaped.calls > 0 && holdout.calls > 0) {
    const shapedAvgOutput = shaped.output / shaped.calls;
    const holdoutAvgOutput = holdout.output / holdout.calls;
    report.shaping = {
      shapedCalls: shaped.calls,
      holdoutCalls: holdout.calls,
      shapedAvgOutput,
      holdoutAvgOutput,
      estOutputReductionPct:
        holdoutAvgOutput > 0 ? 1 - shapedAvgOutput / holdoutAvgOutput : 0,
    };
    report.shapingSavedTokens = Math.max(
      0,
      (holdoutAvgOutput - shapedAvgOutput) * shaped.calls,
    );
  }
  return report;
}
