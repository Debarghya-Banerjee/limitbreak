import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpHandler,
  createProxy,
  DEFAULT_SETTINGS,
  Ledger,
  Memory,
  MEMORY_TEXT_LIMIT,
} from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-memory-"));

// --- remember / list round-trip ---
{
  const mem = new Memory(join(tmp, "a.jsonl"));
  const e = mem.remember({ text: "repo uses pnpm, not npm", tags: ["build"] });
  assert.match(e.id, /^[a-f0-9]{12}$/);
  const listed = mem.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].text, "repo uses pnpm, not npm");
  assert.deepEqual(listed[0].tags, ["build"]);
}

// --- key upsert replaces, keeps createdAt, and a fresh reader agrees ---
{
  const path = join(tmp, "b.jsonl");
  const mem = new Memory(path);
  const first = mem.remember({ text: "port is 3000", key: "dev-port" });
  const second = mem.remember({ text: "port is 8080", key: "dev-port" });
  assert.notEqual(first.id, second.id);
  assert.equal(second.createdAt, first.createdAt, "upsert preserves createdAt");
  assert.equal(mem.list().length, 1);
  assert.equal(mem.list()[0].text, "port is 8080");
  // Another process reading the same log sees the same state.
  assert.equal(new Memory(path).list()[0].text, "port is 8080");
}

// --- forget appends a tombstone that survives replay ---
{
  const path = join(tmp, "c.jsonl");
  const mem = new Memory(path);
  const e = mem.remember({ text: "to be deleted" });
  assert.equal(mem.forget(e.id), true);
  assert.equal(mem.list().length, 0);
  assert.equal(new Memory(path).list().length, 0, "tombstone persists");
  assert.equal(mem.forget(e.id), false, "double delete reports false");
  assert.equal(mem.forget("not-an-id"), false, "malformed id rejected");
}

// --- TTL: expired entries drop out at read time ---
{
  const path = join(tmp, "d.jsonl");
  const stale = {
    id: "aaaaaaaaaaaa",
    text: "old news",
    createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    ttlHours: 1,
  };
  writeFileSync(path, JSON.stringify(stale) + "\n");
  const mem = new Memory(path);
  assert.equal(mem.list().length, 0, "expired entry filtered");
  mem.remember({ text: "fresh", ttlHours: 1 });
  assert.equal(mem.list().length, 1);
}

// --- recall: ranking, tag filter, limit, empty-query recency ---
{
  const mem = new Memory(join(tmp, "e.jsonl"));
  mem.remember({ text: "database is postgres 16 on port 5433", tags: ["infra"] });
  mem.remember({ text: "frontend dev server needs NODE_OPTIONS tweak", tags: ["frontend"] });
  mem.remember({ text: "postgres migrations live in db/migrate", tags: ["infra"] });

  const hits = mem.recall("postgres port");
  assert.equal(hits[0].text, "database is postgres 16 on port 5433", "two-term match ranks first");
  assert.equal(hits.length, 2, "unrelated note not returned");

  assert.equal(mem.recall("postgres", { tag: "frontend" }).length, 0);
  assert.equal(mem.recall("postgres", { limit: 1 }).length, 1);

  const recent = mem.recall("");
  assert.equal(recent.length, 3);
  assert.equal(recent[0].text, "postgres migrations live in db/migrate", "empty query → newest first");
}

// --- garbage lines in the log are skipped, not fatal ---
{
  const path = join(tmp, "f.jsonl");
  const mem = new Memory(path);
  mem.remember({ text: "survivor" });
  appendFileSync(path, "not json\n" + JSON.stringify({ wat: true }) + "\n");
  assert.equal(mem.list().length, 1);
  assert.equal(mem.list()[0].text, "survivor");
}

// --- input validation ---
{
  const mem = new Memory(join(tmp, "g.jsonl"));
  assert.throws(() => mem.remember({ text: "   " }), /non-empty/);
  assert.throws(() => mem.remember({ text: "x".repeat(MEMORY_TEXT_LIMIT + 1) }), /exceeds/);
}

console.log("✓ memory unit tests passed");

// --- MCP tools: remember → recall across handlers (fresh reads) ---
{
  const cfgDir = mkdtempSync(join(tmpdir(), "limitbreak-memory-mcp-"));
  const handle = createMcpHandler({ configDir: cfgDir });
  const text = (res) => res.result.content[0].text;

  const saved = handle({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "limitbreak_remember", arguments: { text: "CI uses node 22", key: "ci-node", tags: ["ci"] } },
  });
  assert.ok(text(saved).startsWith("remembered ["), text(saved));
  assert.ok(text(saved).includes("CI uses node 22"));

  // A second handler (≈ another agent process) sees the note.
  const other = createMcpHandler({ configDir: cfgDir });
  const found = other({
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "limitbreak_recall", arguments: { query: "node version ci" } },
  });
  assert.ok(text(found).includes("CI uses node 22"), text(found));

  const none = other({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "limitbreak_recall", arguments: { query: "zzzunknown" } },
  });
  assert.equal(text(none), "no matching memories");

  const bad = handle({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "limitbreak_remember", arguments: {} },
  });
  assert.equal(bad.result.isError, true);
}

console.log("✓ memory mcp tests passed");

// --- proxy HTTP endpoints e2e ---
{
  const dir = mkdtempSync(join(tmpdir(), "limitbreak-memory-proxy-"));
  const logPath = join(dir, "usage.jsonl");
  writeFileSync(logPath, "");
  const memory = new Memory(join(dir, "memory.jsonl"));
  const proxy = createProxy({ ledger: new Ledger(logPath), settings: DEFAULT_SETTINGS, memory });
  await new Promise((r) => proxy.listen(0, r));
  const base = `http://localhost:${proxy.address().port}`;

  const post = await fetch(`${base}/memory`, {
    method: "POST",
    body: JSON.stringify({ text: "staging url is stage.example.com", tags: ["env"] }),
  });
  assert.equal(post.status, 200);
  const { entry } = await post.json();
  assert.match(entry.id, /^[a-f0-9]{12}$/);

  const badPost = await fetch(`${base}/memory`, { method: "POST", body: "{}" });
  assert.equal(badPost.status, 400);

  const search = await (await fetch(`${base}/memory?q=staging+url`)).json();
  assert.equal(search.entries.length, 1);
  assert.equal(search.entries[0].text, "staging url is stage.example.com");

  const all = await (await fetch(`${base}/memory`)).json();
  assert.equal(all.entries.length, 1, "GET without q lists all");

  const del = await fetch(`${base}/memory/${entry.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal((await (await fetch(`${base}/memory`)).json()).entries.length, 0);
  assert.equal((await fetch(`${base}/memory/${entry.id}`, { method: "DELETE" })).status, 404);

  const wrongMethod = await fetch(`${base}/memory`, { method: "PUT", body: "{}" });
  assert.equal(wrongMethod.status, 405);

  proxy.close();
}

console.log("✓ memory proxy e2e passed");
console.log("✓ all memory tests passed");
