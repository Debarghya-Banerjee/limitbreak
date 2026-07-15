# limitbreak — Desktop & Web Chat Apps

Applies to Claude Desktop/claude.ai, ChatGPT, Gemini, and similar GUIs. You can't hook these programmatically — the framework here is usage patterns. Limits burn on total tokens processed per turn, and every turn re-reads the whole conversation.

## Conversation lifecycle

- **New chat per topic.** Long mixed-topic chats make every new question pay for all the old ones — and quality drops as stale context competes with your actual question.
- **Restart when the chat drifts.** If you've corrected the model twice on the same point, start fresh with a better first message; the failed attempts are now permanent context poisoning the thread.
- **Use Projects / custom instructions / GEMs** for context you'd otherwise paste repeatedly (your stack, your conventions, your role). Stated once in the right place, it's cached and consistent.

## The first message is the whole game

- Front-load everything: goal, constraints, format wanted, what you already tried, what to avoid. One complete message beats five clarifying rounds — each round replays the entire thread.
- Paste the *relevant excerpt*, not the whole document. If the app supports file attachments, attach instead of pasting — some apps index attachments instead of re-reading them each turn.

## Output contracts

Tell the model the shape you want, every time it matters:

- "Answer in a table, no prose."
- "Give me the changed lines only, not the full file."
- "Max 5 bullets."
- "No summary at the end."

Verbose output isn't just cost — it's the context weight every later turn re-reads.

## Model pickers

Most desktop apps expose a model selector. The habit that preserves limits: cheap/fast model by default, escalate the *specific message* that needs deep reasoning, then drop back down. Same routing principle as the API — done by hand.

## Anti-patterns

| Pattern | Why it burns |
| --- | --- |
| One eternal chat for everything | every turn pays for the whole history |
| Re-pasting the same context each session | should live in a Project/custom instruction |
| "Continue" / "tell me more" fishing | unconstrained output spend |
| Arguing with a derailed thread | poisoned context; restart instead |
| Frontier model for lookups and rewording | wrong tier for the task |
