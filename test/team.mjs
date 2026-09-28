import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTeamReport,
  createMcpHandler,
  DEFAULT_TEAM,
  leasePressure,
  leaseSteer,
  Team,
} from "../dist/index.js";

const tmp = mkdtempSync(join(tmpdir(), "limitbreak-team-"));
let n = 0;
const fresh = (config) => new Team(join(tmp, `t${n++}.jsonl`), config);

// Seed asks: planner 25k + architect 30k + developer 60k + reviewer 25k = 140k.
// With the default 15% reserve, a full "large" roster needs ~165k available.
const FULL_LARGE = 200_000;

// --- roster scales with complexity, not with budget ---
{
  const team = fresh();
  const labels = (complexity) =>
    team
      .plan({ goal: "g", complexity, availableTokens: FULL_LARGE })
      .roster.map((r) => r.label);

  assert.deepEqual(labels("trivial"), ["developer"], "trivial work gets one agent");
  assert.deepEqual(labels("small"), ["developer", "reviewer"]);
  assert.deepEqual(labels("medium"), ["planner", "developer", "reviewer"]);
  assert.deepEqual(labels("large"), ["planner", "architect", "developer", "reviewer"]);
}

// --- a funded plan grants each role its full ask and holds the reserve back ---
{
  const team = fresh();
  const plan = team.plan({ goal: "g", complexity: "large", availableTokens: FULL_LARGE });
  assert.equal(plan.feasible, true);
  assert.equal(plan.degraded, null, "no degradation when the pool covers the asks");
  assert.equal(plan.heads, 4);
  assert.equal(plan.totalGranted, 140_000, "each role gets its p80 seed ask");
  assert.equal(plan.reserve, 30_000, "15% of available held back for overruns");
  assert.equal(plan.surplus, 30_000, "unallocated remainder of the pool");
  const grants = Object.fromEntries(plan.roster.map((r) => [r.role, r.grant]));
  assert.deepEqual(grants, { planner: 25_000, architect: 30_000, developer: 60_000, reviewer: 25_000 });
  // Phases order the run; roles inside a phase could run concurrently.
  assert.deepEqual(
    plan.roster.map((r) => r.phase),
    [1, 2, 3, 4],
  );
}

// --- a short pool splits proportionally, while every agent stays above its floor ---
{
  const team = fresh();
  const plan = team.plan({ goal: "g", complexity: "large", availableTokens: 100_000 });
  assert.equal(plan.feasible, true);
  assert.equal(plan.degraded, null, "85k pool still clears every floor");
  assert.equal(plan.heads, 4);
  assert.ok(plan.totalGranted <= 85_000, "never allocates more than the pool");
  const dev = plan.roster.find((r) => r.role === "developer");
  const planner = plan.roster.find((r) => r.role === "planner");
  assert.ok(dev.grant >= 25_000, "developer clears its 25k floor");
  assert.ok(planner.grant >= 12_000, "planner clears its 12k floor");
  // Shares track the asks, so the split self-calibrates as history accrues.
  assert.ok(Math.abs(dev.grant / planner.grant - 60 / 25) < 0.05);
  assert.ok(plan.notes.some((x) => x.includes("% of the full ask")));
}

// --- too little for four: merge rather than starve everyone ---
{
  const team = fresh();
  const plan = team.plan({ goal: "g", complexity: "large", availableTokens: 60_000 });
  assert.equal(plan.feasible, true);
  assert.equal(plan.heads, 2, "collapsed to developer + reviewer");
  assert.deepEqual(plan.roster.map((r) => r.role).sort(), ["developer", "reviewer"]);
  for (const r of plan.roster) {
    const floor = r.role === "developer" ? 25_000 : 12_000;
    assert.ok(r.grant >= floor, `${r.role} funded above its floor`);
  }
  // The chain planner → architect → developer must report both absorptions.
  const dev = plan.roster.find((r) => r.role === "developer");
  assert.deepEqual(dev.absorbed.sort(), ["architect", "planner"]);
  assert.ok(plan.degraded.steps.some((s) => s.includes("merged planner into architect")));
  assert.ok(plan.degraded.steps.some((s) => s.includes("merged architect into developer")));
}

