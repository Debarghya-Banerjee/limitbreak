# limitbreak

**Never hit the wall.** limitbreak is the *quota governor* for LLM usage limits: it meters how much of your budget is left, forecasts when you'll run out, and turns optimization up **only as you approach the limit** — so you finish the task instead of getting cut off mid-flight.

```sh
npm install -g limitbreak
lb up             # start the governor
lb wrap claude    # route Claude Code through it
lb status         # ● GREEN — 5h window 31.2%, exhausts in ~3h 40m at current burn
```

Then open `http://localhost:8787/` for the live dashboard. Everything is local-first and zero-dependency: one daemon that meters, forecasts, optimizes under pressure, proves its savings — and gives all your agents a shared memory.

## The idea

Every other token tool — headroom, caveman, rtk — optimizes **blindly and constantly**: it applies the same compression at 5% of your limit as at 95%. But every optimization costs some fidelity. Pay that cost all the time and you degrade quality for no reason; pay it never and you slam into your 5-hour or weekly limit in the middle of a task.

The thing that actually matters is the one thing a compressor can't see: **how much budget you have left.** limitbreak is the layer that closes the loop.

> **It knows your remaining quota, and spends the least fidelity necessary to keep you under the limit.**

Green, it touches nothing. As pressure rises, it trims, then compresses hard, downgrades the model, and defers deferrable work — backing off the instant your window refills. A compressor gives you *fewer tokens*. limitbreak gives you ***runway***.

| Quota level | Meter | Compress | Terse steering | Model downgrade | Defer batch work |
| --- | :-: | :-: | :-: | :-: | :-: |
| ● green (<70%) | ✓ | light | — | — | — |
| ◐ yellow (≥70%) | ✓ | standard | ✓ | ✓ (opt-in) | — |
| ○ red (≥90%) | ✓ | aggressive | ✓ | ✓ (opt-in) | ✓ (429 + retry-after) |

## Why a governor, not another compressor

limitbreak doesn't compete with headroom or caveman — it sits **above** them. Compression is a commodity; deciding *when* it's worth the fidelity hit is not. That decision needs metering, forecasting, and a live view of your limit — which is the whole product:

- **Meter** — every call from every surface (proxied agents, SDK, any OpenAI-compatible app) lands in one local ledger (`~/.limitbreak/usage.jsonl`): tokens, cache hits, tags.
- **Forecast** — configurable quota windows (5h, weekly, monthly…) with burn-rate exhaustion estimates ("exhausts in ~42 min") and **budgets auto-calibrated from observed 429s** — because providers don't publish subscription limits.
- **Govern** — the pressure policies above: escalate optimization as the window fills, back off as it drains, defer/downgrade only when it's actually needed.
- **Prove** — a 10% holdout passes through untouched, so `lb report` shows *measured* deltas and, crucially, **runway gained** — a number no always-on compressor can state, because it doesn't know your limit.
- **Auto-revert** — that same holdout is a live control group: if a policy makes things *measurably* worse than the untouched baseline (higher provider-error or output-truncation rate, or it isn't even saving tokens), limitbreak disables it automatically and re-tests once the signal clears. No quality oracle, no config — just "don't keep doing what's hurting."

The optimizer limitbreak drives is **pluggable**. Out of the box it's a built-in, deterministic, **reversible** compressor (JSON arrays sampled, duplicate log lines collapsed `[×47]`, errors kept verbatim, prose head/tailed; originals recoverable via `lb retrieve <id>`) — intentionally simple and zero-dependency, because the governance is the moat, not the compression. When you want maximum reduction, point limitbreak at a heavier compressor (headroom, rtk, …) and it becomes muscle the governor fires *only under pressure*:

```json
{ "compressionBackend": { "command": ["headroom", "compress", "--max-tokens", "{budget}"] } }
```

The contract is dead simple: the command reads a tool-result block on **stdin** and writes the compressed text on **stdout**; `{budget}` is replaced with the target token count for the current pressure level. limitbreak keeps everything that makes it a governor — the min-token threshold, storing the original for reversibility, the retrieval marker, and token accounting — and delegates only the raw text→text step. If the backend errors or times out, the block passes through untouched, so a flaky compressor can never break a request. (External compressors may be non-deterministic, which can cost you prompt-cache hits on re-sent history; the built-in stays deterministic for that reason.)

## Modes

**Proxy (zero code changes)** — wraps any agent or app that honors a base-URL env var:

```sh
lb up
export ANTHROPIC_BASE_URL=http://localhost:8787            # Claude Code, etc.
export OPENAI_BASE_URL=http://localhost:8787/openai/v1     # OpenAI-compatible apps
```

Headers: `x-limitbreak-tag: <feature>` buckets telemetry; `x-limitbreak-defer: allow` marks a call safe to reject under red pressure (you get a 429 with `retry-after`).

**SDK (TypeScript, zero dependencies)** — routes by task to the cheapest capable tier and obeys quota pressure (fails open if the governor is unreachable):

```ts
import { Limitbreak } from "limitbreak";

const ai = new Limitbreak({
  providers: { anthropic: { apiKey: process.env.ANTHROPIC_API_KEY } },
  budget: { maxInputTokens: 8000, maxOutputTokens: 800 },
  governor: { url: "http://localhost:8787" },  // obeys quota pressure, fails open
});

const res = await ai.complete({
  task: "classify",              // routed to the fast tier
  system: RUBRIC,                // stable → cached prefix
  context: [{ text: DOCS, pinned: true }, { text: details, priority: 2 }],
  prompt: userQuery,
  schema: VerdictSchema,         // constrained output
  tag: "listing-verdict",
});
```

**MCP server** — lets an agent read its own remaining runway and act on it:

```sh
claude mcp add limitbreak -- lb mcp
```

```json
{ "mcpServers": { "limitbreak": { "command": "lb", "args": ["mcp"] } } }
```

Tools: `limitbreak_status` (level, burn, forecast — so the agent knows when to conserve), `limitbreak_retrieve` (recover a compressed block), `limitbreak_remember` / `limitbreak_recall` (cross-agent memory, below), `limitbreak_report` (usage + runway). Reads the ledger directly, so it works even when the daemon is down.

**Cross-agent memory** — a shared recall store every agent and session on this machine can read and write. A fact one session paid tokens to derive (project conventions, decisions, gotchas) gets distilled into a note once, and every other agent — Claude Code via MCP, an SDK app over HTTP, you at the shell — recalls it for near-zero tokens instead of re-deriving it:

```sh
lb memory add "staging deploys from the release/* branches only" --tag deploy
lb memory list                       # every note, oldest first
lb memory rm <id>
```

Agents use the MCP tools (`limitbreak_remember` supports a stable `key` for update-in-place; `limitbreak_recall` does keyword search with optional tag filter), or the daemon's HTTP surface: `POST /memory`, `GET /memory?q=<terms>&tag=<tag>`, `DELETE /memory/<id>`. Notes live in `~/.limitbreak/memory.jsonl` (append-only, safe under concurrent writers), support optional `ttlHours` expiry, and are capped at 16 KB each — memory is for distilled facts, not raw content (that's what the compression store is for).

