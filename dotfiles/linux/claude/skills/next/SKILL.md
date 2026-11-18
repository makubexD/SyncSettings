---
name: next
description: Run the next step of the current plan, keep going through later steps, finish the plan (report, review, merge, roadmap, alert) when none are left, and draft the next phase's plan once it is finished.
argument-hint: "[--force] [plan path]"
disable-model-invocation: true
---

# Run the plan

Arguments from the user: $ARGUMENTS

`--force` only matters to the `context-gate` hook, which has already run; drop it. If a `context-gate:` note says the
context is over the limit, do only what it says and stop. Then run `plan-next --body [plan path]`
from the repo and act on its JSON. Name the plan and step in your first line, e.g. `docs/plan-x.md, step 4: <title>`.
Work from `body`, the step's own text. Read the full plan only when the body refers to other parts of it.

If `gaps` is not empty, name the missing steps in one line (e.g. `gaps: steps 3 and 5 have no commit`), then carry on.

## `state: next`

- **Worker step** (`tag` is null or starts with `worker`): read `~/.claude/skills/mk-delegate/SKILL.md` once, with the
  Read tool (a `cat` comes back cut and costs three re-reads), skip it if it's already in this session, and follow it
  for this step. The effort comes from the tag (`worker:high: reasoning: …` means `high`), and the default is `medium`.
- **`[inline: …]` step**: say in one line that you're working inline and why, quoting the tag, then do the step yourself.
- After the step is accepted and committed with its trailers, run `plan-next --body` again and carry on with the next
  step without asking. Stop only where **Stops** below says to: a rejection or failure, a classifier denial,
  a review finding you can't settle, or the end of a phase.
