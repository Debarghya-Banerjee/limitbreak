import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompressionBackendSetting } from "./backends.js";
import { calibrateBudgets, effectiveWindows, type CalibratedBudget } from "./calibrate.js";
import type { Intensity } from "./compress.js";
import { DEFAULT_GUARDRAILS, type GuardrailConfig } from "./guardrails.js";
import { appendRecord, recordUsage, type UsageRecord } from "./telemetry.js";

export interface QuotaWindow {
  name: string;
  hours: number;
  budgetTokens: number;
}

export interface GovernorSettings {
  windows: QuotaWindow[];
  /** Headroom level thresholds as fraction of a window budget. */
  yellowPct: number;
  redPct: number;
  /** Fraction of pressured traffic left unshaped as a quality control group. */
  holdout: number;
  terseOnPressure: boolean;
  /** Model downgrade map applied under pressure, e.g. {"claude-opus-4-7":"claude-sonnet-4-6"}. Opt-in. */
  downgrade: Record<string, string>;
  /** Compression intensity per headroom level — optimization escalates with pressure. */
  compression: { green: Intensity; yellow: Intensity; red: Intensity };
  /** Tool results below this estimated token count are never compressed. */
  compressMinTokens: number;
  /**
   * Which compressor limitbreak drives: "builtin" (zero-dep heuristic, default)
   * or an external subprocess (e.g. headroom) it feeds under quota pressure.
   */
  compressionBackend: CompressionBackendSetting;
  /** Infer window budgets from observed 429s when the user hasn't set them explicitly. */
  autoCalibrate: boolean;
  /** Auto-revert a policy that measurably regresses vs the holdout. */
  guardrails: GuardrailConfig;
  /**
   * Optional $/MTok overrides keyed by model id: { "model": [input, output] }.
   * Dollar cost is opt-in — the governor runs on tokens, not dollars, so this is
   * only for pay-as-you-go API users who want cost estimates. Subscription users
   * can ignore it. Unset models report cost as n/a rather than a misleading $0.
   */
  pricing: Record<string, [number, number]>;
  upstreams: { anthropic: string; openai: string };
  /** True iff the user's config explicitly set `windows` — set at load time, not serialized. */
  windowsExplicit?: boolean;
}

/**
 * A rate-limit observation recorded to the ledger as `{ kind: "limit", ... }`.
 * A 429 proves the effective budget is at most the tokens consumed in-window
 * at that moment; header warnings are softer evidence of the same.
 */
export interface LimitEvent {
  kind: "limit";
  ts: string;
  provider: string;
  /** HTTP status: 429 for a hard limit, 200 for an opportunistic header warning. */
  status: number;
  model?: string;
  retryAfterSec?: number;
  /** Captured `anthropic-ratelimit-*` (and `retry-after`) response headers. */
  ratelimit?: Record<string, string>;
  /** In-window token totals at the moment of the event, keyed by window name. */
  usedAt: Record<string, number>;
}

// Window budgets are placeholders — providers don't expose subscription
// budgets, so set yours in ~/.limitbreak/config.json to match observed limits.
export const DEFAULT_SETTINGS: GovernorSettings = {
  windows: [
    { name: "5h", hours: 5, budgetTokens: 2_000_000 },
    { name: "7d", hours: 168, budgetTokens: 15_000_000 },
  ],
  yellowPct: 0.7,
  redPct: 0.9,
  holdout: 0.1,
  terseOnPressure: true,
  downgrade: {},
  compression: { green: "light", yellow: "standard", red: "aggressive" },
  compressMinTokens: 500,
  compressionBackend: "builtin",
  autoCalibrate: true,
  guardrails: DEFAULT_GUARDRAILS,
  pricing: {},
  upstreams: {
    anthropic: "https://api.anthropic.com",
    openai: "https://api.openai.com",
  },
};

export function configDir(): string {
  return join(homedir(), ".limitbreak");
}