// --- barely enough for one: a team of one beats two starved agents ---
{
  const team = fresh();
  const plan = team.plan({ goal: "g", complexity: "large", availableTokens: 30_000 });
  assert.equal(plan.feasible, true);
  assert.equal(plan.heads, 1);
  assert.equal(plan.roster[0].role, "developer");
  assert.ok(plan.roster[0].grant >= 25_000);
}

// --- hopeless budget is refused BEFORE any tokens are spent ---
{
  const team = fresh();
  const plan = team.plan({ goal: "g", complexity: "large", availableTokens: 20_000 });
  assert.equal(plan.feasible, false, "17k pool cannot fund even a single agent");
  assert.ok(plan.notes.some((x) => x.includes("cannot fund")));
}

// --- fan-out on independent units, capped by maxAgents ---
{
  const team = fresh();
  const three = team.plan({ goal: "g", complexity: "large", parallelWidth: 3, availableTokens: 500_000 });
  assert.equal(three.heads, 6, "planner + architect + 3 developers + reviewer");
  assert.deepEqual(
    three.roster.filter((r) => r.role === "developer").map((r) => r.label),
    ["developer#1", "developer#2", "developer#3"],
  );

  const capped = team.plan({ goal: "g", complexity: "large", parallelWidth: 9, availableTokens: 500_000 });
  assert.equal(capped.heads, DEFAULT_TEAM.maxAgents, "maxAgents is the ceiling in auto mode");
  assert.ok(capped.degraded.steps.some((s) => s.includes("dropped a parallel developer")));

  // Trivial work never fans out — coordination would cost more than the work.
  const trivial = team.plan({ goal: "g", complexity: "trivial", parallelWidth: 5, availableTokens: 500_000 });
  assert.equal(trivial.heads, 1);
}

// --- pinned headcount overrides auto sizing ---
{
  const team = fresh({ ...DEFAULT_TEAM, size: 2 });
  const plan = team.plan({ goal: "g", complexity: "large", availableTokens: FULL_LARGE });
  assert.equal(plan.heads, 2);
  assert.ok(plan.notes.some((x) => x.includes("pinned to 2")));
}

// --- degrade policies: serialize and refuse ---
{
  const ser = fresh({ ...DEFAULT_TEAM, degradeWhenPoor: "serialize" }).plan({
    goal: "g",
    complexity: "large",
    availableTokens: 60_000,
  });
  assert.equal(ser.feasible, true);
  assert.equal(ser.heads, 1);
  assert.equal(ser.roster[0].grant, 51_000, "the single agent gets the whole pool");
  assert.ok(ser.degraded.steps.some((s) => s.includes("serialized")));

  const ref = fresh({ ...DEFAULT_TEAM, degradeWhenPoor: "refuse" }).plan({
    goal: "g",
    complexity: "large",
    availableTokens: 60_000,
  });
  assert.equal(ref.feasible, false, "refuse never trades roles away");
}

// --- lease lifecycle, and a second process sees the same book ---
{
  const path = join(tmp, "leases.jsonl");
  const team = new Team(path);
  const plan = team.plan({ goal: "ship it", complexity: "small", availableTokens: FULL_LARGE });
  const leases = team.openPlan(plan);
  assert.equal(leases.length, 2);
  const dev = leases.find((l) => l.role === "developer");
  assert.match(dev.id, /^[a-f0-9]{12}$/);
  assert.equal(dev.tag, `developer:${dev.id}`, "tag attributes proxy usage back to the lease");

  const { lease, pressure } = team.spend(dev.id, 10_000);
  assert.equal(lease.spent, 10_000);
  assert.equal(pressure, "green");
  assert.equal(new Team(path).get(dev.id).spent, 10_000, "spend persists across instances");

  const closed = team.close(dev.id, "accepted");
  assert.equal(closed.status, "closed");
  assert.equal(closed.outcome, "accepted");
  assert.equal(team.close(dev.id, "accepted"), undefined, "double close reports nothing");
  assert.equal(team.close("not-an-id", "accepted"), undefined, "malformed id rejected");
  assert.throws(() => team.spend(dev.id, 100), /closed/, "a closed lease takes no more spend");
}

