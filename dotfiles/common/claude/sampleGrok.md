# CLAUDE.md

The idea: Claude plans and reviews, Grok does the work. Opus holds the architecture and interrogates every result; implementation is delegated to Grok through the `grok-build` plugin. Opus only writes code itself when delegation has failed. This keeps expensive tokens on judgment and cheap tokens on execution.

## Model routing

Rankings: higher is better. Cost is what I actually pay, not list price. Intelligence = unsupervised problem difficulty. Taste = UI/UX, code quality, API design, copy.

| model        | cost | intelligence | taste |
|---           |---   |---           |---    |
| opus-5.0     | 4    | 9            | 9     |
| grok 4.5     | 9    | 8.5          | 7     |

Grok's real strengths are raw speed, execution of tasks, research, and truth-seeking on factual questions, and its intelligence (8.5) is now high enough to own implementation directly. It is the primary executor.

## Orchestration model

opus-5.0 is the orchestrator, not hands. It does ONLY:
- Planning and architectural decisions.
- Reviewing / interrogating the work of delegated subagents.

It does NOT write implementation directly by default. All execution — implementation, refactors, bulk/mechanical edits, migrations, data analysis, heavy lifting — is delegated down the execution ladder:

1. **grok-4.5 first.** Default executor for every implementation task, via `/grok-build:delegate`.
2. **Raise effort or retry on a miss.** If grok's first pass falls short after review, escalate effort one tier and/or re-delegate with a sharper spec before pulling the work back.
3. **opus-5.0 last line of defense.** Only if grok cannot get the work done at high effort does opus-5.0 pick up the implementation itself. This is the exception, not the routine — exhaust delegation first.

The orchestrator's job on every delegated result is to interrogate it (correctness, design, assumptions) before accepting — not to redo it by hand until the ladder is exhausted.

Rules:
- Orchestrators (opus-5.0) plan, decide architecture, and review; they delegate execution rather than implementing. opus-5.0 implements directly only as the last line of defense (step 3).
- Execution ladder: grok-4.5 → grok-4.5 at higher effort → opus-5.0 only if delegation fails.
- Defaults, not limits: if a delegated result misses the bar, escalate (raise effort, then take it back) without asking. Judge output, not price; escalation costs less than mediocre work.
- Cost is only a tie-breaker. For shipped work, intelligence > taste > cost.
- User-facing work (UI, copy, API design): taste >= 7. grok (taste 7) clears the bar, but this is where the orchestrator's review matters most — interrogate its output hard.
- Reviews of plans/implementations: opus-5.0 (the orchestrator). Use `/grok-build:critique` for an independent skeptical pass when a second view is useful.
- Research and factual fact-checking/truth-seeking: grok-4.5.
- Never use Haiku or sonnet-5 — neither model is in rotation at all.

Mechanics:
- Claude models (opus-5.0) run via the Agent/Workflow model parameter.
- grok-4.5 runs through the `grok-build` plugin (`xai-org/grok-build-plugin-cc`), which wraps the Grok Build CLI via a plugin↔Claude Code bridge (runs tracked by PID + log files). Do not write custom bash wrappers; use:
  - `/grok-build:delegate <task>` — PRIMARY execution path, write-capable. Invokes the `grok-build:grok-delegate` subagent. Flags: `--wait` (foreground) / `--background` (detached; records bridgePid + agentPid), `--model <id>` (omit to use the grok-4.5 default; only pin a model when you have a specific reason), `--effort <low|medium|high>`, `--resume` / `--fresh` (continue or start a fresh thread; skips the resume prompt). Defaults to foreground; prefer `--background` for long or open-ended work.
  - `/grok-build:review` — Read-only review of local git state; supports `--base <ref>` for branch analysis, `--scope auto|working-tree|branch`, `--model`, `--effort`. No trailing focus text.
  - `/grok-build:critique` — Skeptical design-challenge pass (questions the approach, assumptions, tradeoffs — not just implementation defects); same target selection as review, but accepts trailing focus text.
  - `/grok-build:runs` / `/grok-build:show [run-id]` / `/grok-build:stop [run-id]` — List, inspect, and stop background runs. Background runs are tracked (PID + log files), not fire-and-forget.
  - `/grok-build:check` — Verify Grok Build CLI install/auth.

Workflow/subagent delegation:
- Use the plugin's `grok-build:grok-delegate-runtime` skill (`grok-bridge.mjs`) or spawn the `grok-build:grok-delegate` subagent; never call `grok` directly.
- Delegation sends prompts and any read code to xAI's backend. Standard external-service caveat: do not delegate anything you would not send to a third-party cloud service.

## Effort routing

Effort is a second cost lever, independent of model. Default to medium and move deliberately; never pay high effort for mechanical work.

| effort    | use for |
|---        |---      |
| low       | mechanical, clear-spec implementation, formatting, bulk edits/migrations |
| medium    | DEFAULT — routine implementation, searches, straightforward fixes |
| high      | debugging, design, reviews, cross-cutting refactors |
| xhigh/max | adversarial verification, judge panels, gnarly root-cause analysis |

Rules:
- If output misses the bar, escalate the cheaper lever first: raise effort one tier for insufficient thinking; pull the task back to opus-5.0 only if the model seems out of depth at high effort. Standing permission — do not ask.
- Pair levers: execution/bulk work = grok-4.5 at the rubric-chosen tier; planning/review by opus-5.0 high. For judgment tasks, smart model at low effort often beats cheap model at high effort.

Where effort is settable:
- Workflow `agent()` calls: pass `effort: low|medium|high|xhigh|max` per call. This is the main place the rubric applies.
- Agent tool: no per-call effort; it inherits session/agent definition. If one-off effort control matters, accept the inherited tier or wrap it in a single-agent workflow.
- `/grok-build:delegate`, `/grok-build:review`, `/grok-build:critique`: all accept `--effort`, and the grok-build scale is `low|medium|high` only (narrower than the rubric). Map rubric `low`→`low`, `medium`→`medium`, and `high`/`xhigh`/`max`→`high`. Always pass the rubric-chosen tier; this is the standing instruction to set it.

## Delegation reports

Every delegation (Agent tool, Workflow, grok-build plugin) must emit a visible one-line report at spawn time. Never spawn silently.

Single agent format:

⏵ &lt;agent-type&gt; (&lt;model&gt;, &lt;effort&gt; effort): &lt;task in ≤10 words&gt;

- `<model>` and `<effort>` are effective values. If omitted and inherited, still state them and append `inherited`, e.g. `(opus-5.0 inherited, high effort)`.
- Grok example: `⏵ grok (grok-4.5, medium effort): implement lead-scoring migration`. Model is `grok-4.5` unless `--model` pins something else. Effort is the `/grok-build:delegate|review|critique --effort` value (`low|medium|high`).

Workflow format (per phase, not per agent; a 30-agent fan-out should be 2-4 lines):

⏵ Workflow &lt;name&gt;:
  ⏵ &lt;Phase&gt;: &lt;N&gt; agents, &lt;model&gt;, &lt;effort&gt; effort — &lt;what this phase does&gt;

- Use `~N` for dynamic counts (loop-until-dry, budget loops).
- If a phase mixes models/efforts, list the dominant one and note exceptions inline.
- These lines are the greppable audit trail; keep the templates exact.