export function loadSettings(
  path = join(configDir(), "config.json"),
): GovernorSettings {
  if (!existsSync(path)) return DEFAULT_SETTINGS;
  try {
    const user = JSON.parse(readFileSync(path, "utf8"));
    return {
      ...DEFAULT_SETTINGS,
      ...user,
      compression: { ...DEFAULT_SETTINGS.compression, ...user.compression },
      guardrails: { ...DEFAULT_SETTINGS.guardrails, ...user.guardrails },
      pricing: { ...DEFAULT_SETTINGS.pricing, ...user.pricing },
      upstreams: { ...DEFAULT_SETTINGS.upstreams, ...user.upstreams },
      windowsExplicit: Array.isArray(user.windows),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface WindowForecast {
  window: QuotaWindow;
  usedTokens: number;
  /** usedTokens / budget. Can exceed 1. */
  pct: number;
  /** Total tokens per minute over the trailing 30 minutes. */
  burnPerMin: number;
  /** Epoch ms when the budget runs out at the current burn rate; null if idle. */
  exhaustsAt: number | null;
}

interface Entry {
  ts: number;
  totalTokens: number;
}

const BURN_LOOKBACK_MS = 30 * 60_000;

export class Ledger {
  private entries: Entry[] = [];
  private limits: LimitEvent[] = [];

  constructor(public logPath: string) {
    if (!existsSync(logPath)) return;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        const ts = Date.parse(r.ts);
        if (Number.isNaN(ts)) continue;
        if (r.kind === "limit") {
          this.limits.push(r as LimitEvent);
          continue;
        }
        this.entries.push({
          ts,
          totalTokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
        });
      } catch {
        continue;
      }
    }
  }

  record(rec: UsageRecord): void {
    recordUsage(this.logPath, rec);
    this.entries.push({
      ts: Date.parse(rec.ts),
      totalTokens: rec.inputTokens + rec.outputTokens,
    });
  }

  recordLimit(ev: LimitEvent): void {
    appendRecord(this.logPath, ev);
    this.limits.push(ev);
  }

  /** Limit observations recorded at or after `sinceMs` (epoch ms). */
  limitEvents(sinceMs = 0): LimitEvent[] {
    return this.limits.filter((e) => Date.parse(e.ts) >= sinceMs);
  }

  /** In-window token totals per window right now — snapshot for a limit event. */
  usedByWindow(settings: GovernorSettings, now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const f of this.forecasts(settings, now)) out[f.window.name] = f.usedTokens;
    return out;
  }

  /** Per-window calibrated budgets from observed limit events (null = no evidence). */
  calibration(
    settings: GovernorSettings,
    now = Date.now(),
  ): Record<string, CalibratedBudget | null> {
    return calibrateBudgets(this.limits, settings.windows, now);
  }

  /**
   * Settings with window budgets replaced by calibrated values where evidence
   * exists (unless the user set budgets explicitly or disabled autoCalibrate).
   * The governor and status readout run off this.
   */
  effectiveSettings(settings: GovernorSettings, now = Date.now()): GovernorSettings {
    return { ...settings, windows: effectiveWindows(settings, this.calibration(settings, now)) };
  }

  forecasts(settings: GovernorSettings, now = Date.now()): WindowForecast[] {
    const maxMs = Math.max(...settings.windows.map((w) => w.hours * 3_600_000));
    this.entries = this.entries.filter((e) => e.ts >= now - maxMs);

    const burnWindow = this.entries.filter((e) => e.ts >= now - BURN_LOOKBACK_MS);
    const burnPerMin =
      burnWindow.reduce((s, e) => s + e.totalTokens, 0) /
      (BURN_LOOKBACK_MS / 60_000);

    return settings.windows.map((window) => {
      const cutoff = now - window.hours * 3_600_000;
      const usedTokens = this.entries
        .filter((e) => e.ts >= cutoff)
        .reduce((s, e) => s + e.totalTokens, 0);
      const pct = window.budgetTokens > 0 ? usedTokens / window.budgetTokens : 0;
      const remaining = window.budgetTokens - usedTokens;
      let exhaustsAt: number | null = null;
      if (remaining <= 0) exhaustsAt = now;
      else if (burnPerMin > 0) {
        exhaustsAt = now + (remaining / burnPerMin) * 60_000;
      }
      return { window, usedTokens, pct, burnPerMin, exhaustsAt };
    });
  }

  /**
   * Ms until the oldest entry inside the window ages out — the soonest moment
   * a rolling window frees any budget. Used as Retry-After for deferred calls.
   */
  nextReliefMs(window: QuotaWindow, now = Date.now()): number {
    const cutoff = now - window.hours * 3_600_000;
    const inWindow = this.entries.filter((e) => e.ts >= cutoff);
    if (inWindow.length === 0) return 60_000;
    const oldest = Math.min(...inWindow.map((e) => e.ts));
    return Math.max(60_000, oldest + window.hours * 3_600_000 - now);
  }
}
