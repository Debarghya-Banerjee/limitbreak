import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler, Store } from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-mcp-"));
const now = Date.now();

// Seed a config dir: config, ledger, store.
mkdirSync(tmp, { recursive: true });
writeFileSync(
  join(tmp, "config.json"),
  JSON.stringify({ windows: [{ name: "5h", hours: 5, budgetTokens: 1000 }] }),
);
writeFileSync(
  join(tmp, "usage.jsonl"),
  [
    JSON.stringify({
      ts: new Date(now - 10 * 60_000).toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 150,
      cacheWriteTokens: 0,
      droppedContextTokens: 0,
      costUSD: 0.01,
    }),
    JSON.stringify({
      ts: new Date(now - 30 * 86_400_000).toISOString(), // 30 days old
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 999,
      outputTokens: 999,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      droppedContextTokens: 0,
    }),
  ].join("\n") + "\n",
);
const store = new Store(join(tmp, "store"));
const storedId = store.save("the original uncompressed content");

const handle = createMcpHandler({ configDir: tmp });
const text = (res) => res.result.content[0].text;

// --- initialize: echoes known client version, advertises tools ---
{
  const res = handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2025-03-26", "echoes recognized client version");
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.equal(res.result.serverInfo.name, "limitbreak");

  const unknown = handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(unknown.result.protocolVersion, "2025-06-18", "falls back to latest for unknown versions");
}

// --- notifications get no response; unknown methods error ---
{
  assert.equal(handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const res = handle({ jsonrpc: "2.0", id: 3, method: "no/such/method" });
  assert.equal(res.error.code, -32601);
  assert.deepEqual(handle({ jsonrpc: "2.0", id: 4, method: "ping" }).result, {});
}

// --- tools/list ---
{
  const res = handle({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  const names = res.result.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "limitbreak_status",
    "limitbreak_retrieve",
    "limitbreak_remember",
    "limitbreak_recall",
    "limitbreak_report",
    "limitbreak_team_plan",
    "limitbreak_lease_spend",
    "limitbreak_lease_close",
    "limitbreak_team_status",
    "limitbreak_team_report",
  ]);
  for (const t of res.result.tools) assert.equal(t.inputSchema.type, "object");
}

// --- limitbreak_status reads the seeded ledger ---
{
  const res = handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "limitbreak_status", arguments: {} } });
  const out = text(res);
  assert.ok(out.includes("runway:"), out);
  assert.ok(out.includes("5h"), "window name present");
  assert.ok(out.includes("400/1000"), `in-window usage (300+100 of 1000): ${out}`);
}

// --- limitbreak_retrieve round-trips the store ---
{
  const res = handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "limitbreak_retrieve", arguments: { id: storedId } } });
  assert.equal(text(res), "the original uncompressed content");

  const missing = handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "limitbreak_retrieve", arguments: { id: "aaaaaaaaaaaa" } } });
  assert.equal(missing.result.isError, true);

  const badArgs = handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "limitbreak_retrieve", arguments: {} } });
  assert.equal(badArgs.result.isError, true);
}

// --- limitbreak_report aggregates, honors since ---
{
  const all = handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "limitbreak_report", arguments: {} } });
  assert.equal(JSON.parse(text(all)).calls, 2);

  const recent = handle({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "limitbreak_report", arguments: { since: "7d" } } });
  assert.equal(JSON.parse(text(recent)).calls, 1, "30-day-old record filtered out");

  const bad = handle({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "limitbreak_report", arguments: { since: "soon" } } });
  assert.equal(bad.result.isError, true);
}

// --- unknown tool ---
{
  const res = handle({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "nope", arguments: {} } });
  assert.equal(res.result.isError, true);
}

console.log("✓ mcp handler tests passed");

// --- e2e: spawn `cli.js mcp`, drive newline JSON-RPC over stdio ---
{
  const home = mkdtempSync(join(tmpdir(), "limitbreak-mcp-home-"));
  const cfg = join(home, ".limitbreak");
  mkdirSync(join(cfg, "store"), { recursive: true });
  writeFileSync(join(cfg, "config.json"), JSON.stringify({ windows: [{ name: "5h", hours: 5, budgetTokens: 1000 }] }));
  writeFileSync(
    join(cfg, "usage.jsonl"),
    JSON.stringify({
      ts: new Date().toISOString(),
      provider: "anthropic",
      model: "m",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      droppedContextTokens: 0,
    }) + "\n",
  );
  const id = new Store(join(cfg, "store")).save("e2e original");

  const child = spawn(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, "mcp"], {
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const lines = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "limitbreak_retrieve", arguments: { id } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "limitbreak_status", arguments: {} } });

  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`mcp e2e timeout; got ${lines.length} responses`)), 10_000);
    const check = setInterval(() => {
      if (lines.length >= 4) {
        clearTimeout(deadline);
        clearInterval(check);
        resolve();
      }
    }, 25);
  });
  child.kill();

  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(byId[1].result.protocolVersion, "2025-06-18");
  assert.equal(byId[2].result.tools.length, 10);
  assert.equal(byId[3].result.content[0].text, "e2e original");
  assert.ok(byId[4].result.content[0].text.includes("150/1000"), "status uses HOME-based ledger");
  console.log("✓ mcp stdio e2e passed");
}

console.log("✓ all mcp tests passed");
