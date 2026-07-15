import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeRunway, formatDuration } from "../dist/index.js";

// --- formatDuration ---
{
  assert.equal(formatDuration(0.5), "<1 min");
  assert.equal(formatDuration(45), "45 min");
  assert.equal(formatDuration(60), "1h");
  assert.equal(formatDuration(220), "3h 40m");
  assert.equal(formatDuration(1500), "1d 1h");
  assert.equal(formatDuration(2880), "2d");
}

// --- computeRunway: saved tokens ÷ burn = minutes bought ---
{
  const f = {
    window: { name: "5h", hours: 5, budgetTokens: 1_000_000 },
    usedTokens: 400_000,
    pct: 0.4,
    burnPerMin: 2_000,
    exhaustsAt: Date.now() + 300 * 60_000,
  };
  const rw = computeRunway(f, 120_000); // saved 120k tokens
  assert.equal(rw.runwayMin, 300, "(1,000,000 − 400,000) / 2,000 = 300 min current runway");
  assert.equal(rw.gainedMin, 60, "120,000 saved / 2,000 per min = +60 min bought");
  assert.equal(rw.savedTokens, 120_000);

  // idle → no rate to project against
  const idle = computeRunway({ ...f, burnPerMin: 0 }, 120_000);
  assert.equal(idle.runwayMin, null);
  assert.equal(idle.gainedMin, null);

  // exhausted window → 0 remaining, still a valid (0) runway
  const spent = computeRunway({ ...f, usedTokens: 1_200_000 }, 50_000);
  assert.equal(spent.runwayMin, 0, "over budget → 0 remaining");
}

console.log("✓ runway unit tests passed");

// --- CLI: status + report surface the runway line from a HOME-scoped ledger ---
{
  const home = mkdtempSync(join(tmpdir(), "limitbreak-runway-home-"));
  mkdirSync(join(home, ".limitbreak"), { recursive: true });
  writeFileSync(
    join(home, ".limitbreak", "config.json"),
    JSON.stringify({ windows: [{ name: "5h", hours: 5, budgetTokens: 1_000_000 }] }),
  );
  // Recent burn with real compression savings, so runway gained > 0.
  const now = Date.now();
  const rec = (minAgo, over) =>
    JSON.stringify({
      ts: new Date(now - minAgo * 60_000).toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 20_000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      droppedContextTokens: 0,
      compressionSavedTokens: 8_000,
      ...over,
    });
  writeFileSync(
    join(home, ".limitbreak", "usage.jsonl"),
    [rec(10), rec(5), rec(1)].join("\n") + "\n",
  );

  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const run = (args) =>
    execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8" });

  const status = run(["status"]);
  assert.ok(/runway\s+~/.test(status), `status shows current runway: ${status}`);
  assert.ok(status.includes("bought you +"), `status shows runway gained: ${status}`);

  const report = run(["report"]);
  assert.ok(report.includes("of runway before your"), `report headline shows minutes: ${report}`);

  const md = run(["report", "--markdown"]);
  assert.ok(/bought \+.*of runway/.test(md), `markdown headline shows minutes: ${md}`);
}

console.log("✓ runway cli tests passed");
console.log("✓ all runway tests passed");
