import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Task, Tier } from "./types.js";

/**
 * Multi-agent budget allocation — the governor applied to a fleet instead of a
 * single caller.
 *
 * The governor meters one stream against a quota window. A team of agents is
 * many streams drawing on the SAME window, which changes the problem: the
 * scarce resource has to be divided before the work starts, and an agent that
 * runs out mid-task yields nothing. Unlike money or wall-clock time, a task
 * killed at 95% of its budget has no salvage value — you paid in full for an
 * unusable artifact. That single asymmetry drives most of the design here:
 *
 *  - Budgets are LEASES, not counters: granted up front, reclaimable when the
 *    holder dies, and reconciled against actuals so the next estimate is better.
 *  - Headcount is capped by `available / minViableLease`, not by how much work
 *    there is. Ten agents each below their working minimum produce nothing for
 *    full price; four funded agents ship. Understaffing is slow, overstaffing
 *    is a total loss.
 *  - When the pool can't fund the full roster we MERGE roles rather than
 *    underfund them — one agent planning and building on 50k beats two starved
 *    agents on 25k each.
 *  - Estimates come from the ledger's own history (reference class), never from
 *    asking a model to predict its own consumption, which runs badly low.
 *
 * This module is pure allocation: no LLM calls, no spawning. Judgement (what
 * the tasks are, how complex, how parallel) is supplied by the caller and the
 * running is done by whatever agent runtime the caller uses. Keeping the
 * allocator free of both makes it testable and runtime-agnostic.
 */

export type PriorityClass = "P0" | "P1" | "P2" | "P3";

/** Coarse shape of a goal, used to pick a roster before any tokens are spent. */
export type Complexity = "trivial" | "small" | "medium" | "large";

export interface RoleSpec {
  name: string;
  /** Routed through the same task→tier map the SDK router uses. */
  task: Task;
  tier: Tier;
  priority: PriorityClass;
  /** Handoff this role produces for the next one. */
  emits: string;
  /**
   * Pre-history fallbacks, in tokens. Replaced by observed percentiles as soon
   * as the role has closed leases to learn from — they are starting points, not
   * claims about your workload.
   */
  seedEstimate: number;
  seedMinViable: number;
  /** Execution order. Roles in the same phase run concurrently. */
  phase: number;
}

/**
 * The default org chart. `manager` is a first-class role with its own lease so
 * coordination overhead is measured rather than hidden — a manager quietly
 * eating a third of the pool is the most likely way this whole approach turns
 * out to be net-negative, and it can't be caught if it isn't metered.
 */
export const DEFAULT_ROLES: RoleSpec[] = [
  {
    name: "manager",
    task: "reason",
    tier: "max",
    priority: "P0",
    emits: "staffing plan",
    seedEstimate: 15_000,
    seedMinViable: 8_000,
    phase: 0,
  },
  {
    name: "planner",
    task: "reason",
    tier: "max",
    priority: "P0",
    emits: "context pack",
    seedEstimate: 25_000,
    seedMinViable: 12_000,
    phase: 1,
  },
  {
    name: "architect",
    task: "reason",
    tier: "max",
    priority: "P0",
    emits: "design + file plan",
    seedEstimate: 30_000,
    seedMinViable: 15_000,
    phase: 2,
  },
  {
    name: "developer",
    task: "generate",
    tier: "balanced",
    priority: "P1",
    emits: "diff",
    seedEstimate: 60_000,
    seedMinViable: 25_000,
    phase: 3,
  },
  {
    name: "reviewer",
    task: "reason",
    tier: "balanced",
    priority: "P1",
    emits: "verdict + findings",
    seedEstimate: 25_000,
    seedMinViable: 12_000,
    phase: 4,
  },
];

/** Roster per complexity tier. A reviewer on a one-line change is pure overhead. */
const ROSTERS: Record<Complexity, string[]> = {
  trivial: ["developer"],
  small: ["developer", "reviewer"],
  medium: ["planner", "developer", "reviewer"],
  large: ["planner", "architect", "developer", "reviewer"],
};

