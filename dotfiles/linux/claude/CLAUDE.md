@RTK.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Claude plans and reviews; subagents handle broad or parallel work. The orchestrator holds the
architecture and interrogates every result before accepting it.

## Environment

Personal Ubuntu machine, bash. Node comes from nvm (`~/.nvm/versions/node/v24.22.1`), so it is only
on PATH in shells that load nvm. `rtk` 1.1.0 lives in `~/.local/bin`; `jq`, `git` and `python3` are installed.

## Token levers

Two independent levers. Reach for the cheapest one that fits before spending tokens in the main context.

1. **RTK**: shell/dev command output is proxied through `rtk` for 60-90% token savings. It is hook-driven;
   see @RTK.md. Don't bypass it with raw commands.
2. **context-mode**: to analyze, filter, count, parse, or aggregate data, run code over it in the
   sandbox (`ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`) and surface only the derived
   answer. Never read a large payload into the conversation to compute over it by hand.
   File writes still use the native Write/Edit tools.

## Working model

- The main session does planning, architectural decisions, and review of delegated work.
- Broad searches and independent parallel work go to subagents (Explore, Plan, general-purpose, the
  agent-skills personas). Their results are claims, not facts: check correctness, design, and
  assumptions before accepting.
- Reviews of plans and implementations stay on the strongest model available. For an independent pass use
  the agent-skills review commands (`/agent-skills:review`, `code-reviewer`, `security-auditor`) or the
  built-in `/code-review` and `/security-review`.
- Model choice: correctness > design quality > cost. Cost is a tie-breaker only. Use a cheaper model
  for mechanical or simple lookups; keep judgment work on the stronger one.
- User-facing work (UI, copy, API design) gets the hardest review.

## Effort routing

Default to medium and move deliberately; never pay high effort for mechanical work.

| effort    | use for |
|---        |---      |
| low       | mechanical, clear-spec implementation, formatting, bulk edits/migrations |
| medium    | DEFAULT: routine implementation, searches, straightforward fixes |
| high      | debugging, design, reviews, cross-cutting refactors |
| xhigh/max | adversarial verification, judge panels, gnarly root-cause analysis |

If output misses the bar, raise effort one tier before switching models. Standing permission: do not ask.

## Delegation reports

Every subagent spawn must emit a visible one-line report at spawn time. Never spawn silently.

⏵ <agent-type> (<model>, <effort> effort): <task in ≤10 words>

- `<model>` and `<effort>` are effective values. If inherited, still state them and append
  `inherited`, e.g. `(opus-5.5 inherited, high effort)`.
- Example: `⏵ Explore (sonnet-5.5, medium effort): locate auth middleware call sites`.

Workflow format (per phase, not per agent; a 30-agent fan-out is 2-4 lines):

⏵ Workflow <name>:
  ⏵ <Phase>: <N> agents, <model>, <effort> effort — <what this phase does>

- Use `~N` for dynamic counts. If a phase mixes models/efforts, list the dominant one and note
  exceptions inline. These lines are the greppable audit trail; keep the templates exact.

## Free worker: mk-worker (ACTIVE: OpenCode + free DeepSeek)

Claude plans and reviews; the `mk-worker` subagent (`~/.claude/agents/mk-worker.md`) runs mechanical
work through OpenCode on `opencode/deepseek-v4.1-flash-free`, falling back to `opencode/glm-5.3-flash-free`.
Both are free on OpenCode Zen for a limited time, zero-retention, and need no credentials (verified 2026-10-27).

Feature flow (the user's guide: https://claude.ai/artifact/MXZujhwqjk3N8QUfTiLJsn; source
`~/.claude/docs/token-routing-map.html`, so edit that file and republish it to the same URL):
1. Start clean: `/clear`, confirm a clean git tree (commit or stash first).
2. Write a plan file (`docs/plan-<feature>.md`): small numbered steps, each with the files, the exact change,
   and a test command. Don't implement yet.
3. The user reviews and edits the plan.
4. Send one step at a time to `mk-worker`, limited to that step's files.
5. Review: `git diff`, rerun the tests, check the scope; show the evidence when asked.
6. Accept and commit, then send the next step. Reject with a concrete reason and resend once; after two
   rejections, do the step in the main session.
7. Finish with `/agent-skills:review` of the whole feature, then `/clear` before the next one.

Each spawn costs about 11.7k tokens of plan usage for the Haiku dispatcher (measured 2026-10-27), so do tiny
tasks inline and delegate meaningful mechanical steps.

Execution rule (any main model, including `opusplan` after a plan is approved): the main session does not
write the code for a mechanical plan step itself. It sends that step to `mk-worker` and reviews the result.
It works inline only for tiny edits, judgment work (design, debugging, user-facing copy), or after two
rejections. Before working inline on a planned step, say so in one line with the reason.

Worker mode (`worker-mode on|off|status`, flag `~/.claude/state/worker-mode`, status line shows WORKER): while
it is on, a PreToolUse hook (`~/.claude/hooks/worker-mode-guard.sh`) denies Edit/Write outside plan files and
`~/.claude`. Don't route around it: no writing project files through Bash (sed -i, heredocs, redirects) either.
Send the change to `mk-worker`, or ask the user to run `! worker-mode off`.

