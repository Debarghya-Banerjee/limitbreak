import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compress,
  compressToolResults,
  compressLog,
  headTail,
  estimateTokens,
  Store,
  Ledger,
  DEFAULT_SETTINGS,
  createProxy,
} from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-cmp-"));

// --- store: reversibility ---
{
  const store = new Store(join(tmp, "store"));
  const id = store.save("original content");
  assert.match(id, /^[a-f0-9]{12}$/);
  assert.equal(store.load(id), "original content");
  assert.equal(store.save("original content"), id, "content-addressed: same input, same id");
  assert.equal(store.load("../etc/passwd"), null, "path traversal rejected");
  assert.equal(store.load("ffffffffffff"), null, "unknown id → null");
}

// --- compress: small content untouched ---
{
  const r = compress("tiny", "aggressive");
  assert.equal(r.changed, false);
  assert.equal(r.text, "tiny");
  assert.equal(compress("x".repeat(100_000), "off").changed, false, "off = never");
}

// --- compress: determinism (cache alignment depends on it) ---
{
  const big = JSON.stringify({ items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `row-${i}`, data: "d".repeat(50) })) });
  const a = compress(big, "standard");
  const b = compress(big, "standard");
  assert.equal(a.text, b.text, "same input must compress to identical bytes");
  assert.ok(a.changed);
  assert.ok(a.finalTokens < a.originalTokens * 0.5, "JSON should compress hard");
}

// --- compress: JSON array elision keeps head + last ---
{
  const arr = Array.from({ length: 300 }, (_, i) => `item-${i}`);
  const r = compress(JSON.stringify(arr), "aggressive");
  assert.ok(r.text.includes("item-0"));
  assert.ok(r.text.includes("item-299"), "last item survives");
  assert.ok(r.text.includes("items elided"));
}

// --- compress: logs keep errors verbatim, collapse duplicates ---
{
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(`2026-07-06 10:00:${String(i % 60).padStart(2, "0")} INFO routine heartbeat check passed for service worker`);
  for (let i = 0; i < 50; i++) lines.push("2026-07-06 10:01:00 DEBUG cache warm");
  lines.push("2026-07-06 10:02:00 ERROR connection refused to db-primary:5432 after 3 retries");
  const r = compress(lines.join("\n"), "standard");
  assert.ok(r.changed);
  assert.ok(r.text.includes("connection refused to db-primary:5432"), "error line kept verbatim");
  assert.ok(r.text.includes("[×50]"), "duplicate lines collapsed with count");
}
{
  // pure compressLog: important lines win even over budget
  const out = compressLog("ERROR a\n".repeat(5) + "INFO b\n".repeat(1000), 50);
  assert.ok(out.includes("ERROR a"));
}

// --- headTail ---
{
  const text = "A".repeat(5000) + "MIDDLE" + "Z".repeat(5000);
  const out = headTail(text, 100);
  assert.ok(out.startsWith("A"));
  assert.ok(out.endsWith("Z"));
  assert.ok(out.includes("chars elided"));
  assert.ok(estimateTokens(out) <= 110);
}

// --- compress: reversibility note with store id ---
{
  const store = new Store(join(tmp, "store2"));
  const big = "line of prose content here\n".repeat(500);
  const r = compress(big, "standard", { save: (t) => store.save(t) });
  assert.ok(r.changed);
  assert.ok(r.storeId);
  assert.ok(r.text.includes(`retrieve id ${r.storeId}`));
  assert.equal(store.load(r.storeId), big, "original fully recoverable");
}

// --- compressToolResults: anthropic + openai bodies ---
{
  const bigText = "tool output data row\n".repeat(400);
  const body = {
    model: "m",
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigText }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: bigText }] }] },
      { role: "user", content: "plain user text stays" },
    ],
  };
  const saved = compressToolResults(body, "anthropic", "standard", { minTokens: 100 });
  assert.ok(saved > 0, "reported savings");
  assert.ok(body.messages[0].content[0].content.includes("limitbreak: compressed"));
  assert.ok(body.messages[1].content[0].content[0].text.includes("limitbreak: compressed"));
  assert.equal(body.messages[2].content, "plain user text stays");

  const oaBody = {
    model: "m",
    messages: [
      { role: "tool", tool_call_id: "t", content: bigText },
      { role: "user", content: "untouched" },
    ],
  };
  const oaSaved = compressToolResults(oaBody, "openai", "aggressive", { minTokens: 100 });
  assert.ok(oaSaved > 0);
  assert.ok(oaBody.messages[0].content.includes("limitbreak: compressed"));
  assert.equal(oaBody.messages[1].content, "untouched");

  assert.equal(compressToolResults(body, "anthropic", "off", { minTokens: 100 }), 0);
}

// --- proxy: green-level light compression + retrieval endpoint ---
{
  let seenBody;
  const upstream = createServer((req, res) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seenBody = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const upPort = upstream.address().port;

  const logPath = join(tmp, "proxy.jsonl");
  writeFileSync(logPath, "");
  const store = new Store(join(tmp, "store3"));
  const proxy = createProxy({
    ledger: new Ledger(logPath),
    settings: {
      ...DEFAULT_SETTINGS,
      windows: [{ name: "5h", hours: 5, budgetTokens: 1_000_000 }], // green
      compressMinTokens: 100,
      upstreams: { anthropic: `http://localhost:${upPort}`, openai: `http://localhost:${upPort}` },
    },
    random: () => 0.99,
    store,
  });
  await new Promise((r) => proxy.listen(0, r));
  const port = proxy.address().port;

  const bigToolOutput = "very long tool output line\n".repeat(1000);
  await fetch(`http://localhost:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: bigToolOutput }] }],
    }),
  });
  const sent = seenBody.messages[0].content[0].content;
  assert.ok(sent.length < bigToolOutput.length / 2, "tool result compressed at green (light)");
  const idMatch = sent.match(/retrieve id ([a-f0-9]{12})/);
  assert.ok(idMatch, "compressed block carries a retrieval id");

  const retrieved = await fetch(`http://localhost:${port}/retrieve/${idMatch[1]}`);
  assert.equal(retrieved.status, 200);
  assert.equal(await retrieved.text(), bigToolOutput, "original recoverable over HTTP");

  assert.equal((await fetch(`http://localhost:${port}/retrieve/nope`)).status, 404);

  proxy.close();
  upstream.close();
}

console.log("✓ all compression tests passed");
