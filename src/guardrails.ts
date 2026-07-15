import { existsSync, readFileSync } from "node:fs";

/**
 * Auto-revert guardrails. limitbreak has no quality oracle, so instead of
 * scoring answers it compares the shaped group against the 10% holdout on
 * *observable* regressions — provider errors, output truncation, and whether
 * the optimization even saved tokens — and disables a policy that's making
 * things measurably worse. Evaluation is stateless over a trailing window, so a
 * reverted policy re-enables on its own once the signal clears (and re-tests).
 */
export interface GuardrailConfig {
  enabled: boolean;
  /** Minimum calls in *each* group before a verdict can fire (noise floor). */
  minSamples: number;
  /** Absolute error-rate delta over holdout that trips a revert, e.g. 0.05 = 5pp. */
  errorMargin: number;
  /** Absolute truncation-rate delta over holdout that trips a revert. */
  truncationMargin: number;
  /** Trailing window the guardrail evaluates over. */
  lookbackHours: number;
}

export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  enabled: true,
  minSamples: 20,
  errorMargin: 0.05,
  truncationMargin: 0.05,
  lookbackHours: 6,
};

export interface GuardrailRecord {
  ts: number;
  shaped?: boolean;
  downgraded: boolean;
  ok: boolean;
  truncated: boolean;
  totalTokens: number;
}

export interface GroupStats {
  calls: number;
  errorRate: number;
  truncationRate: number;
  avgTokens: number;
}

export interface PolicyVerdict {
  disabled: boolean;
  reason: string | null;
  shaped: GroupStats | null;
  holdout: GroupStats | null;
}

export interface GuardrailVerdict {
  /** The compression + terse-steering bundle (any shaped call). */
  shaping: PolicyVerdict;
  /** Model downgrade specifically. */
  downgrade: PolicyVerdict;
}

function stats(recs: GuardrailRecord[]): GroupStats {
  const calls = recs.length;
  if (calls === 0) return { calls: 0, errorRate: 0, truncationRate: 0, avgTokens: 0 };
  const errors = recs.filter((r) => !r.ok).length;
  const truncs = recs.filter((r) => r.truncated).length;
  const tokens = recs.reduce((s, r) => s + r.totalTokens, 0);
  return { calls, errorRate: errors / calls, truncationRate: truncs / calls, avgTokens: tokens / calls };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function judge(
  group: GuardrailRecord[],
  control: GuardrailRecord[],
  cfg: GuardrailConfig,
  checkBackfire: boolean,
): PolicyVerdict {
  if (group.length < cfg.minSamples || control.length < cfg.minSamples) {
    return { disabled: false, reason: null, shaped: null, holdout: null };
  }
  const a = stats(group);
  const c = stats(control);
  const reasons: string[] = [];
  if (a.errorRate - c.errorRate > cfg.errorMargin) {
    reasons.push(`error rate ${pct(a.errorRate)} vs ${pct(c.errorRate)} holdout`);
  }
  if (a.truncationRate - c.truncationRate > cfg.truncationMargin) {
    reasons.push(`truncation ${pct(a.truncationRate)} vs ${pct(c.truncationRate)} holdout`);
  }
  if (checkBackfire && a.avgTokens > c.avgTokens) {
    reasons.push(`no token savings (${Math.round(a.avgTokens)} ≥ ${Math.round(c.avgTokens)} holdout avg)`);
  }
  return {
    disabled: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
    shaped: a,
    holdout: c,
  };
}

export function evaluateGuardrails(
  records: GuardrailRecord[],
  cfg: GuardrailConfig,
): GuardrailVerdict {
  const off: PolicyVerdict = { disabled: false, reason: null, shaped: null, holdout: null };
  if (!cfg.enabled) return { shaping: off, downgrade: off };

  const holdout = records.filter((r) => r.shaped === false);
  const shaped = records.filter((r) => r.shaped === true);
  const downgraded = records.filter((r) => r.downgraded);

  return {
    shaping: judge(shaped, holdout, cfg, true),
    downgrade: judge(downgraded, holdout, cfg, false),
  };
}

/** Reads usage records from the ledger for guardrail evaluation (excludes limit lines). */
export function readGuardrailRecords(path: string, sinceMs: number): GuardrailRecord[] {
  if (!existsSync(path)) return [];
  const out: GuardrailRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind === "limit") continue;
      const ts = Date.parse(r.ts);
      if (Number.isNaN(ts) || ts < sinceMs) continue;
      out.push({
        ts,
        shaped: r.shaped,
        downgraded: typeof r.requestedModel === "string" && r.requestedModel !== r.model,
        ok: r.ok !== false,
        truncated: r.truncated === true,
        totalTokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
      });
    } catch {
      continue;
    }
  }
  return out;
}