/**
 * Collapse order when the pool can't fund everyone: the absorbing role takes
 * over the merged one's work and inherits its estimate. Planning folds into
 * architecture first (same tier, adjacent thinking); review folds into
 * development last, since losing the independent check costs the most quality.
 */
const MERGE_LADDER: { drop: string; into: string }[] = [
  { drop: "planner", into: "architect" },
  { drop: "architect", into: "developer" },
  { drop: "reviewer", into: "developer" },
];

export interface TeamConfig {
  /** "auto" lets the allocator size the team; a number pins headcount. */
  size: "auto" | number;
  /** Hard ceiling even in auto — the guard against a bad triage fanning out. */
  maxAgents: number;
  /** "auto" derives each role's floor from its own successful history. */
  minViableLease: "auto" | number;
  /**
   * Agents hand off only through the manager, never peer-to-peer. Coordination
   * cost is then linear in headcount instead of quadratic, which is what makes
   * larger teams affordable at all.
   */
  topology: "star";
  degradeWhenPoor: "merge" | "serialize" | "refuse";
  /** Fraction held back for overruns and review-triggered rework. */
  reserve: number;
  /** Lease usage fraction at which an agent is told to converge. */
  steerPct: number;
  /** Fraction at which it must emit a resumable artifact. */
  checkpointPct: number;
  /** A lease this old is presumed abandoned and its budget returns to the pool. */
  leaseTtlMinutes: number;
}

export const DEFAULT_TEAM: TeamConfig = {
  size: "auto",
  maxAgents: 6,
  minViableLease: "auto",
  topology: "star",
  degradeWhenPoor: "merge",
  reserve: 0.15,
  steerPct: 0.7,
  checkpointPct: 0.9,
  leaseTtlMinutes: 90,
};

export interface Lease {
  id: string;
  runId: string;
  role: string;
  /** Short description of the assigned work. */
  task: string;
  phase: number;
  /** Tokens allocated up front for this phase. */
  granted: number;
  priority: PriorityClass;
  /** Telemetry tag so proxy/SDK usage attributes back to this lease. */
  tag: string;
  openedAt: string;
  expiresAt: string;
}

export type LeaseOutcome = "accepted" | "rejected" | "failed";

export interface LeaseState extends Lease {
  spent: number;
  status: "open" | "closed" | "expired";
  outcome?: LeaseOutcome;
  closedAt?: string;
}

type TeamOp =
  | { op: "open"; lease: Lease }
  | { op: "spend"; id: string; tokens: number; ts: string }
  | { op: "close"; id: string; ts: string; outcome: LeaseOutcome };

const ID_RE = /^[a-f0-9]{12}$/;

export interface RoleEstimate {
  role: string;
  samples: number;
  /** Working floor: below the 20th percentile of what has actually succeeded. */
  minViable: number;
  p50: number;
  /** The grant. Budgets are a risk decision, so the ask is p80, not the mean. */
  p80: number;
  /**
   * Mean spent/granted across closed leases. Above 1 means the role habitually
   * overruns its allocation; below 1 means it is over-funded. This is the
   * number that makes a fleet's economics legible.
   */
  estimateToActual: number | null;
  source: "observed" | "seed";
}

export interface RosterEntry {
  role: string;
  /** Distinguishes fan-out siblings, e.g. developer#2. */
  label: string;
  grant: number;
  priority: PriorityClass;
  phase: number;
  tier: Tier;
  task: Task;
  emits: string;
  /** Roles this entry absorbed through degradation. */
  absorbed?: string[];
}

export interface StaffingPlan {
  runId: string;
  heads: number;
  roster: RosterEntry[];
  /** Held back for overruns and rework, not allocated to any agent. */
  reserve: number;
  /** Pool left unallocated because asks came in under the available budget. */
  surplus: number;
  totalGranted: number;
  /** Sum of role asks before any clamping — what a full roster would cost. */
  totalEstimate: number;
  feasible: boolean;
  degraded: { policy: TeamConfig["degradeWhenPoor"]; steps: string[] } | null;
  notes: string[];
}

