import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { makeCompressionBackend } from "./backends.js";
import { buildStats, dashboardHtml } from "./dashboard.js";
import { assess, shape } from "./governor.js";
import {
  evaluateGuardrails,
  readGuardrailRecords,
  type GuardrailVerdict,
} from "./guardrails.js";
import { configDir, type GovernorSettings, type Ledger } from "./ledger.js";
import type { LimitEvent } from "./ledger.js";
import { Memory } from "./memory.js";
import { DEFAULT_PRICING, estimateCostUSD } from "./router.js";
import { Store } from "./store.js";
import type { Usage } from "./types.js";

const HOP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "keep-alive",
  "proxy-authorization",
  "te",
  "upgrade",
]);

/** Cap on the response bytes buffered for usage extraction. */
const USAGE_BUFFER_LIMIT = 4 * 1024 * 1024;

/** How often the guardrail verdict is recomputed from the ledger. */
const GUARDRAIL_REFRESH_MS = 60_000;

export interface ProxyOptions {
  ledger: Ledger;
  settings: GovernorSettings;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
  /** Injectable for tests; defaults to ~/.limitbreak/store. */
  store?: Store;
  /** Injectable for tests; defaults to ~/.limitbreak/memory.jsonl. */
  memory?: Memory;
}

export function createProxy(opts: ProxyOptions): Server {
  const { ledger, settings } = opts;
  const random = opts.random ?? Math.random;
  const store = opts.store ?? new Store(join(configDir(), "store"));
  const memory = opts.memory ?? new Memory(join(configDir(), "memory.jsonl"));
  const backend = makeCompressionBackend(settings.compressionBackend);

  // Guardrail verdict is recomputed from the ledger at most once per refresh
  // window, not per request, so it never adds ledger reads to the hot path.
  let cachedVerdict: GuardrailVerdict | null = null;
  let verdictAt = 0;
  const currentVerdict = (): GuardrailVerdict | null => {
    if (!settings.guardrails.enabled) return null;
    const now = Date.now();
    if (cachedVerdict && now - verdictAt < GUARDRAIL_REFRESH_MS) return cachedVerdict;
    const records = readGuardrailRecords(
      ledger.logPath,
      now - settings.guardrails.lookbackHours * 3_600_000,
    );
    cachedVerdict = evaluateGuardrails(records, settings.guardrails);
    verdictAt = now;
    return cachedVerdict;
  };

  return createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/" || url === "/dashboard")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(dashboardHtml());
        return;
      }
      if (req.method === "GET" && url === "/stats") {
        json(res, 200, buildStats(ledger, settings));
        return;
      }
      if (req.method === "GET" && url === "/status") {
        const eff = ledger.effectiveSettings(settings);
        const a = assess(ledger.forecasts(eff), eff);
        json(res, 200, a);
        return;
      }
      if (req.method === "GET" && url.startsWith("/retrieve/")) {
        const original = store.load(url.slice("/retrieve/".length));
        if (original === null) json(res, 404, { error: "unknown id" });
        else {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(original);
        }
        return;
      }
      if (url.split("?")[0] === "/memory" || url.startsWith("/memory/")) {
        await handleMemory(req, res, url);
        return;
      }
      if (url.startsWith("/openai/")) {
        await forward(req, res, "openai", url.slice("/openai".length));
        return;
      }
      if (url.startsWith("/v1/")) {
        await forward(req, res, "anthropic", url);
        return;
      }
      json(res, 404, { error: "limitbreak: unknown route", url });
    } catch (err) {
      if (!res.headersSent) {
        json(res, 502, { error: `limitbreak proxy: ${String(err)}` });
      } else {
        res.end();
      }
    }
  });

  async function handleMemory(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    const [path, qs] = url.split("?") as [string, string?];
    if (req.method === "GET" && path === "/memory") {
      const params = new URLSearchParams(qs ?? "");
      const q = params.get("q");
      const tag = params.get("tag") ?? undefined;
      const limitRaw = params.get("limit");
      const limit = limitRaw ? Number(limitRaw) : undefined;
      const entries =
        q === null || q === ""
          ? memory.list().filter((e) => !tag || e.tags?.includes(tag))
          : memory.recall(q, { ...(tag && { tag }), ...(limit && !Number.isNaN(limit) && { limit }) });
      json(res, 200, { entries });
      return;
    }
    if (req.method === "POST" && path === "/memory") {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch {
        json(res, 400, { error: "memory: body must be JSON" });
        return;
      }
      if (typeof body.text !== "string") {
        json(res, 400, { error: 'memory: "text" (string) is required' });
        return;
      }
      try {
        const entry = memory.remember({
          text: body.text,
          ...(typeof body.key === "string" && { key: body.key }),
          ...(Array.isArray(body.tags) && {
            tags: body.tags.filter((t): t is string => typeof t === "string"),
          }),
          ...(typeof body.ttlHours === "number" && { ttlHours: body.ttlHours }),
        });
        json(res, 200, { entry });
      } catch (err) {
        json(res, 400, { error: String(err instanceof Error ? err.message : err) });
      }
      return;
    }
    if (req.method === "DELETE" && path.startsWith("/memory/")) {
      const id = path.slice("/memory/".length);
      if (memory.forget(id)) json(res, 200, { deleted: id });
      else json(res, 404, { error: `no memory with id ${id}` });
      return;
    }
    json(res, 405, { error: "memory: use GET /memory?q=, POST /memory, or DELETE /memory/<id>" });
  }

  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    protocol: "anthropic" | "openai",
    path: string,
  ): Promise<void> {
    const upstream = settings.upstreams[protocol].replace(/\/$/, "") + path;
    const rawBody = await readBody(req);

    const pathOnly = path.split("?")[0];
    const governable =
      req.method === "POST" &&
      (pathOnly === "/v1/messages" || pathOnly === "/v1/chat/completions");

    // Calibrated budgets (from observed 429s) drive pressure decisions.
    const eff = ledger.effectiveSettings(settings);

    let outBody = rawBody;
    let shaped: boolean | undefined;
    let requestedModel: string | undefined;
    let compressionSavedTokens = 0;
    let model = "";
    if (governable && rawBody.length > 0) {
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        parsed = undefined; // not JSON — pass through untouched
      }
      if (parsed) {
        model = typeof parsed.model === "string" ? parsed.model : "";
        const verdict = currentVerdict();

        if (verdict?.shaping.disabled) {
          // Shaping auto-reverted (regressing vs holdout) — pass this request
          // through untouched and record it as control so the guardrail can
          // re-test once the trailing window refills.
          shaped = false;
        } else {
          // Downgrade can be reverted on its own while the rest of shaping stays.
          const govSettings = verdict?.downgrade.disabled ? { ...eff, downgrade: {} } : eff;
          const assessment = assess(ledger.forecasts(eff), eff);
          const result = shape(parsed, assessment, govSettings, {
            holdoutRoll: random(),
            deferrable: req.headers["x-limitbreak-defer"] === "allow",
            protocol,
            retryAfterMs: assessment.worst
              ? ledger.nextReliefMs(assessment.worst.window)
              : undefined,
          });
          if (result.defer) {
            res.setHeader("retry-after", String(Math.ceil(result.defer.retryAfterMs / 1000)));
            json(res, 429, {
              error: "limitbreak: deferred under red quota pressure",
              retryAfterMs: result.defer.retryAfterMs,
            });
            return;
          }
          if (assessment.level !== "green") shaped = result.shaped;

          // Record the model actually sent (post-downgrade) so cost is accurate;
          // remember the requested model when it differs, for savings accounting.
          const sentModel = typeof result.body.model === "string" ? result.body.model : model;
          if (sentModel !== model) requestedModel = model;
          model = sentModel;

          // Compression escalates with quota pressure. Holdout traffic
          // (shaped === false under pressure) skips it so the control group
          // stays clean. Deterministic compressors keep re-sent history
          // byte-identical across turns, so provider prompt caches still hit.
          const intensity =
            shaped === false ? "off" : govSettings.compression[assessment.level];
          compressionSavedTokens = await backend.compress(result.body, protocol, intensity, {
            minTokens: eff.compressMinTokens,
            save: (t) => store.save(t),
          });

          outBody = Buffer.from(JSON.stringify(result.body), "utf8");
        }
      }
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(k) || k.startsWith("x-limitbreak-")) continue;
      if (typeof v === "string") headers[k] = v;
    }

    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : outBody,
    });

    res.statusCode = upstreamRes.status;
    upstreamRes.headers.forEach((v, k) => {
      if (!HOP_HEADERS.has(k) && k !== "content-encoding") res.setHeader(k, v);
    });

    if (governable) recordLimitObservation(ledger, eff, upstreamRes, protocol, model);

    // Stream through while buffering (capped) for usage extraction.
    let buffered = Buffer.alloc(0);
    if (upstreamRes.body) {
      for await (const chunk of upstreamRes.body) {
        const buf = Buffer.from(chunk);
        res.write(buf);
        if (buffered.length < USAGE_BUFFER_LIMIT) {
          buffered = Buffer.concat([buffered, buf]);
        }
      }
    }
    res.end();

    if (governable) {
      const tag = req.headers["x-limitbreak-tag"];
      const tagStr = typeof tag === "string" ? tag : undefined;

      if (upstreamRes.ok) {
        const body = buffered.toString("utf8");
        const usage = extractUsage(body, protocol);
        if (usage) {
          ledger.record({
            ts: new Date().toISOString(),
            provider: protocol,
            model,
            ...(requestedModel && { requestedModel }),
            surface: "proxy",
            shaped,
            ...(isTruncated(body, protocol) && { truncated: true }),
            ...(compressionSavedTokens > 0 && { compressionSavedTokens }),
            tag: tagStr,
            costUSD: estimateCostUSD(
              model,
              usage.inputTokens,
              usage.outputTokens,
              usage.cacheReadTokens,
              DEFAULT_PRICING,
            ),
            droppedContextTokens: 0,
            ...usage,
          });
        }
      } else if (upstreamRes.status !== 429) {
        // A provider error (not a quota 429) is a guardrail signal: record it
        // labeled with the shaped/holdout group so auto-revert can compare.
        ledger.record({
          ts: new Date().toISOString(),
          provider: protocol,
          model,
          ...(requestedModel && { requestedModel }),
          surface: "proxy",
          shaped,
          ok: false,
          tag: tagStr,
          droppedContextTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      }
    }
  }
}

