@RTK.md

# CLAUDE.md

Global guidance for Claude Code on this machine. Claude plans and reviews; subagents and the `mk-exec` worker do
broad, parallel or mechanical work. The orchestrator holds the architecture and interrogates every result.

## Environment

Personal Ubuntu machine, bash. Node comes from nvm (`~/.nvm/versions/node/v24.22.1`), so it is only on PATH in
shells that load nvm. `rtk` 1.1.0 lives in `~/.local/bin`; `jq`, `git` and `python3` are installed.

## Token levers

1. **RTK**: shell output is proxied through `rtk` (hook-driven, see @RTK.md). Don't bypass it with raw commands.
2. **context-mode**: to analyze, filter, count, parse or aggregate data, run code over it in the sandbox
   (`ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`) and print only the answer. Never read a large payload
   into the conversation to compute over it by hand. File writes use Write/Edit. Read files and diffs with Bash
   (RTK trims them) or Read; a `ctx_execute` that only prints a file or diff saves nothing, and a hook denies it.

## Working model

- The main session plans, makes architectural decisions and reviews delegated work.
- Broad searches and independent parallel work go to subagents (Explore, Plan, general-purpose, the agent-skills
  personas). Their results are claims: check correctness, design and assumptions before accepting.
- Reviews of plans and implementations stay on the strongest model. For an independent pass use the repo's installed
  `.claude/agents/*code-reviewer.md` first (and its `*security-auditor.md` when the diff is security-relevant); else `/agent-skills:review`, `code-reviewer`,
  `security-auditor`, or the built-in `/code-review` and `/security-review`.
- Model choice: correctness > design quality > cost; cost is a tie-breaker. Cheaper models for mechanical lookups.
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
- Ask only for: a GO, a review finding you can't settle, a plan-step failure (the stops in `skills/next/SKILL.md`), a
  release or publish, or a classifier denial. On a denial, alert and stop; don't try another route.
- Send a push notification when a plan ends or something needs the user: the `PushNotification` tool, not the
  agent-notify MCP (its `notify` mostly fails with `session_unavailable`).
- Replies: state the result and anything wrong, in a few lines. No recap of the diff or steps.

## Worker: mk-exec

`mk-exec` (`~/.local/bin/mk-exec`) runs mechanical work as a headless `claude -p` on the paid DeepSeek API, config dir
`~/.claude-worker`. The key is in `~/.config/claude-workers/env`; never print it. Never send the worker secrets, `.env`
files or private data: the API is not zero-retention. Run it through `/mk-delegate` (spec, exit codes, review); report
line `⏵ mk-exec (deepseek <model>, <level> effort): <task>`. Its internals, logs and retry rules are in
`skills/next/SKILL.md`. Effort: `--effort low|medium|high`, default **medium** (low = `deepseek-flash`/low,
medium = `deepseek-flash`/high, high = `deepseek-v4-pro`/high).

Execution rule (any main model, `opusplan` included): the main session does not write the code for a mechanical plan
step. It sends the step to `mk-exec` and reviews the result. Inline only for tiny edits, judgment work (design,
debugging, user-facing copy), or after two rejections; say so first in one line with the reason. An untagged, fully
specified step counts as `[worker]`. A test-writing step whose plan lists every case and its result is mechanical:
delegate it, then check that the tests fail for the right reason. Never `[worker]` a step whose result is a model's
own behavior (evals, probes): the worker would measure DeepSeek. It may still write the eval files.

Worker mode (`worker-mode on|off|status`, status line WORKER): a hook denies Edit/Write outside plan files and
`~/.claude`. Don't route around it (no sed -i, heredocs or redirects into project files): send the change to
`mk-exec`, or ask the user to run `! worker-mode off`.

Ban guardrails (Anthropic consumer terms allow subscription OAuth only in Claude Code and Claude.ai):
- Never connect Anthropic or Claude in OpenCode (`/connect`, `opencode-anthropic-auth`) or OmniRoute (`cc/*`,
  `omniroute run claude`).
- Never set `ANTHROPIC_BASE_URL` on the main subscription session. Only the `mk-exec` child gets the DeepSeek
  endpoint and key, with `CLAUDE_CONFIG_DIR=~/.claude-worker`.

## Feature flow

The user's guide: https://claude.ai/artifact/BtM9xvD4igA9B68PeEMzB7 (source `~/.claude/docs/token-routing-map.html`;
edit it and republish to the same URL). Running a plan (`/next`: steps, review, stops, context gate, finish) is in
`skills/next/SKILL.md`.

1. Start clean: `/clear` and a clean git tree (commit or stash first).
2. Write `docs/plan-<feature>.md`: small steps, `## Step N: <title> \`[tag]\``, each with the files, the exact change
   and a targeted test command (its own tests, not the full suite). Tags: `[worker]`, `[worker:<effort>]`,
   `[worker:high: reasoning: <what the spec can't hold>]` (at most one per plan, `--check` enforces it; hard to
   test, CI-only or a big step is no reason: split it), or `[inline: <reason>]`. Escalating to `high` after a
   `medium` rejection happens at run time, never in the plan. Test steps list every case with its expected result. A `[worker]` step is one concern in
   at most about 3 files. Don't implement yet. Commit at once: the repo's formatter (e.g. `npx prettier --write`),
   `plan-next --check <path>`, then `docs: plan <feature>`; an uncommitted plan is invisible to `/next` after
   `/clear`. Multi-phase work: a roadmap `docs/plan-<topic>.md` with phases, then `docs/plan-<topic>-<phase>.md`
   when each phase starts. A plan has at most 20 steps and a `[worker]` step names at most 4 files; `--check` refuses
   more, so split into phases. Plan mode: if the approved plan has `[worker]` steps, write and commit it as above and stop
   for review; don't execute from `~/.claude/plans/`. All steps small and `[inline]`: the approval is the review, go
   ahead. An approval that amends a repo plan is written into that file and committed first.
3. The user reviews and edits the plan (edits committed as `docs: plan <feature> edits`), then `/clear` and `/next`:
   typing `/next` is the GO. `/next <plan>` picks a plan. Unrelated new work starts with `/clear`.

Commit trailers, on every commit in every repo: the last paragraph, before `Co-Authored-By`, no blank line between:

```
Plan-Step: docs/plan-<feature>.md#<n>
Route: worker:<effort> | inline:<reason> | unplanned
```

Commits outside a plan step, plan edits included, get only `Route: unplanned`. Details in `skills/next/SKILL.md`.
