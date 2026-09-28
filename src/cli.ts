#!/usr/bin/env node
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assess } from "./governor.js";
import { evaluateGuardrails, readGuardrailRecords } from "./guardrails.js";
import { configDir, Ledger, loadSettings } from "./ledger.js";
import { formatEntry, Memory } from "./memory.js";
import { runMcpStdio } from "./mcp.js";
import { createProxy } from "./proxy.js";
import { computeRunway, formatDuration } from "./runway.js";
import { Store } from "./store.js";
import {
  buildTeamReport,
  DEFAULT_ROLES,
  formatLease,
  formatPlan,
  leasePressure,
  Team,
  type Complexity,
} from "./team.js";
import { aggregateUsage, parseDuration } from "./telemetry.js";

/** Tokens limitbreak saved (compression + shaping + dropped context) in the last `ms`. */
function savedTokensSince(logPath: string, ms: number): number {
  const r = aggregateUsage(logPath, { sinceMs: Date.now() - ms });
  return r.compressionSavedTokens + r.shapingSavedTokens + r.droppedContextTokens;
}

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYBOOKS_DIR = join(PKG_ROOT, "playbooks");
const AGENTS_DIR = join(PKG_ROOT, "agents");
const TEAM_SKILL_DIR = join(PKG_ROOT, "skills", "team");

const START = "<!-- limitbreak:start -->";
const END = "<!-- limitbreak:end -->";

const CLAUDE_MD_BLOCK = `${START}
## Session efficiency (limitbreak)

- Be terse. No preamble, no restating the request, no closing summary beyond one sentence.
- Read only what is needed: targeted file reads (offset/limit) over whole files; never re-read unchanged files.
- Batch independent tool calls in one step; batch related edits per file.
- Delegate wide, exploratory searches to subagents so results stay out of the main context.
- Prefer showing diffs/changed lines over reprinting full files.
- When a task is ambiguous, ask one clarifying question before implementing — a wrong implementation costs far more than a question.
- Full playbooks: .limitbreak/playbooks/
${END}`;

function init(cwd: string): void {
  const dest = join(cwd, ".limitbreak", "playbooks");
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(PLAYBOOKS_DIR)) {
    if (f.endsWith(".md")) copyFileSync(join(PLAYBOOKS_DIR, f), join(dest, f));
  }
  console.log(`✓ playbooks → ${join(".limitbreak", "playbooks")}/`);

  const claudeMd = join(cwd, "CLAUDE.md");
  let content = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
  if (content.includes(START)) {
    const before = content.slice(0, content.indexOf(START));
    const after = content.slice(content.indexOf(END) + END.length);
    content = before + CLAUDE_MD_BLOCK + after;
    console.log("✓ CLAUDE.md limitbreak block updated");
  } else {
    content = content
      ? content.trimEnd() + "\n\n" + CLAUDE_MD_BLOCK + "\n"
      : CLAUDE_MD_BLOCK + "\n";
    console.log("✓ CLAUDE.md limitbreak block added");
  }
  writeFileSync(claudeMd, content, "utf8");
  console.log("\nDone. Coding agents in this project now follow the efficiency rules.");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function globalLogPath(): string {
  return join(configDir(), "usage.jsonl");
}

interface ReportOpts {
  sinceMs?: number;
  sinceLabel?: string;
  markdown?: boolean;
  path?: string;
}

function parseReportArgs(args: string[]): ReportOpts {
  const opts: ReportOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--markdown") opts.markdown = true;
    else if (a === "--since") {
      const spec = args[++i];
      const ms = spec ? parseDuration(spec) : null;
      if (ms === null) {
        console.error(`invalid --since value "${spec ?? ""}" — use forms like 7d, 24h, 30m`);
        process.exit(1);
      }
      opts.sinceMs = Date.now() - ms;
      opts.sinceLabel = spec;
    } else if (!a.startsWith("--")) opts.path = a;
  }
  return opts;
}