Slash commands: `/mk-delegate <task | step N of plan>` hands a task to `mk-worker` and reviews the result;
`/mk-check [--fallback]` verifies the install, the pinned models and worker mode, and runs a live test job.

- Delegate low-effort-tier tasks that already have a written plan or exact spec, in a git repo with a clean tree.
- Review every result: read `git diff`, rerun the tests, and check the scope. Its report is a claim, not a fact.
  After two rejected attempts, do the task in the main session.
- Never send secrets, `.env` files or private data through it, and never point it at other free Zen models,
  which may keep data for training.
- Report line: `⏵ mk-worker (haiku + opencode/deepseek-v4.1-flash-free, low effort): <task>`.
- If Zen ends the free period, enable the paid DeepSeek worker in the dormant section below.

Ban guardrails (Anthropic consumer terms allow subscription OAuth only in Claude Code and Claude.ai):
- Never connect Anthropic or Claude in OpenCode (`/connect`, `opencode-anthropic-auth`) or OmniRoute (`cc/*`,
  `omniroute run claude`).
- Never set `ANTHROPIC_BASE_URL` on the main subscription session. A separate worker process that has its own
  third-party key is fine.

<!--
## External workers (DORMANT: Grok / DeepSeek)

Claude stays the planner, orchestrator and reviewer. Heavy mechanical work (bulk edits, boilerplate,
large migrations, test scaffolding) goes to an external model, and Claude reviews every result
before keeping it.

HOW TO ENABLE: complete the setup steps for ONE scenario below, then move that scenario's
"Rule for Claude" block (and the shared rules) above this comment, outside the <!- - - -> markers.
Restart Claude Code afterwards. Endpoint URLs and model names were current on 2026-10-27, so check them
against the provider docs when you enable a scenario, because providers change them.

### Shared setup (any scenario)
1. mkdir -p ~/.config/claude-workers && touch ~/.config/claude-workers/env && chmod 600 ~/.config/claude-workers/env
2. Put API keys there as `export NAME=value` lines (DEEPSEEK_API_KEY, XAI_API_KEY).

### Shared rules for Claude (copy with any scenario)
- Before delegating, write a precise spec: target files, the change, acceptance criteria, how to verify.
- The worker runs in a git worktree or on a clean tree, so its diff is isolated.
- Review the diff (`git diff`) and run the tests before accepting. Worker output is a claim, not a fact.
- Report every delegation with the same audit-trail format:
  ⏵ delegate-<worker> (<model>): <task in ≤10 words>
- Use the low-effort tier from the routing table. Keep design, debugging and review on Claude.

### Scenario A: DeepSeek as a headless Claude Code worker (closest to native)
DeepSeek has an Anthropic-compatible endpoint, so a second `claude -p` process can run on it
with the same tools and the same CLAUDE.md.
Setup:
1. Create ~/.local/bin/delegate-deepseek (chmod +x):
     #!/usr/bin/env bash
     set -euo pipefail
     source ~/.config/claude-workers/env
     ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
     ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" \
     ANTHROPIC_MODEL=deepseek-chat \
     ANTHROPIC_SMALL_FAST_MODEL=deepseek-chat \
       claude -p "$1" --output-format json --permission-mode acceptEdits
2. Verify: cd into a scratch git repo and run `delegate-deepseek 'create hello.txt containing hi'`.
   The JSON result should report success and hello.txt should exist.
Rule for Claude:
- For low-effort tier tasks, run `delegate-deepseek '<spec>'` via Bash from the target directory,
  then review the diff.

### Scenario B: Grok (xAI) worker
xAI's API is OpenAI-compatible (https://api.x.ai/v1). Before setting this up, check whether xAI
now offers an Anthropic-compatible endpoint. If it does, copy Scenario A with the xAI URL, key and model.
Setup (OpenAI-compatible path):
1. Pick a coding-agent CLI that accepts an OpenAI-compatible base URL (for example opencode or aider),
   install it, and point it at https://api.x.ai/v1 with XAI_API_KEY and a current Grok model.
2. Create ~/.local/bin/delegate-grok (chmod +x) that sources the env file and runs that CLI
   non-interactively with "$1" as the task, in the current directory.
   For one-shot text generation only (no file edits), a curl + jq call to /chat/completions is enough.
3. Verify the same way as Scenario A.
Rule for Claude:
- For low-effort tier tasks, run `delegate-grok '<spec>'` via Bash from the target directory,
  then review the diff.

### Scenario C: Both, routed by task
Setup:
1. Do the setup for A and B.
2. Create ~/.local/bin/delegate (chmod +x) that runs `delegate-$1 "$2"` (worker name first, spec second).
Rule for Claude: pick the worker with this table (adjust it once you know how each model performs):
| task                                          | worker   |
|---                                            |---       |
| code edits, refactors, test scaffolding       | deepseek |
| long-context reading, bulk text/boilerplate   | grok     |
Run `delegate <worker> '<spec>'`, then review the diff as usual.
-->
