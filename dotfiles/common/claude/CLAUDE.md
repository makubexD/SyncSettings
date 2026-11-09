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
   File writes still use the native Write/Edit tools. Read files and diffs you need to see with Bash (RTK trims
   them); `ctx_execute` that just prints a file or diff skips RTK and saves nothing.

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

## Running without asking

- Don't ask before git or command operations. A GO on a plan covers its pushes and PRs.
- Merge without asking only when `pr-ready <n>` exits 0, for a PR from an approved plan or a feature tested before it
  was sent. Otherwise tell the user why, with the link. Never `--admin`, never force-push.
- The `reviewed` label goes on only after a real review of the final commit.
- Ask only for: a GO, a review finding you can't settle, a failure from flow step 6, a release or publish, or a
  classifier denial. On a denial, alert and stop; don't try another route.
- Send a push notification when a plan ends or something needs the user.
- Replies: state the result and anything wrong, in a few lines. No recap of the diff or steps.

## Worker: mk-exec (ACTIVE: headless Claude Code on paid DeepSeek)

Claude plans and reviews; `mk-exec` (`~/.local/bin/mk-exec`) runs mechanical work as a separate `claude -p`
process on the paid DeepSeek API, with its own config dir `~/.claude-worker` (worker rules, permissions, no
OAuth credentials, no user hooks or plugins). The key is in `~/.config/claude-workers/env`; never print it.
It loads the repo's own config like a normal session: `CLAUDE.md`, `.claude/rules`, skills, agents, commands and
project hooks, but nothing from `~/.claude` and no MCP. A repo whose `.claude/settings.json` sets `ANTHROPIC_*` env
or `apiKeyHelper` is refused (exit 2), since that could send the key elsewhere. Hooks shared with the main
session see `MK_WORKER=1`; `worker-mode-guard` lets the worker edit. Headless Claude Code refuses writes under
any `.claude` directory, so a repo there (`~/.claude` itself) runs in a temporary worktree in `~/.cache/mk-worktrees/`.
So does a repo holding a `.user-values.json`, because deny rules don't stop an interpreter and a gitignored file isn't in
a worktree. The diff is applied back to the repo and the worktree removed (kept, with a message, if the apply fails).
Switched from OpenCode + Zen free models on 2026-10-28 after the free quota ran out mid-feature.

Effort: `mk-exec --effort low|medium|high` (default **medium**). low = `deepseek-flash`/low,
medium = `deepseek-flash`/high, high = `deepseek-v4-pro`/high. Pick per step; a plan step may say `[worker:<level>]`.
`[worker:medium]` is the default. A plan may tag `high` only with its reason, as `[worker:high: <reason>]`, for a step
that is hard to specify exactly. A step isn't `high` for being big: split it. After a medium rejection for wrong logic,
not a bad spec, resend once at `high`. After a timeout, split the step and don't resend at `high`.

