import type { GovernorSettings, WindowForecast } from "./ledger.js";

export type HeadroomLevel = "green" | "yellow" | "red";

export interface Assessment {
  level: HeadroomLevel;
  /** The window closest to exhaustion. */
  worst: WindowForecast | null;
  forecasts: WindowForecast[];
}

export function assess(
  forecasts: WindowForecast[],
  s: GovernorSettings,
): Assessment {
  let worst: WindowForecast | null = null;
  for (const f of forecasts) {
    if (!worst || f.pct > worst.pct) worst = f;
  }
  const pct = worst?.pct ?? 0;
  const level: HeadroomLevel =
    pct >= s.redPct ? "red" : pct >= s.yellowPct ? "yellow" : "green";
  return { level, worst, forecasts };
}

export const TERSE_STEER =
  "Quota pressure is high. Be terse: answer directly, no preamble, do not restate context or code you were already given, no closing summary.";

export interface ShapeResult {
  body: Record<string, unknown>;
  shaped: boolean;
  /** Set when the request should be rejected and retried after the window frees up. */
  defer?: { retryAfterMs: number };
}

/**
 * Applies pressure policies to an outbound request body. Pure — the caller
 * supplies the holdout roll so behavior is deterministic and testable.
 *
 * The steering text is APPENDED to the system prompt: provider prompt caches
 * key on the leading bytes, so a suffix keeps the cached prefix intact.
 */
export function shape(
  body: Record<string, unknown>,
  assessment: Assessment,
  s: GovernorSettings,
  opts: {
    holdoutRoll: number;
    deferrable: boolean;
    protocol: "anthropic" | "openai";
    retryAfterMs?: number;
  },
): ShapeResult {
  if (assessment.level === "green") return { body, shaped: false };
  if (opts.holdoutRoll < s.holdout) return { body, shaped: false };

  if (assessment.level === "red" && opts.deferrable) {
    return {
      body,
      shaped: true,
      defer: { retryAfterMs: opts.retryAfterMs ?? 15 * 60_000 },
    };
  }

  const out = structuredClone(body);
  const model = out.model as string | undefined;
  if (model && s.downgrade[model]) out.model = s.downgrade[model];
  if (s.terseOnPressure) appendSteering(out, opts.protocol);
  return { body: out, shaped: true };
}

function appendSteering(
  body: Record<string, unknown>,
  protocol: "anthropic" | "openai",
): void {
  if (protocol === "anthropic") {
    // system is a string or an array of content blocks.
    const sys = body.system;
    if (Array.isArray(sys)) {
      sys.push({ type: "text", text: TERSE_STEER });
    } else if (typeof sys === "string") {
      body.system = sys + "\n\n" + TERSE_STEER;
    } else {
      body.system = TERSE_STEER;
    }
    return;
  }
  if (Array.isArray(body.messages)) {
    body.messages.push({ role: "system", content: TERSE_STEER });
  }
}