// --- concurrent spend reports are deltas, so none is lost ---
{
  const path = join(tmp, "concurrent.jsonl");
  const a = new Team(path);
  const plan = a.plan({ goal: "g", complexity: "trivial", availableTokens: FULL_LARGE });
  const [lease] = a.openPlan(plan);
  // Two agents (separate processes in practice) reporting against one lease.
  new Team(path).spend(lease.id, 1_000);
  new Team(path).spend(lease.id, 2_500);
  assert.equal(new Team(path).get(lease.id).spent, 3_500, "delta appends sum, never clobber");
}

// --- pressure ladder escalates steer → checkpoint → stop ---
{
  assert.equal(leasePressure({ granted: 1000, spent: 0 }), "green");
  assert.equal(leasePressure({ granted: 1000, spent: 699 }), "green");
  assert.equal(leasePressure({ granted: 1000, spent: 700 }), "steer");
  assert.equal(leasePressure({ granted: 1000, spent: 900 }), "checkpoint");
  assert.equal(leasePressure({ granted: 1000, spent: 1000 }), "stop");
  assert.equal(leasePressure({ granted: 0, spent: 0 }), "stop", "an unfunded lease is stopped");

  assert.equal(leaseSteer({ granted: 1000, spent: 0 }, "green"), null);
  assert.match(leaseSteer({ granted: 1000, spent: 700 }, "steer"), /Converge now/);
  assert.match(leaseSteer({ granted: 1000, spent: 950 }, "checkpoint"), /resume from/);
  assert.match(leaseSteer({ granted: 1000, spent: 1000 }, "stop"), /Budget exhausted/);
}

// --- an abandoned lease expires and its remainder returns to the pool ---
{
  const team = fresh();
  const plan = team.plan({ goal: "g", complexity: "small", availableTokens: FULL_LARGE });
  const dead = team.open({
    runId: plan.runId,
    role: "developer",
    task: "crashed mid-task",
    granted: 40_000,
    ttlMinutes: -1,
  });
  assert.equal(team.get(dead.id).status, "expired", "past its TTL, a lease is presumed abandoned");
  assert.throws(
    () => team.spend(dead.id, 1),
    /expired/,
    "a reclaimed grant must not be spent twice",
  );

  const { tokens } = team.reclaimable(plan.runId);
  assert.equal(tokens, 40_000, "the dead agent's whole grant returns to the pool");
}

// --- reclaim funds the next hire: an under-spender pays for a new head ---
{
  const team = fresh();
  const plan = team.plan({ goal: "g", complexity: "medium", availableTokens: FULL_LARGE });
  const leases = team.openPlan(plan);
  const planner = leases.find((l) => l.role === "planner");
  team.spend(planner.id, 5_000);
  team.close(planner.id, "accepted");
  const { tokens, leases: done } = team.reclaimable(plan.runId, 1);
  assert.equal(done.length, 1, "only phases up to the boundary are reclaimed");
  assert.equal(tokens, 20_000, "planner came in 20k under its 25k grant");
}

// --- estimation: seeds until there is history, then observed percentiles ---
{
  const team = fresh();
  const seed = team.estimate("developer");
  assert.equal(seed.source, "seed");
  assert.equal(seed.p80, 60_000);
  assert.equal(seed.minViable, 25_000);
  assert.equal(seed.samples, 0);

  const plan = team.plan({ goal: "g", complexity: "trivial", availableTokens: FULL_LARGE });
  for (const spent of [10_000, 20_000, 30_000]) {
    const l = team.open({ runId: plan.runId, role: "developer", task: "t", granted: 100_000 });
    team.spend(l.id, spent);
    team.close(l.id, "accepted");
  }
  const obs = team.estimate("developer");
  assert.equal(obs.source, "observed");
  assert.equal(obs.samples, 3);
  assert.equal(obs.p50, 20_000);
  assert.equal(obs.p80, 30_000, "grants come off p80 so the overrun tail is carried");
  assert.equal(obs.minViable, 10_000, "floor is p20 of runs that actually succeeded");
  assert.ok(Math.abs(obs.estimateToActual - 0.2) < 1e-9, "0.2x means the role is over-funded");

  // A failed run informs the grant but must not lower the working floor.
  const bad = team.open({ runId: plan.runId, role: "developer", task: "t", granted: 100_000 });
  team.spend(bad.id, 1_000);
  team.close(bad.id, "failed");
  assert.equal(team.estimate("developer").minViable, 10_000, "floor ignores failures");
}