export interface StaffingRequest {
  goal: string;
  complexity: Complexity;
  /**
   * Count of genuinely independent work units. Drives developer fan-out; 1
   * means a single chain. Supplied by cheap triage, not guessed here.
   */
  parallelWidth?: number;
  /** Tokens the team may draw on — typically remaining quota in the window. */
  availableTokens: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[idx] ?? 0;
}

/**
 * Per-lease budget pressure. Mirrors the governor's green/yellow/red ladder,
 * but scoped to one agent's allocation: steer it to converge, then force a
 * resumable checkpoint, and only then stop it. The checkpoint step is what
 * makes stopping survivable instead of a total write-off.
 */
export type LeasePressure = "green" | "steer" | "checkpoint" | "stop";

export function leasePressure(
  lease: Pick<LeaseState, "granted" | "spent">,
  config: Pick<TeamConfig, "steerPct" | "checkpointPct"> = DEFAULT_TEAM,
): LeasePressure {
  if (lease.granted <= 0) return "stop";
  const pct = lease.spent / lease.granted;
  if (pct >= 1) return "stop";
  if (pct >= config.checkpointPct) return "checkpoint";
  if (pct >= config.steerPct) return "steer";
  return "green";
}

/** Instruction handed to an agent as its lease burns down. */
export function leaseSteer(lease: Pick<LeaseState, "granted" | "spent">, pressure: LeasePressure): string | null {
  const left = Math.max(0, lease.granted - lease.spent);
  switch (pressure) {
    case "steer":
      return `Budget: ~${left} tokens left of ${lease.granted}. Converge now — stop exploring, finish with what you have.`;
    case "checkpoint":
      return `Budget nearly exhausted (~${left} of ${lease.granted} left). Emit your artifact immediately, in a form another agent can resume from. Do not start new work.`;
    case "stop":
      return `Budget exhausted (${lease.spent}/${lease.granted}). Stop and report what you completed.`;
    default:
      return null;
  }
}

/**
 * Lease book for one machine.
 *
 * Persistence is an append-only JSONL op log, same as the memory store: opens
 * and closes are snapshots, spends are DELTAS. Deltas matter because several
 * agents report usage concurrently — summing independent appends is safe where
 * a read-modify-write of a running total would silently lose increments.
 */
export class Team {
  constructor(
    private path: string,
    private config: TeamConfig = DEFAULT_TEAM,
    private roles: RoleSpec[] = DEFAULT_ROLES,
  ) {}