/** Detects a response truncated by the output cap (a guardrail quality signal). */
export function isTruncated(text: string, protocol: "anthropic" | "openai"): boolean {
  return protocol === "anthropic"
    ? /"stop_reason"\s*:\s*"max_tokens"/.test(text)
    : /"finish_reason"\s*:\s*"length"/.test(text);
}

/**
 * Turns provider rate-limit signals into ledger evidence for budget
 * calibration. A 429 is a hard observation (budget ≤ tokens used now).
 * Anthropic's `anthropic-ratelimit-unified-*` headers (undocumented — parsed
 * best-effort) can warn of an imminent limit on a 200, recorded as softer
 * evidence. Everything else is ignored.
 */
function recordLimitObservation(
  ledger: Ledger,
  settings: GovernorSettings,
  upstreamRes: Response,
  protocol: string,
  model: string,
): void {
  const status = upstreamRes.status;
  const unified = upstreamRes.headers.get("anthropic-ratelimit-unified-status");
  const warning = unified === "allowed_warning" || unified === "rejected";
  if (status !== 429 && !warning) return;

  const ratelimit: Record<string, string> = {};
  upstreamRes.headers.forEach((v, k) => {
    if (k.startsWith("anthropic-ratelimit-") || k === "retry-after") ratelimit[k] = v;
  });
  const retryAfterRaw = upstreamRes.headers.get("retry-after");
  const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : undefined;

  const ev: LimitEvent = {
    kind: "limit",
    ts: new Date().toISOString(),
    provider: protocol,
    status,
    ...(model && { model }),
    ...(retryAfterSec !== undefined && !Number.isNaN(retryAfterSec) && { retryAfterSec }),
    ...(Object.keys(ratelimit).length > 0 && { ratelimit }),
    usedAt: ledger.usedByWindow(settings),
  };
  ledger.recordLimit(ev);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Pulls token usage out of a JSON or SSE response body. Regex-based so it
 * works identically for streaming and non-streaming without full SSE parsing.
 */
export function extractUsage(
  text: string,
  protocol: "anthropic" | "openai",
): Usage | null {
  const last = (re: RegExp): number | null => {
    let m: RegExpExecArray | null;
    let v: number | null = null;
    while ((m = re.exec(text)) !== null) v = Number(m[1]);
    return v;
  };

  if (protocol === "anthropic") {
    const input = last(/"input_tokens"\s*:\s*(\d+)/g);
    const output = last(/"output_tokens"\s*:\s*(\d+)/g);
    if (input === null && output === null) return null;
    const cacheRead = last(/"cache_read_input_tokens"\s*:\s*(\d+)/g) ?? 0;
    const cacheWrite = last(/"cache_creation_input_tokens"\s*:\s*(\d+)/g) ?? 0;
    return {
      inputTokens: (input ?? 0) + cacheRead + cacheWrite,
      outputTokens: output ?? 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    };
  }

  const prompt = last(/"prompt_tokens"\s*:\s*(\d+)/g);
  const completion = last(/"completion_tokens"\s*:\s*(\d+)/g);
  if (prompt === null && completion === null) return null;
  return {
    inputTokens: prompt ?? 0,
    outputTokens: completion ?? 0,
    cacheReadTokens: last(/"cached_tokens"\s*:\s*(\d+)/g) ?? 0,
    cacheWriteTokens: 0,
  };
}
