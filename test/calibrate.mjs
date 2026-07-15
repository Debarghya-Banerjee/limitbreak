import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ledger,
  DEFAULT_SETTINGS,
  assess,
  calibrateBudgets,
  effectiveWindows,
  createProxy,
} from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-cal-"));
const now = Date.now();
const windows = [
  { name: "5h", hours: 5, budgetTokens: 2_000_000 },
  { name: "7d", hours: 168, budgetTokens: 15_000_000 },
];
const ev = (status, usedAt, daysAgo = 0) => ({
  kind: "limit",
  ts: new Date(now - daysAgo * 86_400_000).toISOString(),
  provider: "anthropic",
  status,
  usedAt,
});

// --- min over evidence: a 429 caps the budget at tokens used ---
{
  const cal = calibrateBudgets(
    [ev(429, { "5h": 900_000 }), ev(429, { "5h": 850_000 }), ev(429, { "5h": 950_000 })],
    windows,
    now,
  );
  assert.equal(cal["5h"].budgetTokens, 850_000, "budget = min used-at across 429s");
  assert.equal(cal["5h"].source, "observed-429");
  assert.equal(cal["5h"].samples, 3);
  assert.equal(cal["7d"], null, "no evidence for 7d → null");
}

// --- decay: observations older than 14 days are ignored ---
{
  const cal = calibrateBudgets([ev(429, { "5h": 500_000 }, 20)], windows, now);
  assert.equal(cal["5h"], null, "stale 429 decays out");
}

// --- header warnings: need two, softer source ---
{
  const one = calibrateBudgets([ev(200, { "5h": 700_000 })], windows, now);
  assert.equal(one["5h"], null, "single warning is not enough");

  const two = calibrateBudgets(
    [ev(200, { "5h": 700_000 }), ev(200, { "5h": 680_000 })],
    windows,
    now,
  );
  assert.equal(two["5h"].budgetTokens, 680_000);
  assert.equal(two["5h"].source, "header-warning");

  // a single hard 429 outweighs the warning-count requirement
  const hard = calibrateBudgets([ev(429, { "5h": 600_000 })], windows, now);
  assert.equal(hard["5h"].budgetTokens, 600_000);
  assert.equal(hard["5h"].source, "observed-429");
}

// --- effectiveWindows: explicit user budgets and autoCalibrate=off both win ---
{
  const cal = { "5h": { budgetTokens: 900_000, source: "observed-429", observedAt: now, samples: 1 }, "7d": null };
  const auto = effectiveWindows({ ...DEFAULT_SETTINGS, windows, autoCalibrate: true, windowsExplicit: false }, cal);
  assert.equal(auto[0].budgetTokens, 900_000, "calibrated budget applied");
  assert.equal(auto[1].budgetTokens, 15_000_000, "uncalibrated window keeps default");

  const explicit = effectiveWindows({ ...DEFAULT_SETTINGS, windows, autoCalibrate: true, windowsExplicit: true }, cal);
  assert.equal(explicit[0].budgetTokens, 2_000_000, "explicit user windows override calibration");

  const off = effectiveWindows({ ...DEFAULT_SETTINGS, windows, autoCalibrate: false, windowsExplicit: false }, cal);
  assert.equal(off[0].budgetTokens, 2_000_000, "autoCalibrate off keeps defaults");
}

console.log("✓ calibrate unit tests passed");

// --- backward compat: an old-format ledger (no kind field) still loads ---
{
  const logPath = join(tmp, "old.jsonl");
  writeFileSync(
    logPath,
    JSON.stringify({ ts: new Date(now).toISOString(), inputTokens: 100, outputTokens: 50 }) + "\n",
  );
  const ledger = new Ledger(logPath);
  const [f] = ledger.forecasts({ ...DEFAULT_SETTINGS, windows: [windows[0]] }, now);
  assert.equal(f.usedTokens, 150, "usage lines still summed");
  assert.equal(ledger.limitEvents().length, 0, "no limit events in old file");
}

// --- e2e: a 429 from upstream records a limit event and calibrates the budget ---
{
  const upstream = createServer((req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "42",
      "anthropic-ratelimit-unified-status": "rejected",
    });
    res.end(JSON.stringify({ error: { type: "rate_limit_error" } }));
  });
  await new Promise((r) => upstream.listen(0, r));
  const upstreamPort = upstream.address().port;

  const logPath = join(tmp, "e2e.jsonl");
  // Seed 900k tokens already used in the 5h window so usedAt reflects it.
  writeFileSync(
    logPath,
    JSON.stringify({
      ts: new Date(now).toISOString(),
      provider: "anthropic",
      model: "m",
      inputTokens: 900_000,
      outputTokens: 0,
      droppedContextTokens: 0,
    }) + "\n",
  );
  const settings = {
    ...DEFAULT_SETTINGS,
    windows: [{ name: "5h", hours: 5, budgetTokens: 5_000_000 }],
    windowsExplicit: false,
    autoCalibrate: true,
    compression: { green: "off", yellow: "off", red: "off" },
    upstreams: { anthropic: `http://localhost:${upstreamPort}`, openai: `http://localhost:${upstreamPort}` },
  };
  const ledger = new Ledger(logPath);
  const proxy = createProxy({ ledger, settings, random: () => 0.99 });
  await new Promise((r) => proxy.listen(0, r));
  const proxyPort = proxy.address().port;

  const res = await fetch(`http://localhost:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-4-7", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 429, "429 passed through to client");

  const events = ledger.limitEvents();
  assert.equal(events.length, 1, "one limit event recorded");
  assert.equal(events[0].status, 429);
  assert.equal(events[0].retryAfterSec, 42);
  assert.equal(events[0].usedAt["5h"], 900_000, "usedAt snapshots in-window tokens");
  assert.equal(events[0].ratelimit["anthropic-ratelimit-unified-status"], "rejected");

  // Persisted to disk as kind:"limit".
  const persisted = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(persisted.some((r) => r.kind === "limit"), "limit line persisted");

  // A fresh ledger reading the same file calibrates the 5h budget down to 900k.
  const reloaded = new Ledger(logPath);
  const eff = reloaded.effectiveSettings(settings, now);
  assert.equal(eff.windows[0].budgetTokens, 900_000, "calibrated budget replaces the placeholder");
  const a = assess(reloaded.forecasts(eff, now), eff);
  assert.equal(a.level, "red", "900k/900k against calibrated budget = red");

  upstream.close();
  proxy.close();
}

console.log("✓ calibrate e2e passed");
console.log("✓ all calibrate tests passed");
