# limitbreak — Core Principles

Goal: **maximum output quality per unit of usage limit.** Not "use fewer tokens" — spend tokens where they buy quality, eliminate spend that buys nothing, and never hit a limit you didn't see coming.

## 0. Know your headroom

The resource you run out of is not money per request — it's the window: 5-hour caps, weekly caps, rate limits. Meter everything in one ledger, forecast exhaustion, and let optimization intensity *escalate with pressure* instead of being always-on (every optimization has a fidelity cost; pay it only when the budget demands it).

## 1. Route by task, not by habit

Most calls are classification, extraction, or summarization — a fast/cheap model does these as well as a frontier model. Reserve top-tier models for genuine reasoning, novel generation, and ambiguous judgment. A wrong-tier call wastes 10–50x the budget for zero quality gain.

## 2. Make the prefix stable, make the suffix small

Every provider's prompt caching keys on the leading bytes of the request:

- Put **static content first**: system instructions, schemas, reference docs, few-shot examples — identical bytes on every call.
- Put **volatile content last**: the user's actual question, per-request data.
- Never interpolate timestamps, UUIDs, or request IDs into the prefix — one changed byte invalidates the whole cache.

Cached input bills at ~10% of fresh input. On a chat/agent workload, this alone is often a 50–90% input-cost reduction.

## 3. Compress what the model reads, reversibly

Tool outputs, logs, and JSON dumps are mostly noise around a small signal. Compress them content-aware (sample arrays, collapse duplicate log lines, keep errors verbatim) — but always keep the original retrievable, so nothing is ever truly lost. Deterministic compression keeps re-sent history byte-identical, so caches still hit.

## 4. Budget context; don't dump it

Quality *degrades* with irrelevant context — the model must find the signal. Retrieval beats stuffing: send the 3 relevant chunks, not the whole document; assign priorities; measure what you drop.

## 5. Constrain the output

Output tokens cost 4–5x input tokens and dominate latency: structured output when the result feeds code, realistic `max_tokens`, explicit terseness, diffs instead of rewrites.

## 6. One good call beats three bad ones

The most expensive token pattern is the retry loop caused by an under-specified prompt. Front-load requirements, constraints, and examples in the *first* message. For big tasks, get a plan approved before generation.

## 7. Measure, then optimize — and prove it

Log per-call usage. Keep a holdout control group whenever you shape traffic, so savings claims are measured, not assumed. Review weekly: the top-3 spenders are almost always one bad prompt pattern, one wrong-tier route, and one missing cache.

## 8. Move offline work to batch

Anything that doesn't need an interactive answer belongs on the provider's batch API at ~50% price — ideally scheduled into a fresh quota window.

## Surface-specific guides

- [api.md](api.md) — building LLM API features
- [claude-code.md](claude-code.md) — terminal / coding-agent sessions
- [chat-apps.md](chat-apps.md) — desktop & web chat apps
