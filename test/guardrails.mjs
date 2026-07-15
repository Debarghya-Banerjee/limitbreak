import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GUARDRAILS,
  evaluateGuardrails,
  readGuardrailRecords,
  DEFAULT_SETTINGS,
  Ledger,
  createProxy,
  Store,
} from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-guard-"));
const now = Date.now();
const cfg = { ...DEFAULT_GUARDRAILS, minSamples: 10 };

const rec = (over) => ({
  ts: now,
  shaped: undefined,
  downgraded: false,
  ok: true,
  truncated: false,
  totalTokens: 1000,
  ...over,
});
const many = (n, over) => Array.from({ length: n }, () => rec(over));

// --- insufficient samples → never reverts ---
{
  const v = evaluateGuardrails([...many(5, { shaped: true }), ...many(5, { shaped: false })], cfg);
  assert.equal(v.shaping.disabled, false, "below minSamples → keep");
  assert.equal(v.shaping.shaped, null, "no stats when insufficient");
}

// --- healthy shaping (fewer tokens, same errors) → keep ---
{
  const v = evaluateGuardrails(
    [...many(20, { shaped: true, totalTokens: 600 }), ...many(20, { shaped: false, totalTokens: 1000 })],
    cfg,
  );
  assert.equal(v.shaping.disabled, false, "saving tokens, no errors → keep");
}

// --- truncation regression → revert shaping ---
{
  const shaped = [...many(18, { shaped: true, totalTokens: 600 }), ...many(2, { shaped: true, totalTokens: 600, truncated: true })];
  const holdout = many(20, { shaped: false, totalTokens: 1000 });
  const v = evaluateGuardrails([...shaped, ...holdout], cfg);
  assert.equal(v.shaping.disabled, true, "10% truncation vs 0% holdout → revert");
  assert.match(v.shaping.reason, /truncation/);
}

// --- error-rate regression → revert ---
{
  const shaped = [...many(16, { shaped: true, totalTokens: 600 }), ...many(4, { shaped: true, totalTokens: 600, ok: false })];
  const holdout = many(20, { shaped: false, totalTokens: 1000 });
  const v = evaluateGuardrails([...shaped, ...holdout], cfg);
  assert.equal(v.shaping.disabled, true, "20% error vs 0% holdout → revert");
  assert.match(v.shaping.reason, /error rate/);
}

// --- backfire: shaping not saving tokens → revert ---
{
  const v = evaluateGuardrails(
    [...many(20, { shaped: true, totalTokens: 1100 }), ...many(20, { shaped: false, totalTokens: 1000 })],
    cfg,
  );
  assert.equal(v.shaping.disabled, true, "shaped uses more tokens than holdout → backfire revert");
  assert.match(v.shaping.reason, /no token savings/);
}

// --- downgrade judged separately (no backfire check) ---
{
  const downgraded = [...many(16, { shaped: true, downgraded: true }), ...many(4, { shaped: true, downgraded: true, ok: false })];
  const holdout = many(20, { shaped: false });
  const v = evaluateGuardrails([...downgraded, ...holdout], cfg);
  assert.equal(v.downgrade.disabled, true, "downgrade error regression → revert downgrade");
  // shaping group here is all downgraded+healthy-tokens equal → shaping also sees the errors
  assert.equal(v.shaping.disabled, true);
}

// --- guardrails disabled in config → never reverts ---
{
  const v = evaluateGuardrails(many(40, { shaped: true, ok: false }), { ...cfg, enabled: false });
  assert.equal(v.shaping.disabled, false);
}

console.log("✓ guardrail evaluator tests passed");