Feature flow (the user's guide: https://claude.ai/artifact/BtM9xvD4igA9B68PeEMzB7; source
`~/.claude/docs/token-routing-map.html`, so edit that file and republish it to the same URL):
1. Start clean: `/clear`, confirm a clean git tree (commit or stash first).
2. Write a plan file (`docs/plan-<feature>.md`): small numbered steps (`## Step N: <title> \`[tag]\``), each with
   the files, the exact change, and a targeted test command (the step's own tests, not the full suite). Tag each step `[worker]`, `[worker:<effort>]` or `[inline: <reason>]`; test steps list
   every case with its expected result. A `[worker]` step is one concern touching at most about 3 files; split
   bigger ones. Don't implement yet. Commit the plan the moment it's written: the repo's formatter if it has one
   (e.g. `npx prettier --write`), `plan-next --check <path>`, then `docs: plan <feature>` with `Route: unplanned`.
   An uncommitted plan is invisible to `/next` after `/clear`. Plan mode (any model, `opusplan` included): if the
   approved plan has `[worker]` steps, write and commit it as `docs/plan-<feature>.md` and stop for review in that
   turn; don't execute from `~/.claude/plans/`. If every step is small and `[inline]`, the approval is the review: go
   ahead. An approval that amends a repo plan (new or changed steps, review follow-ups) writes the amendment into that
   plan file and commits it first, so it survives `/clear`.
   Multi-phase work (several PRs, or phases gated on research): commit the roadmap as `docs/plan-<topic>.md`
   with phases, not steps, then write a step-level `docs/plan-<topic>-<phase>.md` when each phase starts.
3. The user reviews and edits the plan, tags included; review edits are committed the same way
   (`docs: plan <feature> edits`). Then `/clear` and `/next`: typing `/next` on the plan is the GO.
   `/next` (`skills/next/SKILL.md`) finds the plan and step from git with `plan-next --body` and keeps going through
   the steps.
   `/next <plan>` picks a plan. Unrelated new work still starts with `/clear`.
4. Each worker step goes through the `/mk-delegate` procedure, limited to that step's files.
5. Review: `git diff`, rerun the step's test command and lint on the changed files, check the scope; show the
   evidence when asked. The full suite runs once, in the finish.
6. Accept and commit, then send the next step without asking: the committed plan is the approval. Stop and ask
   only at a rejection or failure (exit 75, 124, max turns), a classifier denial, or the end of the phase or plan.
   Reject with a concrete reason and resend once; after two rejections, do the step in the main session. Also stop
   when the `context-gate` hook adds its line (context at or over 200k, or 70% of the model's window when that's smaller, since auto-compact comes at about
   83%; after a worker notification or a plan-step
   commit): commit the step, send a push notification, and stop with "/clear, then /next". Over 200k a typed `/next`
   is blocked before any model turn (with Remote Control on, where a block shows only in the local terminal, it gets a
   one-line reply and a push notification instead); `/next --force` skips the gate, and the status line shows `CLEAR` at the same size.
7. When no steps are left, `/next` finishes the plan in the same session if it starts under the 200k gate (then
   cap 250k; over the gate at the start it stops for `/clear`, then `/next`):
   `workflow-report .`, `/agent-skills:review` of the whole feature with one round of fixes, the full test suite,
   the roadmap and memory commit with `Plan-Done`, then the PR, `pr-ready` and the merge, and a push notification.
   On a `finished` plan, `/next` resumes an open PR, or drafts and commits the roadmap's next phase plan and stops
   for review. Then `/clear` before the next one.

Commit trailers: the main session adds them to every commit, in every repo. They go in the message's last paragraph,
before `Co-Authored-By`, with no blank line between them, so git reads them as one trailer block:

```
Plan-Step: docs/plan-<feature>.md#<n>
Route: worker:<effort> | inline:<reason> | unplanned
```

`Plan-Step` is the plan path relative to the repo root, plus the step number. `Route` is one value: `worker:<effort>`
with the effort `mk-exec` ran at, or `inline:<reason>` with the reason from the step's tag or the one-line notice before
working inline. Commits outside a plan step, plan edits included, get only `Route: unplanned`. A commit covering
several steps carries one `Plan-Step` line per step. The finish commit (roadmap and memory, before the PR) adds
`Plan-Done: <plan path>` above `Route: unplanned`, so `plan-next` reports `finished`.

Execution rule (any main model, including `opusplan` after a plan is approved): the main session does not
write the code for a mechanical plan step itself. It sends that step to `mk-exec` and reviews the result.
It works inline only for tiny edits, judgment work (design, debugging, user-facing copy), or after two
rejections. Before working inline on a planned step, say so in one line with the reason. Follow the plan's
tags; an untagged step that is fully specified counts as `[worker]`. A test-writing step is mechanical when the
plan lists every case with its expected result: delegate it, then check that the tests fail for the right
reason. Keep it inline only when the cases still need design. Never tag `[worker]` a step whose result is a
model's own behavior (evals, probes, "what does the model get wrong"): the worker is DeepSeek, so it would
measure DeepSeek. Run those with the model under test; the worker may still write the eval files.

How to run it: Bash with `run_in_background: true`, `mk-exec --effort <level> <repo> '<spec>'`, then wait for
the notification and read only its summary (≤40 lines). No subagent is involved, so a step costs only the
summary and the review. Exit codes: 0 review; 75 key/balance/rate problem, stop and report, no retry;
2 setup (dirty tree, missing key); 124 timeout after 15 min, counts as a rejection.

Logs: every run writes `~/.claude/state/mk-worker-logs/<ts>-<repo>/` with `stream.jsonl` (full transcript),
`meta.json` (model, effort, exit, tokens, cost estimate, balance), `diff.patch` and `summary.txt`.
`workflow-report [repo path, default .] [--since DATE]` joins those with the orchestrator transcripts and git log.

Worker mode (`worker-mode on|off|status`, flag `~/.claude/state/worker-mode`, status line shows WORKER): while
it is on, a PreToolUse hook (`~/.claude/hooks/worker-mode-guard.sh`) denies Edit/Write outside plan files and
`~/.claude`. Don't route around it: no writing project files through Bash (sed -i, heredocs, redirects) either.
Send the change to `mk-exec`, or ask the user to run `! worker-mode off`.

Slash commands: `/mk-delegate [--effort L] <task | step N of plan>` runs a task through `mk-exec` and reviews
the result; `/mk-check` verifies the key, isolation, worker mode and logs with a live test job.

- Delegate tasks that already have a written plan or exact spec, in a git repo with a clean tree.
- Review every result: read `git diff`, rerun the tests, and check the scope. Its summary is a claim, not a fact.
- Never send secrets, `.env` files or private data: the paid DeepSeek API is not zero-retention.
- Report line: `⏵ mk-exec (deepseek <model>, <level> effort): <task>`.
- The old OpenCode setup (`oc-exec`, `mk-worker` agent) is in `~/.claude/attic/`; OpenCode stays installed, unused.

Ban guardrails (Anthropic consumer terms allow subscription OAuth only in Claude Code and Claude.ai):
- Never connect Anthropic or Claude in OpenCode (`/connect`, `opencode-anthropic-auth`) or OmniRoute (`cc/*`,
  `omniroute run claude`).
- Never set `ANTHROPIC_BASE_URL` on the main subscription session. Only the `mk-exec` child process gets the
  DeepSeek endpoint and key, with `CLAUDE_CONFIG_DIR=~/.claude-worker`.