// --- report: accepted-per-100k, coordination overhead, per-role overrun ---
{
  const team = fresh();
  const plan = team.plan({ goal: "g", complexity: "medium", availableTokens: FULL_LARGE });
  const mgr = team.open({ runId: plan.runId, role: "manager", task: "staffing", granted: 15_000 });
  team.spend(mgr.id, 10_000);
  team.close(mgr.id, "accepted");
  const dev = team.open({ runId: plan.runId, role: "developer", task: "build", granted: 60_000 });
  team.spend(dev.id, 90_000); // a 1.5x overrun
  team.close(dev.id, "accepted");

  const r = buildTeamReport(team.leases(plan.runId));
  assert.equal(r.runs, 1);
  assert.equal(r.leases, 2);
  assert.equal(r.spent, 100_000);
  assert.equal(r.tasksAccepted, 2);
  assert.equal(r.acceptedPer100k, 2, "2 accepted tasks per 100k tokens");
  assert.ok(Math.abs(r.managerOverheadPct - 0.1) < 1e-9, "coordination cost is metered, not hidden");
  assert.ok(Math.abs(r.byRole.developer.estimateToActual - 1.5) < 1e-9);
  assert.equal(r.byRole.manager.accepted, 1);
  assert.equal(r.reclaimed, 5_000, "manager's unspent 5k");

  const empty = buildTeamReport([]);
  assert.equal(empty.leases, 0);
  assert.equal(empty.acceptedPer100k, 0, "no division by zero on an empty book");
}

// --- MCP surface: plan opens leases, spend steers, stop is an error signal ---
{
  const dir = mkdtempSync(join(tmpdir(), "limitbreak-team-mcp-"));
  const handle = createMcpHandler({ configDir: dir });
  const call = (name, args = {}) =>
    handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

  const tools = handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }).result.tools.map((t) => t.name);
  for (const t of [
    "limitbreak_team_plan",
    "limitbreak_lease_spend",
    "limitbreak_lease_close",
    "limitbreak_team_status",
    "limitbreak_team_report",
  ]) {
    assert.ok(tools.includes(t), `${t} advertised`);
  }

  assert.match(call("limitbreak_team_plan", {}).result.content[0].text, /requires a non-empty string/);
  assert.equal(call("limitbreak_team_plan", { goal: "g" }).result.isError, undefined);
  assert.match(
    call("limitbreak_team_plan", { goal: "g", complexity: "enormous" }).result.content[0].text,
    /invalid "complexity"/,
  );

  // No usage recorded yet, so the pool is the full default 5h window budget.
  const dry = call("limitbreak_team_plan", {
    goal: "add a flag",
    complexity: "small",
    dryRun: true,
  }).result.content[0].text;
  assert.match(dry, /pool: 2000000 tokens available/, "staffed against remaining quota");
  assert.match(dry, /developer/);
  assert.doesNotMatch(dry, /lease [a-f0-9]{12}/, "a dry run opens nothing");

  const planned = call("limitbreak_team_plan", { goal: "build it", complexity: "small" }).result
    .content[0].text;
  const id = /lease ([a-f0-9]{12})/.exec(planned)?.[1];
  assert.ok(id, "a real plan hands back lease ids");

  const mid = call("limitbreak_lease_spend", { id, tokens: 20_000 }).result;
  assert.equal(mid.isError, undefined);
  assert.match(mid.content[0].text, /GREEN|STEER/);

  const over = call("limitbreak_lease_spend", { id, tokens: 500_000 }).result;
  assert.equal(over.isError, true, "an exhausted lease is reported as a hard error");
  assert.match(over.content[0].text, /STOP/);

  assert.match(
    call("limitbreak_lease_close", { id, outcome: "nope" }).result.content[0].text,
    /invalid "outcome"/,
  );
  assert.match(call("limitbreak_lease_close", { id, outcome: "accepted" }).result.content[0].text, /closed/);
  assert.match(call("limitbreak_team_status", {}).result.content[0].text, /developer/);

  const report = JSON.parse(call("limitbreak_team_report", {}).result.content[0].text);
  assert.ok(report.leases >= 1);
  assert.equal(report.tasksAccepted, 1);
}

console.log("✓ team");
