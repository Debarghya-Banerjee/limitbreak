import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, DEFAULT_SETTINGS, createProxy, Store, buildStats } from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-dash-"));
const now = Date.now();
const logPath = join(tmp, "usage.jsonl");

// Seed recent burn + real compression savings so runway gained > 0.
const rec = (minAgo) =>
  JSON.stringify({
    ts: new Date(now - minAgo * 60_000).toISOString(),
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputTokens: 30_000,
    outputTokens: 400,
    cacheReadTokens: 5_000,
    cacheWriteTokens: 0,
    droppedContextTokens: 0,
    compressionSavedTokens: 9_000,
    shaped: true,
  });
writeFileSync(logPath, [rec(12), rec(6), rec(1)].join("\n") + "\n");

const settings = {
  ...DEFAULT_SETTINGS,
  windows: [{ name: "5h", hours: 5, budgetTokens: 1_000_000 }],
  windowsExplicit: true,
};

// --- buildStats payload ---
{
  const stats = buildStats(new Ledger(logPath), settings);
  assert.ok(["green", "yellow", "red"].includes(stats.level));
  assert.equal(stats.windows.length, 1);
  assert.equal(stats.windows[0].name, "5h");
  assert.ok(stats.windows[0].usedTokens > 0);
  assert.ok(stats.burnPerMin > 0, "recent records → burn");
  assert.ok(stats.runway, "worst window → runway present");
  assert.ok(stats.runway.gainedMin > 0, "savings + burn → runway gained");
  assert.equal(stats.savings.compressionSavedTokens, 27_000, "3 × 9k saved");
  assert.ok(stats.savings.tokensSaved >= 27_000);
  assert.equal(typeof stats.guardrails.enabled, "boolean");
}

console.log("✓ buildStats tests passed");

// --- proxy serves the dashboard HTML + /stats JSON ---
{
  const proxy = createProxy({ ledger: new Ledger(logPath), settings, store: new Store(join(tmp, "store")) });
  await new Promise((r) => proxy.listen(0, r));
  const port = proxy.address().port;

  const html = await fetch(`http://localhost:${port}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type"), /text\/html/);
  const body = await html.text();
  assert.ok(body.includes("<title>limitbreak</title>"), "serves the page");
  assert.ok(body.includes("/stats"), "page polls the stats endpoint");
  assert.ok(!/https?:\/\/(?!localhost)/.test(body.replace(/lang="en"/, "")), "no external asset URLs (self-contained)");

  const statsRes = await fetch(`http://localhost:${port}/stats`);
  assert.equal(statsRes.status, 200);
  assert.match(statsRes.headers.get("content-type"), /application\/json/);
  const stats = await statsRes.json();
  assert.equal(stats.windows[0].name, "5h");
  assert.ok(stats.runway.gainedMin > 0);

  // /dashboard alias also works
  assert.equal((await fetch(`http://localhost:${port}/dashboard`)).status, 200);

  proxy.close();
  console.log("✓ dashboard proxy tests passed");
}

console.log("✓ all dashboard tests passed");