/** Formats a dollar figure, or "n/a" when cost can't be valued. */
function money(n: number, known: boolean): string {
  return known ? `$${n.toFixed(4)}` : "n/a";
}

function report(cwd: string, args: string[]): void {
  const opts = parseReportArgs(args);
  const logPath = opts.path ?? join(cwd, ".limitbreak", "usage.jsonl");
  const resolved = existsSync(logPath) ? logPath : globalLogPath();
  const settings = loadSettings();
  const r = aggregateUsage(resolved, { sinceMs: opts.sinceMs, pricing: settings.pricing });
  if (r.calls === 0) {
    console.log(`No usage recorded at ${logPath} or ${globalLogPath()}${opts.sinceLabel ? ` in the last ${opts.sinceLabel}` : ""}`);
    return;
  }

  const period = opts.sinceLabel ? `last ${opts.sinceLabel}` : "all time";
  const dollarsSaved = r.compressionSavedUSD + r.downgradeSavedUSD;
  const tokensSaved = r.compressionSavedTokens + r.shapingSavedTokens + r.droppedContextTokens;

  // Runway: translate this window's savings into time at the current burn — the
  // headline a blind compressor can't produce because it doesn't know your limit.
  const ledger = new Ledger(resolved);
  const eff = ledger.effectiveSettings(settings);
  const worst = assess(ledger.forecasts(eff), eff).worst;
  const budget = worst?.window.budgetTokens ?? 0;
  const headroomPct = budget > 0 ? (tokensSaved / budget) * 100 : 0;
  const rw = worst
    ? computeRunway(worst, savedTokensSince(resolved, worst.window.hours * 3_600_000))
    : null;
  const runwayStr =
    rw && rw.gainedMin !== null && rw.gainedMin >= 1
      ? `+${formatDuration(rw.gainedMin)} of runway before your "${rw.window}" limit (at current burn)`
      : `~${headroomPct.toFixed(1)}% of your worst window's budget`;

  if (opts.markdown) {
    reportMarkdown(r, { period, dollarsSaved, tokensSaved, runwayStr });
    return;
  }

  console.log(`limitbreak usage report (${period})\n`);
  // Tokens are the headline — they're exact and need no pricing.
  console.log(`  ⚡ saved ~${fmt(Math.round(tokensSaved))} tokens — bought ${runwayStr}`);
  console.log(`     compression ${fmt(r.compressionSavedTokens)} tok · shaping ~${fmt(Math.round(r.shapingSavedTokens))} output tok · dropped ctx ${fmt(r.droppedContextTokens)} tok (estimated)`);
  if (r.costComplete) {
    console.log(`     $ saved ${money(dollarsSaved, true)} (compression ${money(r.compressionSavedUSD, true)} + downgrade ${money(r.downgradeSavedUSD, true)})`);
  }
  if (r.limitEvents > 0) console.log(`     ${r.limitEvents} rate-limit observation(s) recorded — budgets auto-calibrating`);
  console.log();
  console.log(`  calls               ${fmt(r.calls)}`);
  console.log(`  input tokens        ${fmt(r.inputTokens)}`);
  console.log(`  output tokens       ${fmt(r.outputTokens)}`);
  console.log(`  cache read tokens   ${fmt(r.cacheReadTokens)} (hit rate ${(r.cacheHitRate * 100).toFixed(1)}%)`);
  console.log(`  cache write tokens  ${fmt(r.cacheWriteTokens)}`);
  console.log(`  dropped ctx tokens  ${fmt(r.droppedContextTokens)}`);
  console.log(`  compression saved   ${fmt(r.compressionSavedTokens)} tokens (estimated)`);
  console.log(`  est. cost           ${money(r.costUSD, r.costComplete)}`);
  if (!r.costComplete) {
    console.log(`    ↳ no pricing for: ${r.unpricedModels.join(", ")}`);
    console.log(`      add a "pricing" map to ~/.limitbreak/config.json for $ estimates (not needed for subscription quotas — tokens above are exact)`);
  }

  for (const [title, bucket] of [
    ["by model", r.byModel],
    ["by tag", r.byTag],
  ] as const) {
    console.log(`\n  ${title}:`);
    for (const [key, b] of Object.entries(bucket).sort((a, b2) => b2[1].costUSD - a[1].costUSD)) {
      const priced = title === "by model" ? !r.unpricedModels.includes(key) : r.costComplete;
      console.log(
        `    ${key.padEnd(28)} ${String(b.calls).padStart(6)} calls  ${fmt(b.inputTokens).padStart(12)} in  ${fmt(b.outputTokens).padStart(10)} out  ${money(b.costUSD, priced).padStart(10)}`,
      );
    }
  }

  if (r.shaping) {
    const s = r.shaping;
    console.log(`\n  output shaping (shaped vs holdout — estimated):`);
    console.log(`    shaped   ${String(s.shapedCalls).padStart(6)} calls  avg ${s.shapedAvgOutput.toFixed(0)} out tokens`);
    console.log(`    holdout  ${String(s.holdoutCalls).padStart(6)} calls  avg ${s.holdoutAvgOutput.toFixed(0)} out tokens`);
    console.log(`    est. output reduction ${(s.estOutputReductionPct * 100).toFixed(1)}%`);
  }
}