  private append(op: TeamOp): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(op) + "\n", "utf8");
  }

  private load(now = Date.now()): Map<string, LeaseState> {
    const out = new Map<string, LeaseState>();
    if (!existsSync(this.path)) return out;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let op: TeamOp;
      try {
        op = JSON.parse(line);
      } catch {
        continue;
      }
      if (op.op === "open") {
        if (typeof op.lease?.id !== "string") continue;
        out.set(op.lease.id, { ...op.lease, spent: 0, status: "open" });
        continue;
      }
      const lease = out.get(op.id);
      if (!lease) continue;
      if (op.op === "spend") {
        lease.spent += Number(op.tokens) || 0;
      } else if (op.op === "close") {
        lease.status = "closed";
        lease.closedAt = op.ts;
        lease.outcome = op.outcome;
      }
    }
    // An open lease past its TTL is presumed abandoned — its holder crashed or
    // was interrupted. Marking it expired is what returns the unspent remainder
    // to the pool; without this, every dead agent leaks its grant forever.
    for (const lease of out.values()) {
      if (lease.status === "open" && Date.parse(lease.expiresAt) <= now) {
        lease.status = "expired";
      }
    }
    return out;
  }

  role(name: string): RoleSpec | undefined {
    return this.roles.find((r) => r.name === name);
  }

  leases(runId?: string): LeaseState[] {
    const all = [...this.load().values()];
    const filtered = runId ? all.filter((l) => l.runId === runId) : all;
    return filtered.sort((a, b) => a.phase - b.phase || a.openedAt.localeCompare(b.openedAt));
  }

  get(id: string): LeaseState | undefined {
    return this.load().get(id);
  }

  /**
   * Reference-class estimate for a role, from its own closed leases. Accepted
   * outcomes set the working floor (p20) because a rejected or failed run is
   * evidence about what does NOT work; grants come off the p80 of all closed
   * actuals so the estimate carries the overrun tail rather than averaging it
   * away. Falls back to seeds until there is history to learn from.
   */
  estimate(role: string): RoleEstimate {
    const spec = this.role(role);
    const closed = this.leases().filter((l) => l.role === role && l.status !== "open");
    const actuals = closed.map((l) => l.spent).filter((n) => n > 0).sort((a, b) => a - b);
    const succeeded = closed
      .filter((l) => l.outcome === "accepted")
      .map((l) => l.spent)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);

    const ratios = closed
      .filter((l) => l.granted > 0 && l.spent > 0)
      .map((l) => l.spent / l.granted);
    const estimateToActual =
      ratios.length > 0 ? ratios.reduce((s, r) => s + r, 0) / ratios.length : null;

    if (actuals.length < 3) {
      return {
        role,
        samples: actuals.length,
        minViable: spec?.seedMinViable ?? 20_000,
        p50: spec?.seedEstimate ?? 40_000,
        p80: spec?.seedEstimate ?? 40_000,
        estimateToActual,
        source: "seed",
      };
    }
    // Enough successful runs to know the floor empirically; otherwise keep the
    // seed floor rather than inferring it from runs that failed.
    const minViable =
      succeeded.length >= 3 ? percentile(succeeded, 20) : spec?.seedMinViable ?? 20_000;
    return {
      role,
      samples: actuals.length,
      minViable,
      p50: percentile(actuals, 50),
      p80: percentile(actuals, 80),
      estimateToActual,
      source: "observed",
    };
  }

  private floorFor(role: string): number {
    return this.config.minViableLease === "auto"
      ? this.estimate(role).minViable
      : this.config.minViableLease;
  }

  /**
   * Decides headcount and per-agent grants.
   *
   * Order is deliberate: clamp headcount first, then test affordability. Fewer
   * heads means larger grants, so shrinking the team is itself a way to make
   * the remaining agents viable — checking affordability before clamping would
   * reject rosters that fit perfectly well once trimmed.
   */
  plan(req: StaffingRequest): StaffingPlan {
    const runId = randomBytes(6).toString("hex");
    const notes: string[] = [];
    const steps: string[] = [];
    const width = Math.max(1, Math.floor(req.parallelWidth ?? 1));

    let roles = [...(ROSTERS[req.complexity] ?? ROSTERS.medium)];
    // Fan out developers across independent units — but never on trivial work,
    // where coordination would cost more than the work itself.
    let devCopies = req.complexity === "trivial" ? 1 : width;

    // The unclamped ask: what this goal costs with a full roster at the
    // requested width. Captured before any clamping so the funding ratio below
    // compares against the real requirement rather than a trimmed one.
    const totalEstimate = expand(roles, devCopies).reduce(
      (s, e) => s + this.estimate(e.role).p80,
      0,
    );

    if (typeof this.config.size === "number") {
      const pinned = Math.max(1, Math.floor(this.config.size));
      while (roles.length + devCopies - 1 > pinned && devCopies > 1) devCopies--;
      while (roles.length + devCopies - 1 > pinned && roles.length > 1) {
        const merge = MERGE_LADDER.find((m) => roles.includes(m.drop) && roles.includes(m.into));
        if (!merge) break;
        roles = roles.filter((r) => r !== merge.drop);
        steps.push(`${merge.drop} → ${merge.into} (headcount pinned to ${pinned})`);
      }
      notes.push(`headcount pinned to ${pinned} by config`);
    }

    while (roles.length + devCopies - 1 > this.config.maxAgents && devCopies > 1) {
      devCopies--;
      steps.push(`dropped a parallel developer (maxAgents ${this.config.maxAgents})`);
    }

    const pool = Math.max(0, req.availableTokens) * (1 - this.config.reserve);
    const reserve = Math.max(0, req.availableTokens) - pool;
    const absorbed: Record<string, string[]> = {};
    let feasible = false;
    let grants: Map<string, number> = new Map();

    // Shrink until every remaining agent clears its working floor. Estimates
    // double as the split: a role's share of a short pool is its share of the
    // total ask, so the division self-calibrates as history accumulates.
    for (;;) {
      const expanded = expand(roles, devCopies);
      const asks = expanded.map((e) => ({
        label: e.label,
        role: e.role,
        ask: this.estimate(e.role).p80,
        floor: this.floorFor(e.role),
      }));
      const totalAsk = asks.reduce((s, a) => s + a.ask, 0);
      grants = new Map(
        asks.map((a) => [
          a.label,
          totalAsk > 0 && pool < totalAsk ? Math.floor((pool * a.ask) / totalAsk) : a.ask,
        ]),
      );
      const starved = asks.filter((a) => (grants.get(a.label) ?? 0) < a.floor);
      if (starved.length === 0) {
        feasible = true;
        break;
      }

      if (this.config.degradeWhenPoor === "refuse") {
        notes.push(
          `refused: pool of ${Math.floor(pool)} tokens cannot fund ${starved.map((s) => s.label).join(", ")} above their working minimum`,
        );
        break;
      }
      if (this.config.degradeWhenPoor === "serialize") {
        roles = ["developer"];
        devCopies = 1;
        steps.push("serialized: one agent runs every phase in sequence");
        const floor = this.floorFor("developer");
        if (pool < floor) {
          notes.push(`refused: pool of ${Math.floor(pool)} tokens is below a single agent's floor of ${floor}`);
          break;
        }
        grants = new Map([["developer", Math.floor(pool)]]);
        feasible = true;
        break;
      }

      // merge: drop a parallel developer first (cheapest quality loss), then
      // collapse roles up the ladder.
      if (devCopies > 1) {
        devCopies--;
        steps.push("dropped a parallel developer to fund the rest");
        continue;
      }
      const merge = MERGE_LADDER.find((m) => roles.includes(m.drop) && roles.includes(m.into));
      if (!merge) {
        notes.push(
          `refused: pool of ${Math.floor(pool)} tokens cannot fund even a merged team above its working minimum`,
        );
        break;
      }
      roles = roles.filter((r) => r !== merge.drop);
      // Carry forward anything the dropped role had itself absorbed, so a chain
      // (planner → architect → developer) still reports the full inheritance.
      const inherited = absorbed[merge.drop] ?? [];
      (absorbed[merge.into] ??= []).push(...inherited, merge.drop);
      delete absorbed[merge.drop];
      steps.push(`merged ${merge.drop} into ${merge.into} rather than underfund both`);
    }

    const roster: RosterEntry[] = expand(roles, devCopies).map((e) => {
      const spec = this.role(e.role);
      const inherited = absorbed[e.role];
      return {
        role: e.role,
        label: e.label,
        grant: grants.get(e.label) ?? 0,
        priority: spec?.priority ?? "P1",
        phase: spec?.phase ?? 3,
        tier: spec?.tier ?? "balanced",
        task: spec?.task ?? "generate",
        emits: spec?.emits ?? "result",
        ...(inherited && inherited.length > 0 && { absorbed: inherited }),
      };
    });
    roster.sort((a, b) => a.phase - b.phase || a.label.localeCompare(b.label));

    const totalGranted = roster.reduce((s, r) => s + r.grant, 0);
    if (feasible && totalGranted < totalEstimate) {
      notes.push(
        `funded at ${Math.round((totalGranted / totalEstimate) * 100)}% of the full ask — expect tighter scoping`,
      );
    }

    return {
      runId,
      heads: roster.length,
      roster,
      reserve: Math.floor(reserve),
      surplus: Math.max(0, Math.floor(pool - totalGranted)),
      totalGranted,
      totalEstimate,
      feasible,
      degraded: steps.length > 0 ? { policy: this.config.degradeWhenPoor, steps } : null,
      notes,
    };
  }

  /** Opens a lease. Returns the record the agent should carry as its tag. */
  open(input: {
    runId: string;
    role: string;
    task: string;
    granted: number;
    phase?: number;
    priority?: PriorityClass;
    ttlMinutes?: number;
  }): Lease {
    if (input.granted <= 0) throw new Error("team: granted must be positive");
    const spec = this.role(input.role);
    const id = randomBytes(6).toString("hex");
    const now = new Date();
    const ttl = input.ttlMinutes ?? this.config.leaseTtlMinutes;
    const lease: Lease = {
      id,
      runId: input.runId,
      role: input.role,
      task: input.task,
      phase: input.phase ?? spec?.phase ?? 3,
      granted: Math.floor(input.granted),
      priority: input.priority ?? spec?.priority ?? "P1",
      tag: `${input.role}:${id}`,
      openedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
    };
    this.append({ op: "open", lease });
    return lease;
  }

  /** Opens every lease in a plan's first phase or all phases at once. */
  openPlan(plan: StaffingPlan, opts?: { phase?: number }): Lease[] {
    const entries =
      opts?.phase === undefined
        ? plan.roster
        : plan.roster.filter((r) => r.phase === opts.phase);
    return entries.map((r) =>
      this.open({
        runId: plan.runId,
        role: r.role,
        task: r.label,
        granted: r.grant,
        phase: r.phase,
        priority: r.priority,
      }),
    );
  }

  /** Records usage against a lease and returns the resulting pressure. */
  spend(id: string, tokens: number): { lease: LeaseState; pressure: LeasePressure; steer: string | null } {
    if (!ID_RE.test(id)) throw new Error(`team: malformed lease id ${id}`);
    const existing = this.load().get(id);
    if (!existing) throw new Error(`team: no lease ${id}`);
    // A closed or expired lease has already had its remainder reclaimed and
    // possibly re-granted elsewhere; accepting more spend against it would
    // double-book the same tokens.
    if (existing.status !== "open") {
      throw new Error(`team: lease ${id} is ${existing.status} — stop work and report to the manager`);
    }
    if (tokens > 0) {
      this.append({ op: "spend", id, tokens: Math.floor(tokens), ts: new Date().toISOString() });
    }
    const lease: LeaseState = { ...existing, spent: existing.spent + Math.max(0, Math.floor(tokens)) };
    const pressure = leasePressure(lease, this.config);
    return { lease, pressure, steer: leaseSteer(lease, pressure) };
  }

  close(id: string, outcome: LeaseOutcome): LeaseState | undefined {
    if (!ID_RE.test(id)) return undefined;
    const lease = this.load().get(id);
    if (!lease || lease.status === "closed") return undefined;
    const ts = new Date().toISOString();
    this.append({ op: "close", id, ts, outcome });
    return { ...lease, status: "closed", closedAt: ts, outcome };
  }

  /**
   * Budget available again at a phase boundary: unspent remainders from closed
   * or abandoned leases. This is what funds mid-run hiring — a developer that
   * comes in under its lease pays for the next head, so re-staffing between
   * phases never needs preemption.
   */
  reclaimable(runId: string, upToPhase?: number): { tokens: number; leases: LeaseState[] } {
    const done = this.leases(runId).filter(
      (l) =>
        l.status !== "open" &&
        (upToPhase === undefined || l.phase <= upToPhase) &&
        l.granted > l.spent,
    );
    return {
      tokens: done.reduce((s, l) => s + (l.granted - l.spent), 0),
      leases: done,
    };
  }
}

