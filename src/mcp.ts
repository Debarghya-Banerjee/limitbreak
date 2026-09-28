import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assess } from "./governor.js";
import { evaluateGuardrails, readGuardrailRecords } from "./guardrails.js";
import { configDir as defaultConfigDir, Ledger, loadSettings } from "./ledger.js";
import { formatEntry, Memory } from "./memory.js";
import { computeRunway, formatDuration } from "./runway.js";
import { Store } from "./store.js";
import {
  buildTeamReport,
  formatLease,
  formatPlan,
  leasePressure,
  Team,
  type Complexity,
  type LeaseOutcome,
} from "./team.js";
import { aggregateUsage, parseDuration } from "./telemetry.js";

/** Tokens limitbreak saved (compression + shaping + dropped context) in the last `ms`. */
function savedTokensSince(logPath: string, ms: number): number {
  const r = aggregateUsage(logPath, { sinceMs: Date.now() - ms });
  return r.compressionSavedTokens + r.shapingSavedTokens + r.droppedContextTokens;
}

const COMPLEXITIES = new Set<Complexity>(["trivial", "small", "medium", "large"]);
const OUTCOMES = new Set<LeaseOutcome>(["accepted", "rejected", "failed"]);

/**
 * Tokens still available in the tightest quota window — the pool a team is
 * actually staffed against. Staffing off remaining quota rather than a fixed
 * number is the whole point: the same goal gets a full roster at the start of a
 * window and a merged pair near the wall.
 */
function remainingTokens(logPath: string, configPath: string): number {
  const settings = loadSettings(configPath);
  const ledger = new Ledger(logPath);
  const eff = ledger.effectiveSettings(settings);
  const worst = assess(ledger.forecasts(eff), eff).worst;
  if (!worst) return 0;
  return Math.max(0, worst.window.budgetTokens - worst.usedTokens);
}