**Dashboard** — once `lb up` is running, open `http://localhost:8787/` for a live view: runway front and center, quota-window bars, burn rate, savings, and any active auto-reverts. It's a single self-contained page (no framework, no build, no external assets) served by the daemon, polling a `GET /stats` JSON endpoint you can also scrape yourself.

**Playbooks** — `lb init` installs session-efficiency rules into a project's `CLAUDE.md` and drops usage guides in `.limitbreak/playbooks/`.

## Configuration

`~/.limitbreak/config.json` — all keys optional. Providers don't publish subscription budgets, so if you leave `windows` unset limitbreak **auto-calibrates** them from observed 429s (never guessing above the hardest evidence); set `windows` explicitly to override, or `"autoCalibrate": false` to pin the defaults. `lb status` annotates which budgets are calibrated vs. placeholder.

```json
{
  "windows": [
    { "name": "5h", "hours": 5, "budgetTokens": 2000000 },
    { "name": "7d", "hours": 168, "budgetTokens": 15000000 }
  ],
  "yellowPct": 0.7,
  "redPct": 0.9,
  "holdout": 0.1,
  "compression": { "green": "light", "yellow": "standard", "red": "aggressive" },
  "compressMinTokens": 500,
  "autoCalibrate": true,
  "downgrade": { "claude-opus-4-7": "claude-sonnet-4-6" },
  "guardrails": { "enabled": true, "minSamples": 20, "errorMargin": 0.05, "truncationMargin": 0.05, "lookbackHours": 6 }
}
```

**Auto-revert guardrails** compare the shaped group against the 10% holdout over a trailing window: if shaping (or downgrade specifically) shows a higher provider-error rate, higher truncation rate, or fails to save tokens — beyond the margins, and only past `minSamples` per group — that policy is disabled and re-tested later. `lb status` flags any active revert. Set `"guardrails": { "enabled": false }` to pin policies on.

**Cost is opt-in.** limitbreak governs *tokens and quota windows*, not dollars — and subscription users (Pro/Max) have no per-token cost anyway. So the report leads with token savings and runway gained, which are always exact. Dollar figures are best-effort: models with no known price show `n/a` (never a misleading `$0`). To get $ estimates as a pay-as-you-go API user, add your own rates:

```json
{ "pricing": { "claude-opus-4-8": [5, 25] } }   // $/MTok [input, output]
```

The in-repo table in `src/router.ts` is just an optional convenience seed, not a maintained source of truth.

## CLI

```
lb up [--port 8787]        start the governor (proxy + ledger + forecaster + optimizer)
lb status                  quota level, usage bars, burn rate, exhaustion forecast
lb wrap claude|openai-app  route an agent through the governor (--apply persists to shell rc)
lb unwrap                  undo wrap
lb retrieve <id>           print the original of any compressed block
lb mcp                     run as an MCP server over stdio (status, retrieve, report, remember, recall tools)
lb memory [list|add <text> [--key k] [--tag t]|rm <id>]
                           cross-agent memory: notes shared by every agent on this machine
lb init                    install playbooks + CLAUDE.md rules into a project
lb report [path] [--since 7d] [--markdown]
                           runway + savings headline (tokens saved, runway gained) + full breakdown; --markdown for a paste-ready summary
```

## Development

```sh
npm run build   # tsc
npm test        # build + every suite: smoke, governor, compression, mcp, calibrate, report, backends, runway, guardrails, dashboard, memory (no network; mock upstream)
```
