# Context Pack

The single handoff artifact of a limitbreak team run. The planner writes it once;
every later agent reads it **instead of exploring the repo again**.

## Why it exists

A subagent starts cold. Four agents each re-deriving the same repo understanding
costs four times what one agent pays — which would make a team strictly worse
than a soloist. The Context Pack is what inverts that: it is written once, then
handed to every agent verbatim as a stable prefix, so the same content is a cache
read rather than fresh input tokens on every subsequent agent.

Two rules follow, and they are not negotiable:

1. **Verbatim and identical.** Never reword, reorder, summarise, or extend the
   pack when passing it on. A single changed character breaks the cached prefix
   for every agent downstream and the savings vanish.
2. **Self-sufficient.** If a downstream agent has to go read the repo to do its
   job, the pack failed. Exploration is the planner's budget line, nobody else's.

## Format

Keep it under ~400 lines. It is a working brief, not documentation — every line
must be something a later agent would otherwise have spent tokens discovering.

```
# CONTEXT PACK <runId>

## Goal
One paragraph. What ships, in the user's terms.

## Constraints
Hard requirements: compatibility, dependencies that may not be added, style
rules, anything that would make a correct-looking change unacceptable.

## Repo map
Only paths this work touches or must not break. One line each.
  src/foo.ts — request routing; owns the retry loop
  test/foo.mjs — covers routing; add cases here

## Key signatures
Exact current declarations the work depends on, copied not paraphrased, so no
agent has to open the file to recall a type.
  export function route(req: Request, opts?: RouteOpts): Result
  interface RouteOpts { retries?: number; timeoutMs?: number }

## Conventions
What "fits in" means in this codebase: error handling, naming, test idiom,
comment density. Cite one existing file as the exemplar.

## Acceptance criteria
Checkable statements. The reviewer rules against exactly this list, so anything
vague here becomes an argument later.
  - `npm test` passes
  - retries are capped at opts.retries, default 3
  - no new dependencies

## Out of scope
What not to touch. Prevents an agent widening the change on its own initiative.
```

## Downstream artifacts

Each later role appends its own artifact; none rewrites the pack.

- **architect** → `## DESIGN` — approach, then per-file exact changes.
- **developer** → `## DIFF` — files changed, what changed, test results.
- **reviewer** → `## VERDICT` — `accepted` or `rejected`, with findings.