function reportMarkdown(
  r: ReturnType<typeof aggregateUsage>,
  h: { period: string; dollarsSaved: number; tokensSaved: number; runwayStr: string },
): void {
  const lines = [
    `## limitbreak savings — ${h.period}`,
    "",
    `**Saved ~${fmt(Math.round(h.tokensSaved))} tokens** — bought ${h.runwayStr}.` +
      (r.costComplete ? ` Est. $${h.dollarsSaved.toFixed(4)} saved.` : ""),
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Calls | ${fmt(r.calls)} |`,
    `| Input tokens | ${fmt(r.inputTokens)} |`,
    `| Output tokens | ${fmt(r.outputTokens)} |`,
    `| Cache hit rate | ${(r.cacheHitRate * 100).toFixed(1)}% |`,
    `| Est. cost | ${money(r.costUSD, r.costComplete)} |`,
    `| Compression saved | ${fmt(r.compressionSavedTokens)} tok${r.costComplete ? ` (${money(r.compressionSavedUSD, true)})` : ""} |`,
    `| Downgrade saved | ${r.costComplete ? money(r.downgradeSavedUSD, true) : "n/a"} |`,
    `| Shaping saved (est.) | ${fmt(Math.round(r.shapingSavedTokens))} output tok |`,
    `| Rate-limit observations | ${fmt(r.limitEvents)} |`,
  ];
  if (!r.costComplete) {
    lines.push(`| Cost note | no pricing for ${r.unpricedModels.join(", ")} — set \`pricing\` in config.json |`);
  }
  if (r.shaping) {
    lines.push(
      `| Output reduction (shaped vs holdout) | ${(r.shaping.estOutputReductionPct * 100).toFixed(1)}% |`,
    );
  }
  console.log(lines.join("\n"));
}

function up(portArg?: string): void {
  const port = Number(portArg ?? 8787);
  const settings = loadSettings();
  const ledger = new Ledger(globalLogPath());
  const server = createProxy({ ledger, settings });
  server.listen(port, () => {
    console.log(`limitbreak listening on http://localhost:${port}`);
    console.log(`  Anthropic surface : ANTHROPIC_BASE_URL=http://localhost:${port}`);
    console.log(`  OpenAI surface    : OPENAI_BASE_URL=http://localhost:${port}/openai/v1`);
    console.log(`  dashboard         : http://localhost:${port}/`);
    console.log(`  status (json)     : http://localhost:${port}/status`);
    console.log(`  retrieval         : http://localhost:${port}/retrieve/<id>`);
    console.log(`  memory            : http://localhost:${port}/memory`);
    console.log(`  ledger            : ${globalLogPath()}`);
  });
}