/** Expands a role list into concrete agent labels, fanning out developers. */
function expand(roles: string[], devCopies: number): { role: string; label: string }[] {
  const out: { role: string; label: string }[] = [];
  for (const role of roles) {
    if (role === "developer" && devCopies > 1) {
      for (let i = 1; i <= devCopies; i++) out.push({ role, label: `developer#${i}` });
    } else {
      out.push({ role, label: role });
    }
  }
  return out;
}

export interface RoleReport {
  leases: number;
  granted: number;
  spent: number;
  accepted: number;
  rejected: number;
  failed: number;
  /** Mean spent/granted — above 1 means this role habitually overruns. */
  estimateToActual: number | null;
}

export interface TeamReport {
  runs: number;
  leases: number;
  granted: number;
  spent: number;
  /** Unspent budget recovered from closed or abandoned leases. */
  reclaimed: number;
  byRole: Record<string, RoleReport>;
  tasksAccepted: number;
  /**
   * The headline efficiency number: accepted work per 100k tokens. Quality per
   * token, not tokens saved — a cheaper run that ships nothing is not a win.
   */
  acceptedPer100k: number;
  /** Share of spend that went to coordination rather than the work itself. */
  managerOverheadPct: number;
}

export function buildTeamReport(leases: LeaseState[]): TeamReport {
  const byRole: Record<string, RoleReport> = {};
  const runs = new Set<string>();
  let granted = 0;
  let spent = 0;
  let reclaimed = 0;
  let accepted = 0;
  let managerSpend = 0;

  for (const l of leases) {
    runs.add(l.runId);
    granted += l.granted;
    spent += l.spent;
    if (l.status !== "open" && l.granted > l.spent) reclaimed += l.granted - l.spent;
    if (l.outcome === "accepted") accepted++;
    if (l.role === "manager") managerSpend += l.spent;

    const r = (byRole[l.role] ??= {
      leases: 0,
      granted: 0,
      spent: 0,
      accepted: 0,
      rejected: 0,
      failed: 0,
      estimateToActual: null,
    });
    r.leases++;
    r.granted += l.granted;
    r.spent += l.spent;
    if (l.outcome === "accepted") r.accepted++;
    else if (l.outcome === "rejected") r.rejected++;
    else if (l.outcome === "failed") r.failed++;
  }

  for (const [role, r] of Object.entries(byRole)) {
    const ratios = leases
      .filter((l) => l.role === role && l.granted > 0 && l.spent > 0 && l.status !== "open")
      .map((l) => l.spent / l.granted);
    r.estimateToActual =
      ratios.length > 0 ? ratios.reduce((s, x) => s + x, 0) / ratios.length : null;
  }

  return {
    runs: runs.size,
    leases: leases.length,
    granted,
    spent,
    reclaimed,
    byRole,
    tasksAccepted: accepted,
    acceptedPer100k: spent > 0 ? (accepted / spent) * 100_000 : 0,
    managerOverheadPct: spent > 0 ? managerSpend / spent : 0,
  };
}

