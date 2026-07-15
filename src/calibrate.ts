import type { GovernorSettings, LimitEvent, QuotaWindow } from "./ledger.js";

/** Observations older than this are ignored — subscription limits drift. */
const DECAY_MS = 14 * 86_400_000;

export interface CalibratedBudget {
  budgetTokens: number;
  source: "observed-429" | "header-warning";
  observedAt: number;
  samples: number;
}

/**
 * Infers effective per-window budgets from rate-limit observations.
 *
 * A 429 proves the budget is at most the tokens consumed in that window when it
 * fired, so the estimate is the MINIMUM `usedAt` across recent events — we never
 * claim a budget higher than the hardest evidence. A single 429 is enough;
 * softer 200-status header warnings need two before they override defaults.
 * Returns null for a window with insufficient evidence so callers fall back to
 * config/defaults.
 */
export function calibrateBudgets(
  events: LimitEvent[],
  windows: QuotaWindow[],
  now = Date.now(),
): Record<string, CalibratedBudget | null> {
  const fresh = events.filter((e) => now - Date.parse(e.ts) <= DECAY_MS);
  const out: Record<string, CalibratedBudget | null> = {};

  for (const w of windows) {
    const relevant = fresh.filter((e) => e.usedAt[w.name] !== undefined);
    const hard = relevant.filter((e) => e.status === 429);
    const warnings = relevant.filter((e) => e.status !== 429);

    // Need at least one hard 429, or two softer header warnings.
    if (hard.length === 0 && warnings.length < 2) {
      out[w.name] = null;
      continue;
    }

    const source: CalibratedBudget["source"] =
      hard.length > 0 ? "observed-429" : "header-warning";
    const sample = hard.length > 0 ? hard : warnings;
    let budgetTokens = Infinity;
    let observedAt = 0;
    for (const e of sample) {
      const used = e.usedAt[w.name]!;
      if (used < budgetTokens) budgetTokens = used;
      observedAt = Math.max(observedAt, Date.parse(e.ts));
    }
    out[w.name] = { budgetTokens, source, observedAt, samples: sample.length };
  }

  return out;
}

/**
 * Resolves the windows the governor should actually use: an explicit user
 * `budgetTokens` always wins; otherwise a calibrated budget; otherwise the
 * placeholder default. Calibration is skipped entirely when the user set
 * `windows` in config or turned `autoCalibrate` off.
 */
export function effectiveWindows(
  settings: GovernorSettings,
  calibration: Record<string, CalibratedBudget | null>,
): QuotaWindow[] {
  if (settings.windowsExplicit || !settings.autoCalibrate) return settings.windows;
  return settings.windows.map((w) => {
    const c = calibration[w.name];
    return c ? { ...w, budgetTokens: c.budgetTokens } : w;
  });
}