function bar(pct: number, width = 24): string {
  const filled = Math.min(width, Math.round(pct * width));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function status(): void {
  const settings = loadSettings();
  const ledger = new Ledger(globalLogPath());
  const eff = ledger.effectiveSettings(settings);
  const calibration = ledger.calibration(settings);
  const a = assess(ledger.forecasts(eff), eff);
  const icon = { green: "●", yellow: "◐", red: "○" }[a.level];
  console.log(`runway: ${icon} ${a.level.toUpperCase()}\n`);
  for (const f of a.forecasts) {
    const c = calibration[f.window.name];
    const note = settings.windowsExplicit
      ? ""
      : c
        ? `  (calibrated from ${c.samples} ${c.source === "observed-429" ? "429s" : "warnings"})`
        : "  (placeholder default)";
    console.log(
      `  ${f.window.name.padEnd(4)} ${bar(f.pct)} ${(f.pct * 100).toFixed(1).padStart(5)}%  ${fmt(f.usedTokens)}/${fmt(f.window.budgetTokens)} tokens${note}`,
    );
  }
  const w = a.worst;
  if (w) {
    console.log(`\n  burn rate  ${fmt(Math.round(w.burnPerMin))} tokens/min (trailing 30m)`);
    const rw = computeRunway(w, savedTokensSince(globalLogPath(), w.window.hours * 3_600_000));
    if (rw.runwayMin === null) {
      console.log(`  runway     idle — no recent burn to project against`);
    } else if (rw.runwayMin <= 0) {
      console.log(`  runway     "${w.window.name}" limit is EXHAUSTED`);
    } else {
      console.log(`  runway     ~${formatDuration(rw.runwayMin)} before the "${w.window.name}" limit at this pace`);
    }
    if (rw.gainedMin !== null && rw.gainedMin >= 1) {
      console.log(`  ⚡ limitbreak bought you +${formatDuration(rw.gainedMin)} of runway (saved ${fmt(Math.round(rw.savedTokens))} tok in this window)`);
    }
  }

  if (settings.guardrails.enabled) {
    const recs = readGuardrailRecords(globalLogPath(), Date.now() - settings.guardrails.lookbackHours * 3_600_000);
    const v = evaluateGuardrails(recs, settings.guardrails);
    if (v.shaping.disabled) console.log(`\n  ⚠ auto-revert: shaping OFF — ${v.shaping.reason}`);
    if (v.downgrade.disabled) console.log(`\n  ⚠ auto-revert: downgrade OFF — ${v.downgrade.reason}`);
  }

  console.log(`\n  budgets are set in ~/.limitbreak/config.json (defaults are placeholders)`);
}

function retrieve(id?: string): void {
  if (!id) {
    console.error("usage: limitbreak retrieve <id>");
    process.exit(1);
  }
  const store = new Store(join(configDir(), "store"));
  const original = store.load(id);
  if (original === null) {
    console.error(`no stored content for id ${id}`);
    process.exit(1);
  }
  process.stdout.write(original);
}

function memoryCmd(args: string[]): void {
  const mem = new Memory(join(configDir(), "memory.jsonl"));
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
    case undefined: {
      const entries = mem.list();
      if (entries.length === 0) return console.log("no memories yet — add one with: limitbreak memory add <text>");
      for (const e of entries) console.log(formatEntry(e));
      return;
    }
    case "add": {
      let key: string | undefined;
      const tags: string[] = [];
      const words: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--key") key = rest[++i];
        else if (a === "--tag") {
          const t = rest[++i];
          if (t) tags.push(t);
        } else if (a !== undefined) words.push(a);
      }
      const text = words.join(" ");
      if (!text.trim()) {
        console.error("usage: limitbreak memory add <text> [--key k] [--tag t]");
        process.exit(1);
      }
      try {
        const entry = mem.remember({ text, ...(key && { key }), ...(tags.length > 0 && { tags }) });
        console.log(`✓ remembered ${formatEntry(entry)}`);
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(1);
      }
      return;
    }
    case "rm": {
      const id = rest[0];
      if (!id) {
        console.error("usage: limitbreak memory rm <id>");
        process.exit(1);
      }
      if (mem.forget(id)) console.log(`✓ forgot ${id}`);
      else {
        console.error(`no memory with id ${id}`);
        process.exit(1);
      }
      return;
    }
    default:
      console.error("usage: limitbreak memory [list|add <text> [--key k] [--tag t]|rm <id>]");
      process.exit(1);
  }
}

