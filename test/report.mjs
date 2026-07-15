import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage, parseDuration } from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-report-"));
const now = Date.now();

// --- parseDuration ---
{
  assert.equal(parseDuration("7d"), 7 * 86_400_000);
  assert.equal(parseDuration("24h"), 24 * 3_600_000);
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration("5"), null);
}

const usage = (over) => ({
  ts: new Date(now).toISOString(),
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  droppedContextTokens: 0,
  ...over,
});

const logPath = join(tmp, "usage.jsonl");
writeFileSync(
  logPath,
  [
    // downgrade: requested opus, actually ran sonnet on 1000 in / 200 out.
    // opus would cost (1000*5 + 200*25)/1e6 = 0.01; sonnet actual costUSD 0.006.
    usage({ requestedModel: "claude-opus-4-7", costUSD: 0.006 }),
    // compression saved 2000 input tokens on sonnet ($3/MTok) → $0.006.
    usage({ compressionSavedTokens: 2000, costUSD: 0.006 }),
    // shaped vs holdout output averages.
    usage({ shaped: true, outputTokens: 100, costUSD: 0.005 }),
    usage({ shaped: false, outputTokens: 300, costUSD: 0.007 }),
    // a rate-limit observation line (must be counted separately, not as a call).
    { kind: "limit", ts: new Date(now).toISOString(), provider: "anthropic", status: 429, usedAt: { "5h": 900 } },
    // an old record for --since filtering.
    usage({ ts: new Date(now - 30 * 86_400_000).toISOString() }),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n",
);

// --- aggregate: savings math + since filter + limit lines excluded from calls ---
{
  const all = aggregateUsage(logPath);
  assert.equal(all.calls, 5, "5 usage records (limit line excluded)");
  assert.equal(all.limitEvents, 1, "one limit observation counted");

  // downgrade: opus cost 0.01 − actual 0.006 = 0.004.
  assert.ok(Math.abs(all.downgradeSavedUSD - 0.004) < 1e-9, `downgradeSavedUSD=${all.downgradeSavedUSD}`);
  // compression: 2000 tok × $3/MTok = 0.006.
  assert.ok(Math.abs(all.compressionSavedUSD - 0.006) < 1e-9, `compressionSavedUSD=${all.compressionSavedUSD}`);
  assert.equal(all.compressionSavedTokens, 2000);
  // shaping: holdoutAvg 300 − shapedAvg 100 = 200 × 1 shaped call.
  assert.equal(all.shapingSavedTokens, 200);

  const recent = aggregateUsage(logPath, { sinceMs: now - parseDuration("7d") });
  assert.equal(recent.calls, 4, "30-day-old record filtered out by --since 7d");

  // all models here are priced (sonnet/opus known) → cost is complete
  assert.equal(all.costComplete, true, "known models → cost complete");
  assert.deepEqual(all.unpricedModels, []);
}

// --- unpriced model: cost is n/a, not a silent $0; tokens still exact ---
{
  const unpricedPath = join(tmp, "unpriced.jsonl");
  writeFileSync(
    unpricedPath,
    JSON.stringify(usage({ model: "claude-opus-4-8", inputTokens: 5000, outputTokens: 100 })) + "\n",
  );
  const bare = aggregateUsage(unpricedPath);
  assert.equal(bare.costComplete, false, "unknown model → cost incomplete");
  assert.deepEqual(bare.unpricedModels, ["claude-opus-4-8"]);
  assert.equal(bare.costUSD, 0, "no price → contributes 0, but flagged");
  assert.equal(bare.inputTokens, 5000, "tokens still exact");

  // supplying a price via opts makes cost complete and valued
  const priced = aggregateUsage(unpricedPath, { pricing: { "claude-opus-4-8": [5, 25] } });
  assert.equal(priced.costComplete, true, "config pricing fills the gap retroactively");
  assert.deepEqual(priced.unpricedModels, []);
  assert.ok(Math.abs(priced.costUSD - (5000 * 5 + 100 * 25) / 1_000_000) < 1e-9);
}

console.log("✓ report aggregate tests passed");

// --- CLI: terminal headline + markdown, via HOME-scoped global ledger ---
{
  const home = mkdtempSync(join(tmpdir(), "limitbreak-report-home-"));
  mkdirSync(join(home, ".limitbreak"), { recursive: true });
  // Reuse the same fixture at the global path.
  writeFileSync(join(home, ".limitbreak", "usage.jsonl"), readFileSync(logPath, "utf8"));

  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const run = (args) =>
    execFileSync(process.execPath, [cli, "report", ...args], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });

  const term = run([]);
  assert.ok(term.includes("saved"), "headline present");
  assert.ok(term.includes("bought"), "runway headline present");
  assert.ok(term.includes("rate-limit observation"), "limit note present");

  const md = run(["--markdown", "--since", "7d"]);
  assert.ok(md.includes("## limitbreak savings — last 7d"), md);
  assert.ok(md.includes("| Metric | Value |"), "markdown table header");
  assert.ok(md.includes("| Downgrade saved |"), "downgrade row");

  // invalid --since exits non-zero
  let threw = false;
  try {
    run(["--since", "nope"]);
  } catch {
    threw = true;
  }
  assert.ok(threw, "invalid --since exits non-zero");

  // unpriced model → terminal shows n/a + guidance, not $0
  const home2 = mkdtempSync(join(tmpdir(), "limitbreak-report-home2-"));
  mkdirSync(join(home2, ".limitbreak"), { recursive: true });
  writeFileSync(
    join(home2, ".limitbreak", "usage.jsonl"),
    JSON.stringify(usage({ model: "claude-opus-4-8", inputTokens: 5000, outputTokens: 100 })) + "\n",
  );
  const unpricedOut = execFileSync(process.execPath, [cli, "report"], {
    env: { ...process.env, HOME: home2 },
    encoding: "utf8",
  });
  assert.ok(/est\. cost\s+n\/a/.test(unpricedOut), `cost shown as n/a: ${unpricedOut}`);
  assert.ok(unpricedOut.includes("no pricing for: claude-opus-4-8"), "names the unpriced model");
  assert.ok(!unpricedOut.includes("$0.0000"), "no misleading $0");
}

console.log("✓ report cli tests passed");
console.log("✓ all report tests passed");
