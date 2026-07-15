# limitbreak — API Feature Checklist

Run this checklist before shipping any code path that calls an LLM API. The `limitbreak` SDK enforces most of it mechanically.

## Pre-flight (design time)

- [ ] **Tier**: what's the cheapest model that passes your eval for this task? Default to `fast` for classify/extract/summarize; escalate only on measured failure.
- [ ] **Prefix stability**: is everything static (system prompt, schema, examples, reference docs) at the front, byte-identical across calls? No timestamps/IDs in the prefix?
- [ ] **Cache breakpoint**: Anthropic — `cache_control` on the static blocks. OpenAI/Gemini — automatic, but only if the prefix is stable.
- [ ] **Context**: retrieved/filtered, not dumped? Is there a max-input budget with a defined drop order?
- [ ] **Output**: schema-constrained if consumed by code? `max_tokens` set to realistic need? Terse instruction if human-read?
- [ ] **Quota-aware**: does this feature back off (defer, downgrade) when the governor reports pressure? Mark batch-able calls deferrable.
- [ ] **Batch**: does this need to be interactive at all? Batch APIs are ~50% price.

## In code (what the SDK does for you)

```ts
import { Limitbreak } from "limitbreak";

const ai = new Limitbreak({
  providers: {
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  },
  budget: { maxInputTokens: 8000, maxOutputTokens: 800 },
  governor: { url: "http://localhost:8787" },   // obey quota pressure
});

const verdict = await ai.complete({
  task: "classify",                  // → routed to the fast tier
  system: RUBRIC,                    // stable → cached prefix
  context: [
    { text: GUIDELINES, pinned: true },       // cached with the prefix
    { text: listingDetails, priority: 2 },    // packed under budget
    { text: neighborhoodInfo, priority: 1 },  // dropped first if over
  ],
  prompt: userQuery,                 // volatile → suffix
  schema: VerdictSchema,             // constrained output
  tag: "vastu-verdict",              // telemetry bucket
});
```

## Post-ship (operate)

- [ ] Telemetry on; run `limitbreak report` weekly.
- [ ] Cache hit rate on repeated-prefix workloads should exceed ~70%; below that, something volatile leaked into the prefix.
- [ ] `droppedContextTokens` persistently high → your retrieval is over-fetching; fix upstream rather than raising the budget.
- [ ] Keep a small eval set per task; re-run when moving a task down a tier. Quality is measured, not assumed.