const COMPLEXITIES: Complexity[] = ["trivial", "small", "medium", "large"];

/** Remaining tokens in the tightest window — what a team is actually staffed against. */
function poolTokens(): number {
  const settings = loadSettings();
  const ledger = new Ledger(globalLogPath());
  const eff = ledger.effectiveSettings(settings);
  const worst = assess(ledger.forecasts(eff), eff).worst;
  if (!worst) return 0;
  return Math.max(0, worst.window.budgetTokens - worst.usedTokens);
}

function teamCmd(args: string[]): void {
  const settings = loadSettings();
  const team = new Team(join(configDir(), "team.jsonl"), settings.team);
  const [sub, ...rest] = args;

  switch (sub ?? "status") {
    case "init": {
      // Role definitions and the manager skill are Claude Code assets, so they
      // install into .claude/ rather than .limitbreak/ — globally by default so
      // a team is available in every project, not just this one.
      const base = rest.includes("--project") ? process.cwd() : homedir();
      const agentsDest = join(base, ".claude", "agents");
      mkdirSync(agentsDest, { recursive: true });
      const installed: string[] = [];
      for (const f of readdirSync(AGENTS_DIR)) {
        if (!f.endsWith(".md")) continue;
        copyFileSync(join(AGENTS_DIR, f), join(agentsDest, f));
        installed.push(f.replace(/\.md$/, ""));
      }
      const skillDest = join(base, ".claude", "skills", "team");
      mkdirSync(skillDest, { recursive: true });
      for (const f of readdirSync(TEAM_SKILL_DIR)) {
        if (f.endsWith(".md")) copyFileSync(join(TEAM_SKILL_DIR, f), join(skillDest, f));
      }
      console.log(`✓ roles → ${agentsDest}/  (${installed.sort().join(", ")})`);
      console.log(`✓ manager skill → ${skillDest}/`);
      console.log(`\nRegister the MCP server so agents can draw on their leases:`);
      console.log(`  claude mcp add limitbreak -- limitbreak mcp`);
      console.log(`\nThen run a team with:  /team <goal>`);
      return;
    }
    case "plan": {
      const words: string[] = [];
      let complexity: Complexity = "medium";
      let width: number | undefined;
      let budget: number | undefined;
      let dry = false;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === undefined) continue;
        if (a === "--dry-run") dry = true;
        else if (a === "--complexity") {
          const v = rest[++i];
          if (!v || !COMPLEXITIES.includes(v as Complexity)) {
            console.error(`invalid --complexity "${v ?? ""}" — use one of ${COMPLEXITIES.join(", ")}`);
            process.exit(1);
          }
          complexity = v as Complexity;
        } else if (a === "--width") {
          width = Number(rest[++i]);
          if (!Number.isFinite(width) || width < 1) {
            console.error("--width must be a positive number of independent work units");
            process.exit(1);
          }
        } else if (a === "--budget") {
          budget = Number(rest[++i]);
          if (!Number.isFinite(budget) || budget <= 0) {
            console.error("--budget must be a positive token count");
            process.exit(1);
          }
        } else if (!a.startsWith("--")) words.push(a);
      }
      const goal = words.join(" ");
      if (!goal.trim()) {
        console.error("usage: limitbreak team plan <goal> [--complexity trivial|small|medium|large] [--width N] [--budget N] [--dry-run]");
        process.exit(1);
      }
      const available = budget ?? poolTokens();
      const plan = team.plan({
        goal,
        complexity,
        ...(width !== undefined && { parallelWidth: width }),
        availableTokens: available,
      });
      console.log(`pool: ${fmt(available)} tokens available${budget === undefined ? " (remaining quota)" : ""}\n`);
      console.log(formatPlan(plan));
      if (!plan.feasible) {
        console.log("\nNot feasible — cut the scope, wait for the window to recover, or pass --budget deliberately.");
        process.exit(1);
      }
      if (dry) {
        console.log("\ndry run — no leases opened");
        return;
      }
      console.log("\nLeases opened:");
      for (const l of team.openPlan(plan)) {
        console.log(`  ${l.role} → ${l.id} · ${fmt(l.granted)} tokens · phase ${l.phase}`);
      }
      console.log(`\nGive each agent its own lease id. Track with: lb team status ${plan.runId}`);
      return;
    }
    case "status": {
      const runId = rest[0];
      const leases = team.leases(runId);
      if (leases.length === 0) {
        console.log(runId ? `no leases for run ${runId}` : "no team leases recorded");
        return;
      }
      for (const l of leases) {
        console.log(`${formatLease(l)} [${leasePressure(l, settings.team)}]`);
      }
      if (runId) {
        const { tokens, leases: done } = team.reclaimable(runId);
        console.log(`\nreclaimable at next boundary: ${fmt(tokens)} tokens from ${done.length} finished lease(s)`);
      }
      return;
    }
    case "report": {
      const r = buildTeamReport(team.leases(rest[0]));
      if (r.leases === 0) {
        console.log("No team runs recorded yet. Start one with: lb team plan <goal>");
        return;
      }
      console.log(`limitbreak team — ${r.runs} run(s), ${r.leases} lease(s)\n`);
      console.log(`  spent:        ${fmt(r.spent)} tokens of ${fmt(r.granted)} granted`);
      console.log(`  reclaimed:    ${fmt(r.reclaimed)} tokens returned from unspent leases`);
      console.log(`  accepted:     ${r.tasksAccepted} task(s) → ${r.acceptedPer100k.toFixed(2)} per 100k tokens`);
      console.log(`  coordination: ${(r.managerOverheadPct * 100).toFixed(1)}% of spend went to the manager`);
      console.log(`\n  role         leases   spent      est→actual`);
      for (const [role, b] of Object.entries(r.byRole).sort()) {
        const ratio = b.estimateToActual === null ? "—" : `${b.estimateToActual.toFixed(2)}x`;
        console.log(
          `  ${role.padEnd(12)} ${String(b.leases).padStart(6)}   ${fmt(b.spent).padStart(9)}   ${ratio.padStart(9)}`,
        );
      }
      console.log(
        "\n  est→actual above 1.00x means the role habitually overruns its grant; below means it is over-funded.",
      );
      return;
    }
    case "roles": {
      console.log(`limitbreak team roles (size: ${settings.team.size}, maxAgents: ${settings.team.maxAgents}, reserve: ${(settings.team.reserve * 100).toFixed(0)}%)\n`);
      console.log(`  role         pri/tier      grant(p80)   floor(p20)   samples`);
      for (const spec of DEFAULT_ROLES) {
        const e = team.estimate(spec.name);
        console.log(
          `  ${spec.name.padEnd(12)} ${`${spec.priority}/${spec.tier}`.padEnd(13)} ${fmt(e.p80).padStart(10)}   ${fmt(e.minViable).padStart(10)}   ${String(e.samples).padStart(7)}${e.source === "seed" ? " (seed)" : ""}`,
        );
      }
      console.log("\n  Grants and floors switch from seeds to observed percentiles after 3 closed leases per role.");
      return;
    }
    default:
      console.error("usage: limitbreak team [init [--project]|plan <goal> [--complexity c] [--width N] [--budget N] [--dry-run]|status [runId]|report [runId]|roles]");
      process.exit(1);
  }
}

