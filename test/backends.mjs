import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  DEFAULT_SETTINGS,
  builtinBackend,
  externalBackend,
  makeCompressionBackend,
  createProxy,
  Ledger,
  estimateTokens,
} from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-backends-"));

// A stand-in "external compressor" (imagine headroom): read stdin, emit a tiny
// deterministic summary that echoes the {budget} arg to prove substitution.
const SHIM =
  "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write('SHIM['+process.argv[1]+']:'+d.slice(0,40)))";
const shimCmd = [process.execPath, "-e", SHIM, "{budget}"];

// A big log tool-result that comfortably exceeds the compression budget.
const logLines = [];
for (let i = 0; i < 80; i++) {
  logLines.push(`2026-07-07 09:${String(i % 60).padStart(2, "0")}:00 INFO handled req id=${1000 + i} in ${10 + (i % 7)}ms`);
}
logLines.push("2026-07-07 09:30:00 ERROR upstream timeout after 30000ms");
const bigLog = logLines.join("\n");

const makeBody = () => ({
  model: "claude-opus-4-7",
  messages: [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigLog }] },
  ],
});

const origTokens = estimateTokens(bigLog);

// --- builtin backend: unchanged behavior, reversible ---
{
  const store = new Store(join(tmp, "store-builtin"));
  const body = makeBody();
  const saved = await builtinBackend.compress(body, "anthropic", "aggressive", {
    minTokens: 200,
    save: (t) => store.save(t),
  });
  const out = body.messages[0].content[0].content;
  assert.ok(saved > 0, "builtin saved tokens");
  assert.ok(/\[limitbreak: compressed \d+→\d+ tokens/.test(out), "marker present");
  const id = /retrieve id ([a-f0-9]{12})/.exec(out)[1];
  assert.equal(store.load(id), bigLog, "original recoverable (reversible)");
}

// --- external backend: drives the shim, limitbreak keeps store+marker+accounting ---
{
  const store = new Store(join(tmp, "store-ext"));
  const backend = externalBackend({ command: shimCmd });
  assert.equal(backend.name, `external(${process.execPath})`);
  const body = makeBody();
  const saved = await backend.compress(body, "anthropic", "aggressive", {
    minTokens: 200,
    save: (t) => store.save(t),
  });
  const out = body.messages[0].content[0].content;
  assert.ok(saved > 0, "external saved tokens");
  assert.ok(out.startsWith("SHIM[250]:"), `external tool ran + {budget} substituted: ${out.slice(0, 20)}`);
  assert.ok(/\[limitbreak: compressed \d+→\d+ tokens/.test(out), "limitbreak still wrote the marker");
  const id = /retrieve id ([a-f0-9]{12})/.exec(out)[1];
  assert.equal(store.load(id), bigLog, "original stored by limitbreak, not the backend");
  const savedShouldBe = origTokens - estimateTokens(out);
  assert.equal(saved, savedShouldBe, "token accounting matches marker-inclusive final size");
}

// --- external failure falls back to passthrough, never throws ---
{
  const failing = externalBackend({ command: [process.execPath, "-e", "process.exit(1)"] });
  const body = makeBody();
  const saved = await failing.compress(body, "anthropic", "aggressive", { minTokens: 200 });
  assert.equal(saved, 0, "no savings when backend fails");
  assert.equal(body.messages[0].content[0].content, bigLog, "block passed through untouched");

  // a hanging backend is killed by the timeout and also falls back
  const hanging = externalBackend({ command: [process.execPath, "-e", "setInterval(()=>{},1e9)"], timeoutMs: 300 });
  const body2 = makeBody();
  const saved2 = await hanging.compress(body2, "anthropic", "aggressive", { minTokens: 200 });
  assert.equal(saved2, 0, "timeout → passthrough");
  assert.equal(body2.messages[0].content[0].content, bigLog);
}

// --- makeCompressionBackend selection ---
{
  assert.equal(makeCompressionBackend(undefined), builtinBackend);
  assert.equal(makeCompressionBackend("builtin"), builtinBackend);
  assert.equal(makeCompressionBackend({ command: shimCmd }).name, `external(${process.execPath})`);
  // "off" intensity short-circuits regardless of backend
  const body = makeBody();
  assert.equal(await externalBackend({ command: shimCmd }).compress(body, "anthropic", "off", { minTokens: 200 }), 0);
  assert.equal(body.messages[0].content[0].content, bigLog, "off = untouched");
}

console.log("✓ backend unit tests passed");

// --- e2e: proxy configured with the external backend feeds the shim in-flight ---
{
  let received = null;
  const upstream = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      received = JSON.parse(b);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", usage: { input_tokens: 100, output_tokens: 10 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const upPort = upstream.address().port;

  const settings = {
    ...DEFAULT_SETTINGS,
    windows: [{ name: "5h", hours: 5, budgetTokens: 10_000_000 }], // green
    windowsExplicit: true,
    compression: { green: "aggressive", yellow: "aggressive", red: "aggressive" },
    compressMinTokens: 100,
    compressionBackend: { command: shimCmd },
    upstreams: { anthropic: `http://localhost:${upPort}`, openai: `http://localhost:${upPort}` },
  };
  const ledger = new Ledger(join(tmp, "e2e.jsonl"));
  const proxy = createProxy({ ledger, settings, store: new Store(join(tmp, "store-e2e")) });
  await new Promise((r) => proxy.listen(0, r));
  const pxPort = proxy.address().port;

  await fetch(`http://localhost:${pxPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(makeBody()),
  });

  const sentTR = received.messages[0].content[0].content;
  assert.ok(sentTR.startsWith("SHIM["), "upstream received externally-compressed tool_result");
  assert.ok(sentTR.includes("retrieve id "), "with limitbreak's reversibility marker");
  assert.ok(estimateTokens(sentTR) < origTokens, "and it's smaller than the original");

  upstream.close();
  proxy.close();
  console.log("✓ backend proxy e2e passed");
}

console.log("✓ all backend tests passed");