// --- ledger reader maps requestedModel→downgraded and ok/truncated flags ---
{
  const p = join(tmp, "read.jsonl");
  writeFileSync(
    p,
    [
      JSON.stringify({ ts: new Date(now).toISOString(), shaped: true, requestedModel: "opus", model: "sonnet", inputTokens: 100, outputTokens: 50 }),
      JSON.stringify({ ts: new Date(now).toISOString(), shaped: false, ok: false, inputTokens: 0, outputTokens: 0 }),
      JSON.stringify({ ts: new Date(now).toISOString(), shaped: true, truncated: true, inputTokens: 200, outputTokens: 10 }),
      JSON.stringify({ kind: "limit", ts: new Date(now).toISOString(), status: 429, usedAt: {} }),
      JSON.stringify({ ts: new Date(now - 100 * 3_600_000).toISOString(), shaped: true }), // too old
    ].join("\n") + "\n",
  );
  const recs = readGuardrailRecords(p, now - 6 * 3_600_000);
  assert.equal(recs.length, 3, "limit line + stale line excluded");
  assert.equal(recs[0].downgraded, true, "requestedModel≠model → downgraded");
  assert.equal(recs[0].totalTokens, 150);
  assert.equal(recs[1].ok, false);
  assert.equal(recs[2].truncated, true);
}

console.log("✓ guardrail reader tests passed");

// --- proxy e2e: shaped calls error out → shaping auto-reverts to passthrough ---
{
  // Upstream 500s only when it receives the terse-steering suffix (i.e. a shaped
  // call); holdout/unshaped calls succeed. So shaping looks strictly worse.
  const upstream = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const shapedCall = b.includes("Quota pressure is high");
      if (shapedCall) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", usage: { input_tokens: 100, output_tokens: 20 } }));
      }
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const upPort = upstream.address().port;

  const logPath = join(tmp, "e2e.jsonl");
  const settings = {
    ...DEFAULT_SETTINGS,
    windows: [{ name: "5h", hours: 5, budgetTokens: 1000 }],
    windowsExplicit: true,
    holdout: 0.2,
    terseOnPressure: true,
    compression: { green: "off", yellow: "off", red: "off" },
    guardrails: { ...DEFAULT_GUARDRAILS, enabled: true, minSamples: 5, lookbackHours: 24 },
    upstreams: { anthropic: `http://localhost:${upPort}`, openai: `http://localhost:${upPort}` },
  };
  // Seed the window to red (950/1000) so shaping engages.
  writeFileSync(
    logPath,
    JSON.stringify({ ts: new Date(now).toISOString(), provider: "anthropic", model: "m", inputTokens: 950, outputTokens: 0, droppedContextTokens: 0 }) + "\n",
  );

  const ledger = new Ledger(logPath);
  // random() alternates so ~half the calls are holdout (unshaped, succeed),
  // half are shaped (500). Enough shaped errors to trip the guardrail.
  let i = 0;
  const proxy = createProxy({
    ledger,
    settings,
    random: () => (i++ % 2 === 0 ? 0.99 : 0.05), // 0.99 → shaped, 0.05 → holdout
    store: new Store(join(tmp, "store-e2e")),
  });
  await new Promise((r) => proxy.listen(0, r));
  const pxPort = proxy.address().port;

  const send = () =>
    fetch(`http://localhost:${pxPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-7", system: "rules", messages: [{ role: "user", content: "hi" }] }),
    });

  // Warm-up: generate shaped errors + holdout successes to feed the guardrail.
  for (let n = 0; n < 20; n++) await send();

  // The guardrail should now see shaped error-rate >> holdout and revert.
  const recs = readGuardrailRecords(logPath, now - 24 * 3_600_000);
  const v = evaluateGuardrails(recs, settings.guardrails);
  assert.equal(v.shaping.disabled, true, `shaping should be reverted; reason=${v.shaping.reason}`);

  // Verdict refresh is cached 60s in-proxy, so force a fresh proxy to prove that
  // once reverted, shaped traffic becomes passthrough (no more 500s).
  const proxy2 = createProxy({ ledger: new Ledger(logPath), settings, random: () => 0.99, store: new Store(join(tmp, "store-e2e2")) });
  await new Promise((r) => proxy2.listen(0, r));
  const px2 = proxy2.address().port;
  const res = await fetch(`http://localhost:${px2}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-4-7", system: "rules", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200, "with shaping reverted, a would-be-shaped call now passes through and succeeds");

  upstream.close();
  proxy.close();
  proxy2.close();
  console.log("✓ guardrail proxy e2e passed");
}

console.log("✓ all guardrail tests passed");