- If a hook adds a line telling you to stop for `/clear`, commit the step you just accepted (if it isn't already),
  send a push notification, and stop with one line: `/clear, then /next`. If no steps are left, ignore it and finish.

## `state: done`

Finish the plan, in this order. Start the finish only under the 200k `/clear` gate; at or over it, push-notify and stop
with `/clear, then /next`, so a fresh session runs the whole finish. Once started, it may run up to 250k tokens of
context; over that, push-notify and stop with `/clear, then /next`.

1. Run `workflow-report .` and note anything wrong it shows: errors, rework, steps done inline without a reason.
2. Run `/agent-skills:review` on the whole feature. Fix its findings on the same branch, in one round only. If you
   can't settle a finding, alert the user and stop.
3. Run the repo's full test suite once. A failure is a finding: fix it on the branch, or alert the user and stop.
4. Mark the phase done in the roadmap (`docs/plan-<topic>.md`) if there is one, and update the project memory with
   what's done and what comes next. Delete finished plan files only if the roadmap or the repo's rules say so.
   Commit this with a `Plan-Done: <plan path>` trailer (above `Route: unplanned`), so `plan-next` reports `finished`.
5. **No PR** (the work is committed on the default branch, as in `~/.claude`): skip to step 8.
6. Push the branch and open the PR if there isn't one. If the repo has a `review-gate` workflow, add the `reviewed`
   label, but only after the review covered the final commit: `gh pr edit <n> --add-label reviewed`.
7. Wait for checks with `gh pr checks <n> --watch` in the background, then run `pr-ready <n>`.
   - Exit 0: merge with `gh pr merge <n> --merge --delete-branch`, written as one plain command.
   - Exit 1: send the reasons and the PR link, and stop. Don't merge, and don't try another route.
8. Send a push notification: the plan finished, plus the PR or merge result. Reply in a few lines.

## `state: finished`

- **An open PR for the current branch** (`gh pr view --json number,state`): resume the finish at its step 7 (checks,
  `pr-ready`, merge), then step 8.
- **Otherwise, draft what comes next.** Find the roadmap: `docs/plan-<topic>.md` for a finished
  `docs/plan-<topic>-<phase>.md`, else the project memory's "next". Write the next phase's step-level plan as
  `docs/plan-<topic>-<phase>.md` (flow step 2 in `CLAUDE.md`), run the repo's formatter and `plan-next --check` on it,
  commit it (`docs: plan <feature>`, `Route: unplanned`), push-notify, and stop with one line:
  `Review docs/plan-<x>.md, then /next`.
- **Nothing left** in the roadmap or memory: say so in one line.

## `state: none`

Say that no plan was found in this repo's history, and ask for a plan path (`/next docs/plan-<feature>.md`).

## Any plan you write

After writing or editing a plan file: the repo's formatter, `plan-next --check`, then commit it at once. Never leave a
plan uncommitted at a stop: after `/clear` an uncommitted plan is invisible to `/next`.

## Review and stops

- **Review** each step: `git diff`, rerun the step's test command and lint on the changed files, check the scope; show
  the evidence when asked. The full suite runs once, in the finish. Each worker step goes through `/mk-delegate`,
  limited to that step's files.
- **Accept and commit**, then send the next step without asking: the committed plan is the approval.
- **Stops**: a rejection or failure (exit 75, 124, max turns), a classifier denial, or the end of the phase or plan.
  Reject with a concrete reason and resend once; after two rejections, do the step in the main session. After a
  `medium` rejection for wrong logic (not a bad spec), resend once at `high` with `--why escalation`. After a
  timeout, split the step and send the pieces at `medium`, even under a `high` tag.
- **Context gate**: the `context-gate` hook adds its line after a worker notification or a plan-step commit when the
  context is at or over 200k, or 70% of the model's window when that's smaller (auto-compact comes at about 83%).
  Then commit the step, push-notify and stop with "/clear, then /next". Over 200k a typed `/next` is blocked before
  any model turn (with Remote Control on, where a block shows only in the local terminal, it gets a one-line reply
  and a push notification instead); `/next --force` skips the gate. The status line shows `CLEAR` at the same size.
- After the finish, `/clear` before the next plan.

## Commit trailers

`Plan-Step` is the plan path relative to the repo root, plus `#<step>`. `Route` takes one value: `worker:<effort>`
with the effort `mk-exec` ran at, `inline:<reason>` with the reason from the step's tag or the one-line notice before
working inline, or `unplanned`. A commit covering several steps carries one `Plan-Step` line per step. The finish
commit (roadmap and memory, before the PR) adds `Plan-Done: <plan path>` above `Route: unplanned`.

## mk-exec internals

- How it runs: Bash with `run_in_background: true`, `mk-exec --effort <level> <repo> '<spec>'`; wait for the
  notification and read only the summary. No subagent is involved, so a step costs only the summary and the review.
  Delegate only a written plan step or exact spec, in a git repo with a clean tree. Exit codes: 0 review; 75 key,
  balance or rate problem (stop and report, no retry); 2 setup (dirty tree, missing key); 124 timeout after 15 min,
  counts as a rejection. `[worker]` means `[worker:medium]`.
- Config: `~/.claude-worker` holds worker rules and permissions, no OAuth credentials, no user hooks or plugins. The
  worker loads the repo's own config (`CLAUDE.md`, `.claude/rules`, skills, agents, commands, project hooks), nothing
  from `~/.claude` and no MCP. A repo whose `.claude/settings.json` sets `ANTHROPIC_*` env or `apiKeyHelper` is
  refused (exit 2), since that could send the key elsewhere. Hooks shared with the main session see `MK_WORKER=1`;
  `worker-mode-guard` lets the worker edit.
- Worktrees: headless Claude Code refuses writes under any `.claude` directory, so a repo there (`~/.claude` itself)
  runs in a temporary worktree in `~/.cache/mk-worktrees/`. So does a repo holding a `.user-values.json` (deny rules
  don't stop an interpreter, and a gitignored file isn't in a worktree). The diff is applied back and the worktree
  removed; it is kept, with a message, if the apply fails.
- Logs: every run writes `~/.claude/state/mk-worker-logs/<ts>-<repo>/` with `stream.jsonl` (full transcript),
  `meta.json` (model, effort, exit, tokens, cost estimate, balance), `diff.patch` and `summary.txt`.
  `workflow-report [repo, default .] [--since DATE]` joins those with the orchestrator transcripts and git log.
- Worker mode: flag `~/.claude/state/worker-mode`, hook `~/.claude/hooks/worker-mode-guard.sh`.
- Commands: `/mk-delegate [--effort L] <task | step N of plan>` runs a task and reviews it; `/mk-check` verifies the
  key, isolation, worker mode and logs with a live test job.
- History: switched from OpenCode + Zen free models on 2026-10-28 after the free quota ran out mid-feature. The old
  setup (`oc-exec`, `mk-worker` agent) is in `~/.claude/attic/`; OpenCode stays installed, unused.
