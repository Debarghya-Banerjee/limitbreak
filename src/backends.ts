import { spawn } from "node:child_process";
import {
  compressionBudget,
  compressToolResults,
  mapToolResults,
  type Intensity,
} from "./compress.js";
import { estimateTokens } from "./context.js";

export interface CompressOpts {
  /** Blocks below this estimated token count are never compressed. */
  minTokens: number;
  /** Store the pre-compression original; returns a retrieval id. */
  save?: (text: string) => string;
}

/**
 * A compression backend turns oversized tool-result text into a smaller form.
 * limitbreak keeps ownership of everything that makes it a *governor* — deciding
 * intensity from quota pressure, storing originals for reversibility, appending
 * retrieval markers, and counting saved tokens — and delegates only the raw
 * text→text compression here. That's what lets it drive headroom/rtk/etc. as
 * muscle without surrendering the closed loop.
 */
export interface CompressionBackend {
  readonly name: string;
  /** Compress tool results in `body` in place. Returns estimated tokens saved. */
  compress(
    body: Record<string, unknown>,
    protocol: "anthropic" | "openai",
    intensity: Intensity,
    opts: CompressOpts,
  ): Promise<number>;
}

/** The zero-dependency heuristic compressor limitbreak ships with. */
export const builtinBackend: CompressionBackend = {
  name: "builtin",
  async compress(body, protocol, intensity, opts) {
    return compressToolResults(body, protocol, intensity, opts);
  },
};

export interface ExternalBackendConfig {
  /**
   * Argv for a process that reads block text on stdin and writes the compressed
   * text on stdout (exit 0). The literal token `{budget}` in any arg is replaced
   * with the target token budget for the current pressure level.
   * e.g. ["headroom", "compress", "--max-tokens", "{budget}"]
   */
  command: string[];
  /** Per-block timeout; on timeout or non-zero exit the block passes through uncompressed. */
  timeoutMs?: number;
}

/**
 * Drives an external compressor as a subprocess. limitbreak still applies the
 * min-token threshold, stores the original (reversibility), writes the retrieval
 * marker, and measures savings — the external tool only does text→text. Any
 * failure falls back to passing the block through untouched, so a flaky backend
 * can never break a request.
 *
 * Note: external compressors may be non-deterministic, which can break provider
 * prompt-cache alignment on re-sent history. The built-in compressor is
 * deterministic by design; prefer it, or a deterministic external, when caching
 * matters more than maximum reduction.
 */
export function externalBackend(cfg: ExternalBackendConfig): CompressionBackend {
  const timeoutMs = cfg.timeoutMs ?? 5000;
  return {
    name: `external(${cfg.command[0] ?? "?"})`,
    async compress(body, protocol, intensity, opts) {
      const budget = compressionBudget(intensity);
      if (budget === null) return 0;
      let saved = 0;
      await mapToolResults(body, protocol, async (text) => {
        const tokens = estimateTokens(text);
        if (tokens <= Math.max(budget, opts.minTokens)) return null;

        const compressed = await runExternalCompressor(cfg.command, text, budget, timeoutMs);
        if (compressed == null || compressed.length === 0) return null; // failed → passthrough
        const bodyTokens = estimateTokens(compressed);
        if (bodyTokens >= tokens) return null; // no win → leave original

        const id = opts.save?.(text);
        const note = id
          ? `\n[limitbreak: compressed ${tokens}→${bodyTokens} tokens · full content: retrieve id ${id}]`
          : `\n[limitbreak: compressed ${tokens}→${bodyTokens} tokens]`;
        const finalText = compressed + note;
        saved += tokens - estimateTokens(finalText);
        return finalText;
      });
      return Math.max(0, saved);
    },
  };
}

export type CompressionBackendSetting = "builtin" | ExternalBackendConfig;

/** Selects a backend from config; defaults to the built-in compressor. */
export function makeCompressionBackend(
  setting: CompressionBackendSetting | undefined,
): CompressionBackend {
  if (!setting || setting === "builtin") return builtinBackend;
  return externalBackend(setting);
}

/** Runs `command`, piping `text` to stdin, resolving stdout — or null on any failure. */
function runExternalCompressor(
  command: string[],
  text: string,
  budget: number,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const [cmd, ...rest] = command;
    if (!cmd) return resolve(null);
    const args = rest.map((a) => a.replace(/\{budget\}/g, String(budget)));

    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }

    let out = "";
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? out : null));
    child.stdin.on("error", () => {}); // ignore EPIPE if the tool exits early
    child.stdin.write(text);
    child.stdin.end();
  });
}
