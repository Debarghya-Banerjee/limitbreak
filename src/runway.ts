import type { WindowForecast } from "./ledger.js";

export interface RunwayInfo {
  window: string;
  budgetTokens: number;
  usedTokens: number;
  burnPerMin: number;
  /** Minutes until the window exhausts at the current burn; null when idle. */
  runwayMin: number | null;
  /** limitbreak's token savings counted within this window. */
  savedTokens: number;
  /**
   * Extra minutes of runway limitbreak bought: the saved tokens, spent at the
   * current burn rate, would have cost this much time before the wall. This is
   * the counterfactual only a quota-aware governor can state — a blind
   * compressor knows how many tokens it cut, but not how much *limit* that buys.
   * null when idle (no burn to project against).
   */
  gainedMin: number | null;
}

/** Turns a window forecast + its in-window savings into runway, current and gained. */
export function computeRunway(f: WindowForecast, savedTokens: number): RunwayInfo {
  const burn = f.burnPerMin;
  const remaining = Math.max(0, f.window.budgetTokens - f.usedTokens);
  return {
    window: f.window.name,
    budgetTokens: f.window.budgetTokens,
    usedTokens: f.usedTokens,
    burnPerMin: burn,
    runwayMin: burn > 0 ? remaining / burn : null,
    savedTokens,
    gainedMin: burn > 0 ? savedTokens / burn : null,
  };
}

/** Human duration: "<1 min", "45 min", "3h 40m", "2d 3h". */
export function formatDuration(min: number): string {
  if (min < 1) return "<1 min";
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `${d}d ${remH}h` : `${d}d`;
}
