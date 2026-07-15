import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Limitbreak, packContext, estimateTokens, aggregateUsage } from "../dist/index.js";

// --- context packing ---
{
  const big = "x".repeat(4000); // ~1000 tokens
  const packed = packContext(
    [
      { text: "rules", pinned: true },
      { text: big, priority: 1, label: "low" },
      { text: "important", priority: 5 },
    ],
    100,
  );
  assert.equal(packed.pinned, "rules");
  assert.ok(packed.volatile.includes("important"));
  assert.ok(!packed.volatile.includes("xxxx"), "over-budget item must be dropped");
  assert.ok(packed.droppedTokens >= 900);
}

// original order preserved among kept items (cache stability)
{
  const packed = packContext([
    { text: "B", priority: 1 },
    { text: "A", priority: 9 },
  ]);
  assert.equal(packed.volatile, "B\n\nA");
}
assert.equal(estimateTokens("abcd"), 1);

// --- routing + request assembly + telemetry, via mocked fetch ---
const tmp = mkdtempSync(join(tmpdir(), "limitbreak-"));
const logPath = join(tmp, "usage.jsonl");
let captured;
globalThis.fetch = async (url, opts) => {
  captured = { url, body: JSON.parse(opts.body) };
  return new Response(
    JSON.stringify({
      content: [{ type: "tool_use", input: { verdict: "good" } }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 0,
      },
    }),
    { status: 200 },
  );
};

const ai = new Limitbreak({
  providers: { anthropic: { apiKey: "test" } },
  budget: { maxInputTokens: 2000, maxOutputTokens: 300 },
  telemetry: logPath,
});

const res = await ai.complete({
  task: "classify",
  system: "You are a classifier.",
  context: [{ text: "guidelines", pinned: true }, "detail A"],
  prompt: "Classify this.",
  schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
  tag: "smoke",
});

assert.equal(captured.body.model, "claude-haiku-4-5", "classify must route to fast tier");
assert.equal(captured.body.max_tokens, 300);
assert.equal(captured.body.system[0].cache_control.type, "ephemeral");
assert.ok(captured.body.system[0].text.includes("guidelines"), "pinned context in cached prefix");
assert.ok(captured.body.messages[0].content.includes("detail A"));
assert.equal(captured.body.tool_choice.name, "emit");
assert.deepEqual(res.json, { verdict: "good" });
assert.equal(res.usage.cacheReadTokens, 90);
assert.ok(res.costUSD > 0);

// explicit tier + model override win over task routing
await ai.complete({ prompt: "hi", tier: "max" });
assert.equal(captured.body.model, "claude-opus-4-7");
await ai.complete({ prompt: "hi", model: "custom-model" });
assert.equal(captured.body.model, "custom-model");
// terse instruction present for unstructured calls
assert.ok(captured.body.system[0].text.includes("no preamble"));

// governor integration: red level downgrades task-routed tier, fails open
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/status")) {
      return new Response(JSON.stringify({ level: "red" }), { status: 200 });
    }
    return realFetch(url, opts);
  };
  const governed = new Limitbreak({
    providers: { anthropic: { apiKey: "test" } },
    telemetry: logPath,
    governor: { url: "http://localhost:9" },
  });
  await governed.complete({ prompt: "hi", task: "generate" }); // balanced → fast under red
  assert.equal(captured.body.model, "claude-haiku-4-5", "red pressure downgrades to fast");
  await governed.complete({ prompt: "hi", tier: "max" }); // explicit tier untouched
  assert.equal(captured.body.model, "claude-opus-4-7", "explicit tier never overridden");
  globalThis.fetch = realFetch;
}

// telemetry aggregation
const report = aggregateUsage(logPath);
assert.equal(report.calls, 5);
assert.equal(report.byTag["smoke"].calls, 1);
assert.ok(report.cacheHitRate > 0);

// --- CLI ---
const cli = join(import.meta.dirname, "..", "dist", "cli.js");
const out = execFileSync("node", [cli, "init"], { cwd: tmp, encoding: "utf8" });
assert.ok(out.includes("CLAUDE.md limitbreak block added"));
assert.ok(existsSync(join(tmp, ".limitbreak", "playbooks", "principles.md")));
const claudeMd = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
assert.ok(claudeMd.includes("<!-- limitbreak:start -->"));

// idempotent re-init
execFileSync("node", [cli, "init"], { cwd: tmp, encoding: "utf8" });
const claudeMd2 = readFileSync(join(tmp, "CLAUDE.md"), "utf8");
assert.equal(
  claudeMd2.split("<!-- limitbreak:start -->").length, 2,
  "re-init must not duplicate the block",
);

const reportOut = execFileSync("node", [cli, "report", logPath], { cwd: tmp, encoding: "utf8" });
assert.ok(reportOut.includes("hit rate"));

console.log("✓ all smoke tests passed");
