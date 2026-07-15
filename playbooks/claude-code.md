# limitbreak — Terminal / Coding-Agent Sessions

Applies to Claude Code and similar CLI agents (Codex CLI, Gemini CLI, Cursor CLI). Usage limits burn on *context tokens processed per turn* — so the levers are context size and turn count. Run the daemon (`limitbreak up` + `limitbreak wrap claude`) so every session is metered, governed, and compressed automatically; the rules below are the human half.

## Session hygiene

- **One task per session thread.** Run `/clear` between unrelated tasks; a 100k-token leftover context is re-read (and billed) on every subsequent turn.
- **Compact at milestones**, not when forced: `/compact` after finishing a subtask keeps the summary you want rather than an emergency one mid-task.
- **Don't paste what the agent can read.** Give a file path instead of file contents — the agent reads only what it needs, and pasted text sits in context forever.
- **Check `limitbreak status` before starting something big.** If you're yellow with 40 minutes of burn left, start the heavy refactor after the window resets.

## Prompting for fewer turns

- **Batch related asks in one message** — each extra round-trip re-processes the whole conversation.
- **Front-load constraints**: target files, style expectations, what NOT to touch, how to verify. Under-specified prompts cause redo loops, the #1 hidden cost.
- **Use plan mode for big tasks.** Rejecting a plan costs hundreds of tokens; rejecting an implementation costs tens of thousands.

## Context protection

- **Delegate wide searches to subagents** — exploration results land in the subagent's context, and only its summary lands in yours.
- **Keep CLAUDE.md lean** (< ~60 lines): it's loaded every session.
- **Allowlist safe commands** in settings so permission round-trips don't add turns.

## Output discipline

- Ask for terse replies; you can read the diff yourself.
- Ask for changes, not explanations, unless you need the explanation.

## Anti-patterns

| Pattern | Why it burns |
| --- | --- |
| Marathon session across many tasks | every turn re-reads the whole history |
| Pasting whole files/logs into the prompt | permanent context weight |
| "Try again" without saying what was wrong | guaranteed second failure |
| Asking the agent to re-explain what it just did | pure output spend, zero progress |
| Frontier model for renames/formatting | wrong tier for the task |
| Starting heavy work at 85% of your window | forced stop mid-task, wasted context |
