<!-- superpowers-setup managed file. setup-version: 5. Do not edit by hand; re-run /init-project to update. -->
# Process and tracking rules

These rules govern how work is tracked and how it flows from idea to merge. They are project-agnostic. Project-specific rules live in CLAUDE.md above the import of this file.

## Source of truth

GitHub owns status and tracking (Issues, Milestones). This `docs/` tree owns durable content (specs, plans, ADRs). Never write status, checkboxes, or progress counts into `docs/specs/` or `docs/adr/`. "What is left" is answered by the GitHub Milestone view, not a file. Plan checkboxes under `docs/plans/` and `docs/superpowers/plans/` are exempt ephemeral scaffolding. ADRs are immutable: to change a decision, write a new ADR that supersedes the old one, never edit a recorded decision.

## No tracking drift

The work is not done until its issue is closed. An open issue for already-merged work is drift. Every PR body closes its issue(s) with `Closes #N` (or `Fixes #N`); merging is what closes the issue. A PR with no linked issue means the issue is missing, create it first. When work surfaces a follow-up (a newly discovered decision, prerequisite, or recommendation), open the issue on discovery, not at the end, and link it from the work that surfaced it. At phase or milestone close, reconcile the Milestone: every delivered unit is a closed issue, every open issue is genuinely not yet done. No delivered-but-open issues, no orphaned branches. Nothing durable is left in chat history or a markdown note.

## Starting a session

A new session has no memory of prior chats. When the user has not named a task, resolve "what is next" from GitHub, never from chat history or a markdown list. Active milestone is the lowest-numbered Milestone with open Issues. Next task is the top ready Issue in that milestone, preferring higher `priority:*`. List them with `scripts/ready-issues.sh "<active>"`. For a whole-project view — every milestone with its issues bucketed by derived pipeline stage and the next-ready pick per milestone — run `/status` (read-only; `scripts/status.sh` is the emitter it renders). Read the Issue's linked plan, then confirm the pick with the user before doing the work. Readiness is **derived, not a label**: an open Issue is ready when it has no open blockers and is not parked. Record blockers with the native blocked-by relationship via `scripts/issue-deps.sh block <issue> <blocker>` (never a prose "Blocked by #N" line, which drifts) — closing a blocker auto-readies the dependant, no label edit needed. Park work that is not yet scheduled or not yet scoped with `status:backlog` (or `status:deferred` for a later milestone); that is the only thing that holds an unblocked Issue back from ready.

## Hierarchy for large projects

A Milestone is a phase. Within a phase, an Epic issue (`type:feature`) is the native sub-issue parent of its Task issues (`type:task`), which gives an automatic progress rollup on the epic. Each task links its plan (`docs/superpowers/plans/...`). This gives three views with no markdown tracking anywhere: phase (the Milestone), epic (the sub-issue rollup), and task (readiness derived from blocked-by dependencies). Manage the tree with `scripts/issue-tree.sh` (add, remove, show).

## Knowledge sources

To answer "how does X work", "why is this the rule", or "where is X defined", route to the right source and cite it, never guess. Project decisions, rules, ADRs, and plan-to-spec links: grep and read `docs/` and `CLAUDE.md`, and cite `file:line`. Upstream library or API behavior: use Context7 or a project docs MCP for version-exact facts, and fall back to the live doc page, never answer from memory. Code structure and symbols: use the graphify code graph at `graphify-out/` only if it exists. Graphs are snapshots: cite `source_file` and edge confidence, and treat INFERRED edges as leads to verify against the live file.

## Workflow and commits

Per unit of work the spine is binding, not narration. When a trigger matches, invoke the named skill before acting:

- Before any new feature, component, or behavior change (before entering plan mode): `brainstorming`.
- You have a spec or requirements for a multi-step task, before touching code: `writing-plans`.
- Implementing any feature or bugfix in business logic: `test-driven-development` (failing test first). Config, scripts, infra, and pure scaffolding are exempt; verify by running instead.
- A plan has 2+ independent tasks (no shared state): `dispatching-parallel-agents`. When an automated orchestrator (e.g. `/work-milestone`) dispatches parallel task agents, worktree isolation comes from the **subagent's `isolation: worktree` frontmatter** — each agent gets its own worktree automatically. For human-driven parallel work, use `using-git-worktrees`. Sequential only when tasks share state. (`worktree.baseRef: "head"` lets subagents see WIP for brainstorming sessions, but the default branches from `origin/HEAD` because `/work-milestone` correctness depends on it.)
- Executing a plan, independent tasks, this session: `subagent-driven-development`.
- Executing a plan in a separate session with checkpoints: `executing-plans`.
- Any bug, test failure, or unexpected behavior, before proposing a fix: `systematic-debugging`.
- About to claim done, fixed, or passing, before any commit or PR: `verification-before-completion` (run the command, show the output).
- Feature complete, or before merge: `requesting-code-review`.
- Receiving review feedback, before implementing it: `receiving-code-review`.
- Phase or milestone close: `finishing-a-development-branch` plus the Milestone reconcile.

Use conventional commits. Every `fix(` commit references an issue. One branch, one owner: sync before you work, push early. Before working an existing branch, fetch and fast-forward; if the remote advanced, rebase onto it before committing. Absorb a remote move with a rebase, not a second merge.

## Long-running runs with /goal

`/goal` is **user-opt-in** and is NOT invoked automatically by any command. When used, it lets a command run unattended to a declared stop condition. Two canonical stop conditions:

- **Unattended planning catch-up:** every open `type:task` issue in milestone \<X\> has a `Plan: docs/superpowers/plans/…` comment, is in `status:backlog`/`deferred`, or is in the failed set — or stop after 30 turns.
- **Unattended wave-loop execution:** every plan-ready issue in milestone \<X\> has a merged PR closing it — or stop after 60 turns.

**Advisor model.** The scaffold sets `advisorModel: "opus"` in `.claude/settings.json` — this makes the Claude Code advisor Opus, not the main model the user runs. The advisor escalates hard judgement calls on top of whatever main model the user chose; the spine rows marked `requesting-code-review` and `verification-before-completion` rely on this escalation. Portability note: `advisorModel` is an Anthropic API feature; it is a harmless no-op on Bedrock, Vertex, and Foundry backends.