const KNOWN_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOLS = [
  {
    name: "limitbreak_status",
    description:
      "Current LLM quota runway from the limitbreak ledger: pressure level (green/yellow/red), per-window usage vs budget, burn rate, and exhaustion forecast. Call this to decide whether to conserve tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "limitbreak_retrieve",
    description:
      "Fetch the original, uncompressed content of a limitbreak-compressed block. Call this whenever you encounter a marker like \"[limitbreak: compressed X→Y tokens · full content: retrieve id <id>]\" and you need the full content.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "12-character hex id from the compression marker" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "limitbreak_remember",
    description:
      "Save a short note to limitbreak's cross-agent memory, shared by every agent and session on this machine. Use it for durable, distilled facts other sessions would otherwise re-derive (project conventions, decisions, gotchas) — so those tokens are paid once, not per session. Pass a key to make the note updatable in place.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note to remember (short and distilled)" },
        key: {
          type: "string",
          description: "Optional stable key — remembering the same key again replaces the note",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for filtering recall",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "limitbreak_recall",
    description:
      "Search limitbreak's cross-agent memory for notes saved by any agent or session on this machine. Call this before re-deriving project facts from scratch — a past session may have already paid for the answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for" },
        tag: { type: "string", description: "Only return notes carrying this tag" },
        limit: { type: "number", description: "Max notes to return (default 5)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "limitbreak_report",
    description:
      "Usage and savings report from the limitbreak ledger: calls, tokens, cache hit rate, estimated cost, compression and shaping savings, broken down by model and tag.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: 'Optional period like "7d", "24h", or "30m". Omit for all time.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "limitbreak_team_plan",
    description:
      "Staff a multi-agent run: decides how many agents to use, which roles, and how many tokens each gets, sized against your REMAINING quota. Call this before spawning any subagents. Returns a roster with a lease id per agent — pass each agent its own lease id so its usage is metered separately. Refuses up front when the budget cannot fund a viable team, so you find out before spending anything.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What the team is being asked to deliver" },
        complexity: {
          type: "string",
          enum: ["trivial", "small", "medium", "large"],
          description:
            "trivial = one file, no design choice (1 agent); small = 2; medium = 3; large = full roster. Err small — a reviewer on a one-line change is pure overhead.",
        },
        parallelWidth: {
          type: "number",
          description:
            "Count of genuinely INDEPENDENT work units, for developer fan-out. 1 means a single chain. Do not inflate this: extra agents are capped by budget and each one costs a handoff.",
        },
        availableTokens: {
          type: "number",
          description:
            "Tokens the team may draw on. Omit to use remaining quota in the tightest window (the usual choice).",
        },
        dryRun: {
          type: "boolean",
          description: "Plan without opening leases, to compare options first.",
        },
      },
      required: ["goal"],
      additionalProperties: false,
    },
  },
  {
    name: "limitbreak_lease_spend",
    description:
      "Report tokens consumed against your lease and get back your remaining budget. Call this after finishing a significant chunk of work. The reply tells you whether to keep going, converge, or checkpoint immediately — obey it: a lease that runs out mid-task wastes everything it already spent.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Your 12-character lease id" },
        tokens: { type: "number", description: "Tokens consumed since the last report" },
      },
      required: ["id", "tokens"],
      additionalProperties: false,
    },
  },
  {
    name: "limitbreak_lease_close",
    description:
      "Close your lease when your work is done, reporting the outcome. Unspent budget returns to the pool and can fund another agent, so always close rather than leaving a lease open. The outcome is what teaches the estimator, so report it honestly.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Your 12-character lease id" },
        outcome: {
          type: "string",
          enum: ["accepted", "rejected", "failed"],
          description:
            "accepted = delivered what was asked; rejected = delivered but the reviewer sent it back; failed = could not complete",
        },
      },
      required: ["id", "outcome"],
      additionalProperties: false,
    },
  },
  {
    name: "limitbreak_team_status",
    description:
      "Live state of a multi-agent run: every agent's lease, spend against grant, pressure level, and the budget reclaimable at the next phase boundary. Call this between phases to decide whether to hire, merge, or stop.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run id from limitbreak_team_plan. Omit for all runs." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "limitbreak_team_report",
    description:
      "Efficiency report for multi-agent runs: accepted work per 100k tokens, per-role spend, estimate-to-actual ratios (which roles overrun), manager coordination overhead, and budget reclaimed from unspent leases.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Limit to one run. Omit for all time." },
      },
      additionalProperties: false,
    },
  },
];

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf8",
      ),
    );
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function toolText(text: string, isError = false): unknown {
  return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

/**
 * Pure JSON-RPC dispatcher for the MCP stdio server. Reads the ledger, store,
 * and config from disk on every tools/call so it never needs the daemon to be
 * running and always sees fresh data. Returns null for notifications.
 */
export function createMcpHandler(deps?: {
  configDir?: string;
}): (msg: JsonRpcMessage) => JsonRpcResponse | null {
  const dir = deps?.configDir ?? defaultConfigDir();
  const logPath = () => join(dir, "usage.jsonl");
  const configPath = () => join(dir, "config.json");
  const teamPath = () => join(dir, "team.jsonl");

  function callTool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "limitbreak_status": {
        const settings = loadSettings(configPath());
        const ledger = new Ledger(logPath());
        const eff = ledger.effectiveSettings(settings);
        const a = assess(ledger.forecasts(eff), eff);
        const lines = [
          `runway: ${a.level.toUpperCase()}`,
          ...a.forecasts.map(
            (f) =>
              `  ${f.window.name}: ${(f.pct * 100).toFixed(1)}% used (${f.usedTokens}/${f.window.budgetTokens} tokens)` +
              (f.exhaustsAt
                ? `, exhausts in ~${formatDuration(Math.max(0, (f.exhaustsAt - Date.now()) / 60_000))} at current burn`
                : ""),
          ),
        ];
        if (a.worst) {
          lines.push(`  burn rate: ${Math.round(a.worst.burnPerMin)} tokens/min (trailing 30m)`);
          const saved = savedTokensSince(logPath(), a.worst.window.hours * 3_600_000);
          const rw = computeRunway(a.worst, saved);
          if (rw.gainedMin !== null && rw.gainedMin >= 1) {
            lines.push(`  limitbreak bought you +${formatDuration(rw.gainedMin)} of runway (saved ${Math.round(rw.savedTokens)} tok this window)`);
          }
        }
        if (settings.guardrails.enabled) {
          const recs = readGuardrailRecords(logPath(), Date.now() - settings.guardrails.lookbackHours * 3_600_000);
          const v = evaluateGuardrails(recs, settings.guardrails);
          if (v.shaping.disabled) lines.push(`  auto-revert: shaping OFF — ${v.shaping.reason}`);
          if (v.downgrade.disabled) lines.push(`  auto-revert: downgrade OFF — ${v.downgrade.reason}`);
        }
        return toolText(lines.join("\n"));
      }
      case "limitbreak_retrieve": {
        const id = args.id;
        if (typeof id !== "string") {
          return toolText('limitbreak_retrieve requires a string "id" argument', true);
        }
        const original = new Store(join(dir, "store")).load(id);
        if (original === null) return toolText(`no stored content for id ${id}`, true);
        return toolText(original);
      }
      case "limitbreak_remember": {
        if (typeof args.text !== "string") {
          return toolText('limitbreak_remember requires a string "text" argument', true);
        }
        try {
          const entry = new Memory(join(dir, "memory.jsonl")).remember({
            text: args.text,
            ...(typeof args.key === "string" && { key: args.key }),
            ...(Array.isArray(args.tags) && {
              tags: args.tags.filter((t): t is string => typeof t === "string"),
            }),
          });
          return toolText(`remembered ${formatEntry(entry)}`);
        } catch (err) {
          return toolText(String(err instanceof Error ? err.message : err), true);
        }
      }
      case "limitbreak_recall": {
        if (typeof args.query !== "string") {
          return toolText('limitbreak_recall requires a string "query" argument', true);
        }
        const entries = new Memory(join(dir, "memory.jsonl")).recall(args.query, {
          ...(typeof args.tag === "string" && { tag: args.tag }),
          ...(typeof args.limit === "number" && { limit: args.limit }),
        });
        if (entries.length === 0) return toolText("no matching memories");
        return toolText(entries.map(formatEntry).join("\n"));
      }
      case "limitbreak_report": {
        let sinceMs: number | undefined;
        if (typeof args.since === "string") {
          const dur = parseDuration(args.since);
          if (dur === null) {
            return toolText(`invalid "since" value "${args.since}" — use forms like 7d, 24h, 30m`, true);
          }
          sinceMs = Date.now() - dur;
        }
        const r = aggregateUsage(logPath(), { sinceMs, pricing: loadSettings(configPath()).pricing });
        return toolText(JSON.stringify(r, null, 2));
      }
      case "limitbreak_team_plan": {
        if (typeof args.goal !== "string" || !args.goal.trim()) {
          return toolText('limitbreak_team_plan requires a non-empty string "goal" argument', true);
        }
        let complexity: Complexity = "medium";
        if (args.complexity !== undefined) {
          if (typeof args.complexity !== "string" || !COMPLEXITIES.has(args.complexity as Complexity)) {
            return toolText(
              `invalid "complexity" — use one of ${[...COMPLEXITIES].join(", ")}`,
              true,
            );
          }
          complexity = args.complexity as Complexity;
        }
        const settings = loadSettings(configPath());
        const team = new Team(teamPath(), settings.team);
        const available =
          typeof args.availableTokens === "number" && args.availableTokens > 0
            ? Math.floor(args.availableTokens)
            : remainingTokens(logPath(), configPath());
        const plan = team.plan({
          goal: args.goal,
          complexity,
          ...(typeof args.parallelWidth === "number" && { parallelWidth: args.parallelWidth }),
          availableTokens: available,
        });
        const lines = [`pool: ${available} tokens available`, formatPlan(plan)];
        if (!plan.feasible) {
          lines.push(
            "",
            "Do not spawn agents. Cut the scope, wait for the window to recover, or pass availableTokens deliberately.",
          );
          return toolText(lines.join("\n"), true);
        }
        if (args.dryRun === true) {
          lines.push("", "dry run — no leases opened");
          return toolText(lines.join("\n"));
        }
        const leases = team.openPlan(plan);
        lines.push("", "Give each agent its own lease id, and only that one:");
        for (const l of leases) {
          lines.push(`  ${l.role} → lease ${l.id} · ${l.granted} tokens · phase ${l.phase}`);
        }
        return toolText(lines.join("\n"));
      }
      case "limitbreak_lease_spend": {
        if (typeof args.id !== "string") {
          return toolText('limitbreak_lease_spend requires a string "id" argument', true);
        }
        if (typeof args.tokens !== "number" || !Number.isFinite(args.tokens)) {
          return toolText('limitbreak_lease_spend requires a numeric "tokens" argument', true);
        }
        const settings = loadSettings(configPath());
        try {
          const { lease, pressure, steer } = new Team(teamPath(), settings.team).spend(
            args.id,
            args.tokens,
          );
          const left = Math.max(0, lease.granted - lease.spent);
          const out = [
            `${lease.role}: ${lease.spent}/${lease.granted} tokens used, ~${left} left — ${pressure.toUpperCase()}`,
          ];
          if (steer) out.push(steer);
          // A stop verdict is returned as an error so the calling agent treats it
          // as a hard signal rather than advisory prose it may talk itself past.
          return toolText(out.join("\n"), pressure === "stop");
        } catch (err) {
          return toolText(String(err instanceof Error ? err.message : err), true);
        }
      }
      case "limitbreak_lease_close": {
        if (typeof args.id !== "string") {
          return toolText('limitbreak_lease_close requires a string "id" argument', true);
        }
        if (typeof args.outcome !== "string" || !OUTCOMES.has(args.outcome as LeaseOutcome)) {
          return toolText(`invalid "outcome" — use one of ${[...OUTCOMES].join(", ")}`, true);
        }
        const settings = loadSettings(configPath());
        const closed = new Team(teamPath(), settings.team).close(
          args.id,
          args.outcome as LeaseOutcome,
        );
        if (!closed) return toolText(`no open lease ${args.id}`, true);
        const unspent = Math.max(0, closed.granted - closed.spent);
        return toolText(
          `closed ${formatLease(closed)}` +
            (unspent > 0 ? `\n${unspent} tokens returned to the pool` : ""),
        );
      }
      case "limitbreak_team_status": {
        const settings = loadSettings(configPath());
        const team = new Team(teamPath(), settings.team);
        const runId = typeof args.runId === "string" ? args.runId : undefined;
        const leases = team.leases(runId);
        if (leases.length === 0) return toolText("no team leases recorded");
        const out = leases.map(
          (l) => `${formatLease(l)} [${leasePressure(l, settings.team)}]`,
        );
        if (runId) {
          const { tokens, leases: done } = team.reclaimable(runId);
          out.push(
            `reclaimable at next boundary: ${tokens} tokens from ${done.length} finished lease(s)`,
          );
        }
        return toolText(out.join("\n"));
      }
      case "limitbreak_team_report": {
        const settings = loadSettings(configPath());
        const leases = new Team(teamPath(), settings.team).leases(
          typeof args.runId === "string" ? args.runId : undefined,
        );
        return toolText(JSON.stringify(buildTeamReport(leases), null, 2));
      }
      default:
        return toolText(`unknown tool: ${name}`, true);
    }
  }

  return (msg) => {
    const id = msg.id ?? null;
    const respond = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string): JsonRpcResponse => ({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
    const isNotification = msg.id === undefined;

    try {
      switch (msg.method) {
        case "initialize": {
          const requested = msg.params?.protocolVersion;
          const protocolVersion =
            typeof requested === "string" && KNOWN_PROTOCOL_VERSIONS.has(requested)
              ? requested
              : LATEST_PROTOCOL_VERSION;
          return respond({
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "limitbreak", version: packageVersion() },
          });
        }
        case "ping":
          return respond({});
        case "tools/list":
          return respond({ tools: TOOLS });
        case "tools/call": {
          const name = msg.params?.name;
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          if (typeof name !== "string") return fail(-32602, "tools/call requires params.name");
          return respond(callTool(name, args));
        }
        default:
          if (isNotification) return null; // e.g. notifications/initialized
          return fail(-32601, `method not found: ${msg.method}`);
      }
    } catch (err) {
      if (isNotification) return null;
      return fail(-32603, `limitbreak mcp: ${String(err)}`);
    }
  };
}

/**
 * Newline-delimited JSON-RPC over stdio (the MCP stdio transport). stdout
 * carries protocol messages only — anything else corrupts the stream, so
 * diagnostics go to stderr.
 */
export function runMcpStdio(): void {
  const handle = createMcpHandler();
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        }) + "\n",
      );
      return;
    }
    const res = handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  });
}