/** Compact plan rendering shared by every surface. */
export function formatPlan(plan: StaffingPlan): string {
  const lines = [
    `run ${plan.runId} · ${plan.heads} agent${plan.heads === 1 ? "" : "s"} · ${plan.totalGranted} tokens allocated (reserve ${plan.reserve})`,
  ];
  if (!plan.feasible) lines.push("  NOT FEASIBLE — see notes");
  for (const r of plan.roster) {
    const absorbed = r.absorbed?.length ? ` +${r.absorbed.join("+")}` : "";
    lines.push(
      `  p${r.phase} ${r.label}${absorbed} [${r.priority}/${r.tier}] ${r.grant} tok → ${r.emits}`,
    );
  }
  if (plan.degraded) {
    for (const s of plan.degraded.steps) lines.push(`  degraded: ${s}`);
  }
  for (const n of plan.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

/** One-line lease rendering shared by every surface. */
export function formatLease(l: LeaseState): string {
  const pct = l.granted > 0 ? Math.round((l.spent / l.granted) * 100) : 0;
  const outcome = l.outcome ? ` ${l.outcome}` : "";
  return `[${l.id}] ${l.role} p${l.phase} ${l.spent}/${l.granted} (${pct}%) ${l.status}${outcome} — ${l.task}`;
}
