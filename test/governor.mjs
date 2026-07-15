import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ledger,
  DEFAULT_SETTINGS,
  assess,
  shape,
  createProxy,
  extractUsage,
  Store,
  TERSE_STEER,
} from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-gov-"));
const now = Date.now();

const settings = {
  ...DEFAULT_SETTINGS,
  windows: [{ name: "5h", hours: 5, budgetTokens: 1000 }],
  holdout: 0.1,
  downgrade: { "claude-opus-4-7": "claude-sonnet-4-6" },
  compression: { green: "off", yellow: "off", red: "off" }, // isolated from compress tests
};

// --- ledger: windowing + forecast math ---
{
  const logPath = join(tmp, "ledger.jsonl");
  const rec = (minAgo, inTok, outTok) =>
    JSON.stringify({
      ts: new Date(now - minAgo * 60_000).toISOString(),
      inputTokens: inTok,
      outputTokens: outTok,
    });
  writeFileSync(
    logPath,
    [
      rec(400, 500, 100),   // outside 5h window (300 min)
      rec(20, 300, 50),     // inside window + inside 30m burn lookback
      rec(10, 100, 50),     // inside both
    ].join("\n") + "\n",
  );
  const ledger = new Ledger(logPath);
  const [f] = ledger.forecasts(settings, now);
  assert.equal(f.usedTokens, 500, "only in-window entries count");
  assert.equal(f.pct, 0.5);
  assert.ok(Math.abs(f.burnPerMin - 500 / 30) < 0.01, "burn = trailing 30m / 30");
  const minsOut = (f.exhaustsAt - now) / 60_000;
  assert.ok(Math.abs(minsOut - 30) < 1, `exhaustion forecast ~30min, got ${minsOut}`);

  // level transitions
  assert.equal(assess(ledger.forecasts(settings, now), settings).level, "green");
  ledger.record({ ts: new Date(now).toISOString(), provider: "anthropic", model: "m", inputTokens: 250, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, droppedContextTokens: 0 });
  assert.equal(assess(ledger.forecasts(settings, now), settings).level, "yellow"); // 750/1000
  ledger.record({ ts: new Date(now).toISOString(), provider: "anthropic", model: "m", inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, droppedContextTokens: 0 });
  assert.equal(assess(ledger.forecasts(settings, now), settings).level, "red"); // 950/1000
}

// --- governor: shaping ---
{
  const yellow = { level: "yellow", worst: null, forecasts: [] };
  const red = { level: "red", worst: null, forecasts: [] };
  const green = { level: "green", worst: null, forecasts: [] };
  const base = { model: "claude-opus-4-7", system: "rules", messages: [{ role: "user", content: "hi" }] };

  assert.equal(shape(base, green, settings, { holdoutRoll: 0.9, deferrable: false, protocol: "anthropic" }).shaped, false);

  const held = shape(base, yellow, settings, { holdoutRoll: 0.05, deferrable: false, protocol: "anthropic" });
  assert.equal(held.shaped, false);
  assert.equal(held.body.model, "claude-opus-4-7");

  const shaped = shape(base, yellow, settings, { holdoutRoll: 0.9, deferrable: false, protocol: "anthropic" });
  assert.equal(shaped.shaped, true);
  assert.equal(shaped.body.model, "claude-sonnet-4-6");
  assert.ok(shaped.body.system.endsWith(TERSE_STEER), "steer appended as suffix (cache-safe)");
  assert.ok(shaped.body.system.startsWith("rules"), "original system preserved as prefix");
  assert.equal(base.model, "claude-opus-4-7", "input body not mutated");

  const arr = shape({ model: "m", system: [{ type: "text", text: "x" }] }, yellow, settings, { holdoutRoll: 0.9, deferrable: false, protocol: "anthropic" });
  assert.equal(arr.body.system.length, 2);
  assert.equal(arr.body.system[1].text, TERSE_STEER);

  const oa = shape({ model: "m", messages: [{ role: "user", content: "hi" }] }, yellow, settings, { holdoutRoll: 0.9, deferrable: false, protocol: "openai" });
  assert.equal(oa.body.messages.at(-1).role, "system");

  const def = shape(base, red, settings, { holdoutRoll: 0.9, deferrable: true, protocol: "anthropic", retryAfterMs: 120000 });
  assert.deepEqual(def.defer, { retryAfterMs: 120000 });

  const redPass = shape(base, red, settings, { holdoutRoll: 0.9, deferrable: false, protocol: "anthropic" });
  assert.equal(redPass.defer, undefined);
  assert.equal(redPass.shaped, true);
}

// --- usage extraction (JSON + SSE) ---
{
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":10}}}',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":7}}',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":55}}',
  ].join("\n");
  const u = extractUsage(sse, "anthropic");
  assert.equal(u.inputTokens, 150);
  assert.equal(u.outputTokens, 55, "last output_tokens value wins");
  assert.equal(u.cacheReadTokens, 40);

  const oa = extractUsage('{"usage":{"prompt_tokens":20,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":5}}}', "openai");
  assert.equal(oa.inputTokens, 20);
  assert.equal(oa.outputTokens, 9);
  assert.equal(oa.cacheReadTokens, 5);

  assert.equal(extractUsage("no usage here", "anthropic"), null);
}

// --- proxy e2e against a mock upstream ---
{
  let seenBody;
  let seenAuth;
  const upstream = createServer((req, res) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString());
      seenAuth = req.headers["x-api-key"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 100, output_tokens: 30 },
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const upPort = upstream.address().port;

  // seed ledger to yellow (750 of 1000 in-window)
  const logPath = join(tmp, "proxy.jsonl");
  writeFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), inputTokens: 700, outputTokens: 50 }) + "\n");
  const ledger = new Ledger(logPath);
  const proxySettings = { ...settings, upstreams: { anthropic: `http://localhost:${upPort}`, openai: `http://localhost:${upPort}` } };

  const proxy = createProxy({
    ledger,
    settings: proxySettings,
    random: () => 0.99, // never holdout
    store: new Store(join(tmp, "store")),
  });
  await new Promise((r) => proxy.listen(0, r));
  const port = proxy.address().port;

  const st = await (await fetch(`http://localhost:${port}/status`)).json();
  assert.equal(st.level, "yellow");

  const res = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-test", "x-limitbreak-tag": "e2e" },
    body: JSON.stringify({ model: "claude-opus-4-7", system: "s", messages: [], max_tokens: 10 }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, "ok");
  assert.equal(seenAuth, "sk-test", "auth header forwarded");
  assert.equal(seenBody.model, "claude-sonnet-4-6", "downgraded in flight");
  assert.ok(seenBody.system.includes(TERSE_STEER));

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.surface, "proxy");
  assert.equal(last.shaped, true);
  assert.equal(last.tag, "e2e");
  assert.equal(last.inputTokens, 100);
  assert.equal(last.outputTokens, 30);

  // push to red, deferrable request → 429 with retry-after
  ledger.record({ ts: new Date().toISOString(), provider: "anthropic", model: "m", inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, droppedContextTokens: 0 });
  const deferred = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-limitbreak-defer": "allow" },
    body: JSON.stringify({ model: "claude-opus-4-7", messages: [] }),
  });
  assert.equal(deferred.status, 429);
  assert.ok(Number(deferred.headers.get("retry-after")) >= 60);
  assert.ok((await deferred.json()).retryAfterMs >= 60_000);

  // non-deferrable red request still goes through
  const redPass = await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-4-7", messages: [] }),
  });
  assert.equal(redPass.status, 200);

  proxy.close();
  upstream.close();
}

console.log("✓ all governor tests passed");