const WRAP_START = "# >>> limitbreak wrap >>>";
const WRAP_END = "# <<< limitbreak wrap <<<";

function rcPath(): string {
  return join(homedir(), process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc");
}

function wrap(target?: string, apply?: string): void {
  const port = 8787;
  const lines =
    target === "openai-app"
      ? [`export OPENAI_BASE_URL=http://localhost:${port}/openai/v1`]
      : [`export ANTHROPIC_BASE_URL=http://localhost:${port}`];
  if (apply !== "--apply") {
    console.log(`Run these in the shell you launch your agent from (or persist with: limitbreak wrap ${target ?? "claude"} --apply):\n`);
    for (const l of lines) console.log(`  ${l}`);
    console.log(`\nThen start the daemon with: limitbreak up`);
    return;
  }
  const rc = rcPath();
  let content = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const block = `${WRAP_START}\n${lines.join("\n")}\n${WRAP_END}`;
  if (content.includes(WRAP_START)) {
    content =
      content.slice(0, content.indexOf(WRAP_START)) +
      block +
      content.slice(content.indexOf(WRAP_END) + WRAP_END.length);
  } else {
    content = content.trimEnd() + "\n\n" + block + "\n";
  }
  writeFileSync(rc, content, "utf8");
  console.log(`✓ wrap block written to ${rc} — open a new shell (or source it) and run: limitbreak up`);
}

function unwrap(): void {
  const rc = rcPath();
  if (!existsSync(rc)) return console.log("nothing to unwrap");
  const content = readFileSync(rc, "utf8");
  if (!content.includes(WRAP_START)) return console.log("nothing to unwrap");
  const cleaned =
    content.slice(0, content.indexOf(WRAP_START)).trimEnd() +
    "\n" +
    content.slice(content.indexOf(WRAP_END) + WRAP_END.length).replace(/^\n+/, "");
  writeFileSync(rc, cleaned, "utf8");
  console.log(`✓ wrap block removed from ${rc}`);
}

const [, , cmd, arg, arg2] = process.argv;
switch (cmd) {
  case "init":
    init(process.cwd());
    break;
  case "report":
    report(process.cwd(), process.argv.slice(3));
    break;
  case "up":
    up(arg === "--port" ? arg2 : undefined);
    break;
  case "status":
    status();
    break;
  case "retrieve":
    retrieve(arg);
    break;
  case "wrap":
    wrap(arg, arg2);
    break;
  case "unwrap":
    unwrap();
    break;
  case "mcp":
    runMcpStdio();
    break;
  case "memory":
    memoryCmd(process.argv.slice(3));
    break;
  case "team":
    teamCmd(process.argv.slice(3));
    break;
  default:
    console.log(`limitbreak — never hit the wall. The quota governor for LLM usage limits.

Usage:
  limitbreak up [--port 8787]        start the governor (proxy + ledger + forecaster + optimizer)
  limitbreak status                  runway (quota level), window usage, burn rate, exhaustion forecast
  limitbreak wrap claude|openai-app  route an agent/app through the daemon (--apply persists to shell rc)
  limitbreak unwrap                  remove the wrap block from the shell rc
  limitbreak retrieve <id>           print the original of a compressed block
  limitbreak mcp                     run as an MCP server over stdio (status, retrieve, report, remember, recall, team tools)
  limitbreak memory [list|add <text> [--key k] [--tag t]|rm <id>]
                                     cross-agent memory: notes shared by every agent on this machine
  limitbreak team init [--project]   install the role definitions + /team manager skill into .claude/ (global unless --project)
  limitbreak team [plan <goal>|status [runId]|report [runId]|roles]
                                     staff a multi-agent run against remaining quota: headcount, roles, per-agent token leases
  limitbreak init                    install playbooks + CLAUDE.md efficiency rules into this project
  limitbreak report [path] [--since 7d] [--markdown]
                                     usage + savings headline (tokens saved, runway gained); --markdown for a paste-ready summary

  (also available as: lb)
`);
    process.exit(cmd ? 1 : 0);
}
